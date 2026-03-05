import { DatabaseManager, Trade } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { RestClientV5 } from 'bybit-api';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';
import type { CTraderClient } from '../clients/ctraderClient.js';

/** Order types that are linked to a position and must be cancelled when position closes */
const POSITION_LINKED_ORDER_TYPES = ['stop_loss', 'take_profit', 'breakeven_limit'] as const;

/** Max concurrent API/DB operations to avoid connection limits */
const CANCELLATION_CHUNK_SIZE = 20;

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function extractPositionIdFromOrder(o: { positionId?: unknown; position_id?: unknown }): string | undefined {
  const raw = o.positionId ?? o.position_id;
  if (raw == null) return undefined;
  const num = protobufLongToNumber(raw);
  return num != null ? String(num) : String(raw);
}

/**
 * Cancel all pending TP/SL/breakeven orders for a cTrader trade.
 * cTrader does not auto-cancel these when the position closes, so we must cancel them
 * to avoid orphaned orders that could execute and open unintended positions.
 *
 * Also reconciles with exchange: fetches open orders by positionId and cancels any
 * linked to our position, including orders we never persisted to DB.
 */
export async function cancelCTraderPendingOrders(
  trade: Trade,
  db: DatabaseManager,
  ctraderClient: CTraderClient
): Promise<void> {
  const orders = await db.getOrdersByTradeId(trade.id);
  const pendingToCancel = orders.filter(
    o => o.status === 'pending' &&
         o.order_id &&
         (POSITION_LINKED_ORDER_TYPES as readonly string[]).includes(o.order_type)
  );

  const orderIdsToCancel = new Set<string>(pendingToCancel.map(o => String(o.order_id!)));

  let openOrders: { orderId?: unknown; id?: unknown; positionId?: unknown; position_id?: unknown }[] = [];
  try {
    openOrders = await ctraderClient.getOpenOrders();
    // Reconcile: add orders on exchange linked to our position that we never saved to DB
    if (trade.position_id) {
      for (const o of openOrders) {
        const orderPositionId = extractPositionIdFromOrder(o);
        if (orderPositionId === trade.position_id) {
          const oid = o.orderId ?? o.id;
          const orderIdStr = oid != null ? String(oid) : '';
          if (orderIdStr) orderIdsToCancel.add(orderIdStr);
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to fetch exchange orders for reconciliation (will cancel DB orders only)', {
      tradeId: trade.id,
      positionId: trade.position_id,
      error: error instanceof Error ? error.message : String(error),
      exchange: 'ctrader'
    });
  }

  const openOrderIds = new Set(
    openOrders.map(o => {
      const oid = o.orderId ?? o.id;
      return oid != null ? String(oid) : '';
    }).filter(Boolean)
  );

  const dbOrderByExchangeId = new Map(pendingToCancel.map(o => [String(o.order_id!), o]));

  const toUpdateOnly = [...orderIdsToCancel].filter(id => !openOrderIds.has(id));
  const toCancel = [...orderIdsToCancel].filter(id => openOrderIds.has(id));

  for (const batch of chunk(toUpdateOnly, CANCELLATION_CHUNK_SIZE)) {
    await Promise.all(
      batch.map(async (orderId) => {
        const dbOrder = dbOrderByExchangeId.get(orderId);
        if (dbOrder) {
          await db.updateOrder(dbOrder.id, { status: 'cancelled' });
          logger.debug('Marked cTrader order cancelled in DB (already gone on exchange)', {
            tradeId: trade.id,
            orderId,
            exchange: 'ctrader'
          });
        }
      })
    );
  }

  const cancelResults: { orderId: string; success: boolean; error?: unknown }[] = [];
  for (const batch of chunk(toCancel, CANCELLATION_CHUNK_SIZE)) {
    const batchResults = await Promise.all(
      batch.map(async (orderId) => {
        try {
          await ctraderClient.cancelOrder(orderId);
          return { orderId, success: true as const };
        } catch (err) {
          return { orderId, success: false as const, error: err };
        }
      })
    );
    cancelResults.push(...batchResults);
  }

  for (const result of cancelResults) {
    const { orderId, success } = result;
    const dbOrder = dbOrderByExchangeId.get(orderId);
    if (success) {
      if (dbOrder) await db.updateOrder(dbOrder.id, { status: 'cancelled' });
      logger.info('Cancelled cTrader order linked to position', {
        tradeId: trade.id,
        orderId,
        orderType: dbOrder?.order_type,
        positionId: trade.position_id,
        fromDb: !!dbOrder,
        exchange: 'ctrader'
      });
    } else {
      const err = result.error;
      logger.warn('Failed to cancel cTrader order (may already be closed)', {
        tradeId: trade.id,
        orderId,
        error: err instanceof Error ? err.message : String(err),
        exchange: 'ctrader'
      });
    }
  }
}

/**
 * Helper function to close a position
 */
export async function closePosition(
  trade: Trade,
  db: DatabaseManager,
  isSimulation: boolean,
  bybitClient?: RestClientV5,
  ctraderClient?: CTraderClient
): Promise<void> {
  if (isSimulation) {
    // In simulation, just mark as closed
    await db.updateTrade(trade.id, {
      status: 'closed',
      exit_filled_at: dayjs().toISOString()
    });
    logger.info('Simulated position close', {
      tradeId: trade.id,
      tradingPair: trade.trading_pair
    });
  } else if (trade.exchange === 'ctrader' && ctraderClient && trade.position_id) {
    try {
      // Cancel TP/SL/breakeven orders first - cTrader does not auto-cancel them when position closes
      await cancelCTraderPendingOrders(trade, db, ctraderClient);
      await ctraderClient.closePosition(trade.position_id);
      logger.info('Position closed on cTrader', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        positionId: trade.position_id
      });
      await db.updateTrade(trade.id, {
        status: 'closed',
        exit_filled_at: dayjs().toISOString()
      });
    } catch (error) {
      logger.error('Failed to close cTrader position', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        positionId: trade.position_id,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  } else if (trade.exchange === 'bybit' && bybitClient && trade.position_id) {
    const symbol = trade.trading_pair.replace('/', '');
    
    // Get current position info
    const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });

    if (positions.retCode === 0 && positions.result && positions.result.list) {
      const position = positions.result.list.find((p: any) => {
        const positionIdx = getBybitField<string | number>(p, 'positionIdx', 'position_idx');
        return p.symbol === symbol && positionIdx?.toString() === trade.position_id;
      });

      const positionSize = getBybitField<string>(position, 'size');
      if (position && parseFloat(positionSize || '0') !== 0) {
        // Close the position by placing an opposite order
        const side = position.side === 'Buy' ? 'Sell' : 'Buy';
        const qty = parseFloat(positionSize || '0');

        const closeOrder = await bybitClient.submitOrder({
          category: 'linear',
          symbol: symbol,
          side: side,
          orderType: 'Market',
          qty: qty.toString(),
          timeInForce: 'IOC',
          reduceOnly: true,
          closeOnTrigger: false,
          positionIdx: parseInt(trade.position_id || '0') as 0 | 1 | 2
        });

        if (closeOrder.retCode === 0 && closeOrder.result) {
          logger.info('Position closed on exchange', {
            tradeId: trade.id,
            tradingPair: trade.trading_pair,
            orderId: getBybitField<string>(closeOrder.result, 'orderId', 'order_id') || 'unknown'
          });

          // Update trade status - the monitor will detect the closure and update with PNL
          await db.updateTrade(trade.id, {
            status: 'closed',
            exit_filled_at: dayjs().toISOString()
          });
        } else {
          throw new Error(`Failed to close position: ${JSON.stringify(closeOrder)}`);
        }
      } else {
        // Position already closed
        await db.updateTrade(trade.id, {
          status: 'closed',
          exit_filled_at: dayjs().toISOString()
        });
      }
    }
  }
}

