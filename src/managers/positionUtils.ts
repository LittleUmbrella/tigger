import { DatabaseManager, Trade } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { RestClientV5 } from 'bybit-api';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import type { CTraderClient } from '../clients/ctraderClient.js';

/** Order types that are linked to a position and must be cancelled when position closes */
const POSITION_LINKED_ORDER_TYPES = ['stop_loss', 'take_profit', 'breakeven_limit'] as const;

/**
 * Cancel all pending TP/SL/breakeven orders for a cTrader trade.
 * cTrader does not auto-cancel these when the position closes, so we must cancel them
 * to avoid orphaned orders that could execute and open unintended positions.
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

  for (const order of pendingToCancel) {
    try {
      await ctraderClient.cancelOrder(order.order_id!);
      await db.updateOrder(order.id, { status: 'cancelled' });
      logger.info('Cancelled cTrader order linked to position', {
        tradeId: trade.id,
        orderId: order.order_id,
        orderType: order.order_type,
        positionId: trade.position_id,
        exchange: 'ctrader'
      });
    } catch (error) {
      // Order may already be cancelled/filled on exchange; log and continue
      logger.warn('Failed to cancel cTrader order (may already be closed)', {
        tradeId: trade.id,
        orderId: order.order_id,
        orderType: order.order_type,
        error: error instanceof Error ? error.message : String(error),
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

