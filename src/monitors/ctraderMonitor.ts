import { MonitorConfig } from '../types/config.js';
import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { CTraderClient } from '../clients/ctraderClient.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { roundPrice, roundQuantity, distributeQuantityAcrossTPs, validateAndRedistributeTPQuantities } from '../utils/positionSizing.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';
import {
  getIsLong,
  checkTradeExpired,
  updateEntryOrderToFilled,
  checkStopLossHit,
  checkTPHitBeforeEntry,
  checkSLHitBeforeEntry,
  calculatePNLPercentage,
  countFilledTakeProfits,
  getBreakevenLimitOrder,
  updateOrderToFilled,
  updateTradeOnPositionClosed,
  updateTradeOnStopLossHit,
  updateTradeOnBreakevenFilled,
  cancelTrade,
  sleep,
  MONITOR_TRADE_TIMEOUT_MS,
  TP_PLACEMENT_TIMEOUT_MS
} from './shared.js';
import { normalizeCTraderSymbol } from '../utils/ctraderSymbolUtils.js';
import { cancelCTraderPendingOrders } from '../managers/positionUtils.js';

/** Per-account tracking: positionId -> firstSeenAt (ms) for orphan grace period */
const orphanFirstSeenByAccount = new Map<string, Map<string, number>>();
/** Last orphan check per account (ms) - throttle to every 5 min */
const lastOrphanCheckByAccount = new Map<string, number>();
const ORPHAN_CHECK_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Check for orphan cTrader positions (no matching trade) and close them after grace period.
 * Only runs when closeOrphanPositions is enabled. Scoped per account.
 */
const checkAndCloseOrphanPositions = async (
  db: DatabaseManager,
  getCTraderClient: (accountName?: string) => Promise<CTraderClient | undefined>,
  closeOrphanPositions: boolean,
  graceMinutes: number
): Promise<void> => {
  if (!closeOrphanPositions) return;

  const ourTrades = (await db.getActiveTrades()).filter(t => t.exchange === 'ctrader');
  if (ourTrades.length === 0) return; // No active trades - skip to avoid closing manual positions

  const byAccount = new Map<string, Trade[]>();
  for (const t of ourTrades) {
    const acc = t.account_name ?? 'ctrader_demo';
    if (!byAccount.has(acc)) byAccount.set(acc, []);
    byAccount.get(acc)!.push(t);
  }

  const graceMs = graceMinutes * 60 * 1000;
  const now = Date.now();

  for (const [accountName, trades] of byAccount) {
    if (now - (lastOrphanCheckByAccount.get(accountName) ?? 0) < ORPHAN_CHECK_THROTTLE_MS) continue;
    lastOrphanCheckByAccount.set(accountName, now);

    const ourPositionIds = new Set(
      trades
        .map(t => t.position_id)
        .filter((id): id is string => id != null && id !== '')
    );

    const client = await getCTraderClient(accountName);
    if (!client) continue;

    try {
      const positions = await client.getOpenPositions();
      const candidates = orphanFirstSeenByAccount.get(accountName) ?? new Map();
      let sawNewOrphans = false;

      for (const p of positions) {
        const posId = typeof p.positionId === 'object' && p.positionId?.low != null
          ? String(protobufLongToNumber(p.positionId) ?? '')
          : String(p.positionId ?? p.id ?? '');
        if (!posId) continue;
        if (ourPositionIds.has(posId)) {
          candidates.delete(posId);
          continue;
        }

        const firstSeen = candidates.get(posId) ?? now;
        if (!candidates.has(posId)) {
          candidates.set(posId, firstSeen);
          sawNewOrphans = true;
        }

        if (now - firstSeen < graceMs) continue;

        const symbol = p.symbolName ?? p.symbol ?? '?';
        const vol = p.volume ?? p.quantity ?? 0;
        logger.info('Closing orphan cTrader position (no matching trade)', {
          positionId: posId,
          symbol,
          volume: vol,
          accountName,
          exchange: 'ctrader'
        });
        try {
          await client.closePosition(posId);
          candidates.delete(posId);
        } catch (err) {
          logger.warn('Failed to close orphan position', {
            positionId: posId,
            error: err instanceof Error ? err.message : String(err),
            exchange: 'ctrader'
          });
        }
      }

      if (sawNewOrphans || candidates.size > 0) {
        orphanFirstSeenByAccount.set(accountName, candidates);
      }
    } catch (err) {
      logger.warn('Orphan position check failed', {
        accountName,
        error: err instanceof Error ? err.message : String(err),
        exchange: 'ctrader'
      });
    }
  }
};

/**
 * Get current price from cTrader
 */
const getCurrentPrice = async (
  tradingPair: string,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<number | null> => {
  try {
    if (isSimulation && priceProvider) {
      const price = priceProvider.getCurrentPrice(tradingPair);
      if (price === null) {
        logger.warn('No historical price data available', {
          tradingPair,
          exchange: 'ctrader'
        });
      }
      return price;
    } else if (ctraderClient) {
      const symbol = normalizeCTraderSymbol(tradingPair);
      const price = await ctraderClient.getCurrentPrice(symbol);
      if (price !== null) {
        logger.debug('Got current price from cTrader', {
          tradingPair,
          symbol,
          price,
          exchange: 'ctrader'
        });
        return price;
      }
    }
    return null;
  } catch (error) {
    logger.error('Error getting current price from cTrader', {
      tradingPair,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

/**
 * Check if entry order is filled for cTrader
 * Implements advanced order querying with multiple fallback strategies (Gap #5)
 */
const checkEntryFilled = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider
): Promise<{ filled: boolean; positionId?: string; filledAt?: string }> => {
  try {
    if (isSimulation) {
      if (priceProvider) {
        const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
        if (currentPrice !== null) {
          const isLong = currentPrice >= trade.entry_price;
          const tolerance = trade.entry_price * 0.001;
          const filled = Math.abs(currentPrice - trade.entry_price) <= tolerance || 
                 (isLong && currentPrice > trade.entry_price) ||
                 (!isLong && currentPrice < trade.entry_price);
          if (filled) {
            return { filled: true, positionId: `SIM-${trade.id}` };
          }
        }
      }
      return { filled: false };
    } else if (ctraderClient) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      logger.info('Checking cTrader entry fill status', {
        tradeId: trade.id,
        symbol,
        orderId: trade.order_id,
        channel: trade.channel,
        exchange: 'ctrader'
      });
      
      // Strategy 1: Check positions first (most reliable indicator)
      let positions: any[] = [];
      const maxRetries = 3;
      const retryDelay = 1000;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          positions = await ctraderClient.getOpenPositions();
          logger.info('cTrader positions received', {
            tradeId: trade.id,
            symbol,
            positionsCount: positions.length,
            channel: trade.channel,
            exchange: 'ctrader'
          });
          
          if (positions.length >= 0) {
            break; // Got response, exit retry loop
          }
        } catch (error) {
          logger.debug('Error getting positions, retrying', {
            tradeId: trade.id,
            symbol,
            attempt,
            maxRetries,
            error: error instanceof Error ? error.message : String(error)
          });
          
          if (attempt < maxRetries) {
            await sleep(retryDelay);
          }
        }
      }
      
      const position = positions.find((p: any) => {
        const positionSymbol = p.symbolName || p.symbol;
        const volume = Math.abs(p.volume || p.quantity || 0);
        const matches = positionSymbol === symbol && volume > 0;
        
        logger.debug('Checking position match', {
          tradeId: trade.id,
          positionSymbol,
          expectedSymbol: symbol,
          volume,
          matches
        });
        
        return matches;
      });
      
      if (position) {
        const positionId = position.positionId || position.id;
        const openTs = position.tradeData?.openTimestamp ?? position.openTimestamp;
        const tsMs = protobufLongToNumber(openTs);
        const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
        logger.info('Found open cTrader position for trade, entry likely filled', {
          tradeId: trade.id,
          symbol,
          positionId: positionId?.toString(),
          volume: position.volume || position.quantity,
          orderId: trade.order_id,
          exchange: 'ctrader'
        });
        return { filled: true, positionId: positionId?.toString(), filledAt };
      }
      
      // Strategy 2: Check open orders by orderId
      if (trade.order_id) {
        logger.info('Checking cTrader open orders', {
          tradeId: trade.id,
          symbol,
          orderId: trade.order_id,
          channel: trade.channel,
          exchange: 'ctrader'
        });
        
        try {
          const openOrders = await ctraderClient.getOpenOrders();
          logger.info('cTrader open orders received', {
            tradeId: trade.id,
            symbol,
            openOrdersCount: openOrders.length,
            channel: trade.channel,
            exchange: 'ctrader'
          });
          
          const order = openOrders.find((o: any) => {
            const oId = o.orderId || o.id;
            const matches = oId?.toString() === trade.order_id;
            
            logger.debug('Checking order match', {
              tradeId: trade.id,
              orderId: oId?.toString(),
              expectedOrderId: trade.order_id,
              matches
            });
            
            return matches;
          });
          
          if (!order) {
            // Order not in open orders - might be filled
            logger.debug('cTrader order not found in open orders, checking positions again', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              exchange: 'ctrader'
            });
            
            // Strategy 3: Re-check positions (position might have been created after initial check)
            const positionsAgain = await ctraderClient.getOpenPositions();
            const positionAgain = positionsAgain.find((p: any) => {
              const positionSymbol = p.symbolName || p.symbol;
              const volume = Math.abs(p.volume || p.quantity || 0);
              return positionSymbol === symbol && volume > 0;
            });
            
            if (positionAgain) {
              const posId = positionAgain.positionId || positionAgain.id;
              const openTs = positionAgain.tradeData?.openTimestamp ?? positionAgain.openTimestamp;
              const tsMs = protobufLongToNumber(openTs);
              const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
              logger.info('Found position on re-check after order not found', {
                tradeId: trade.id,
                symbol,
                positionId: posId?.toString(),
                exchange: 'ctrader'
              });
              return { filled: true, positionId: posId?.toString(), filledAt };
            }
            
            // Order filled but position closed already (edge case)
            logger.debug('Order not found and no position - assuming filled but position closed', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              exchange: 'ctrader'
            });
            return { filled: true };
          } else {
            // Order still open - check status
            const orderStatus = order.orderStatus || order.status;
            logger.debug('cTrader order found in open orders', {
              tradeId: trade.id,
              symbol,
              orderId: trade.order_id,
              orderStatus,
              exchange: 'ctrader'
            });
            
            if (orderStatus === 'FILLED' || orderStatus === 'PARTIALLY_FILLED') {
              const positionId = order.positionId || order.id;
              const updTs = order.utcLastUpdateTimestamp ?? order.tradeData?.openTimestamp;
              const tsMs = protobufLongToNumber(updTs);
              const filledAt = tsMs != null && tsMs > 0 ? new Date(tsMs).toISOString() : undefined;
              logger.info('Order status indicates filled', {
                tradeId: trade.id,
                symbol,
                orderId: trade.order_id,
                orderStatus,
                positionId: positionId?.toString(),
                exchange: 'ctrader'
              });
              return { filled: true, positionId: positionId?.toString(), filledAt };
            }
          }
        } catch (error) {
          logger.debug('Error checking cTrader orders', {
            tradeId: trade.id,
            symbol,
            orderId: trade.order_id,
            error: error instanceof Error ? error.message : String(error),
            exchange: 'ctrader'
          });
        }
      } else {
        logger.debug('No order ID available, checking positions only', {
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
      }
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking cTrader entry filled', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error),
      exchange: 'ctrader'
    });
    return { filled: false };
  }
};

/** Extract positionId from an order (handles protobuf Long) */
const extractPositionIdFromOrder = (o: any): string | undefined => {
  const raw = o.positionId ?? o.position_id;
  if (raw == null) return undefined;
  const num = protobufLongToNumber(raw);
  return num != null ? String(num) : String(raw);
};

/**
 * Check if position is closed for cTrader
 * Implements retry logic and detailed logging (Gaps #4, #6)
 * When position_id is missing, derives it from our pending orders on the exchange - detects orphans
 */
const checkPositionClosed = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider,
  db?: DatabaseManager
): Promise<{ closed: boolean; exitPrice?: number; pnl?: number }> => {
  try {
    logger.debug('Checking if cTrader position is closed', {
      tradeId: trade.id,
      positionId: trade.position_id,
      symbol: trade.trading_pair,
      exchange: 'ctrader'
    });

    if (isSimulation && priceProvider && trade.entry_filled_at) {
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
        logger.debug('No current price available in simulation', {
          tradeId: trade.id,
          exchange: 'ctrader'
        });
        return { closed: false };
      }

      const takeProfits = JSON.parse(trade.take_profits) as number[];
      const isLong = currentPrice > trade.entry_price;
      
      const stopLossHit = isLong
        ? currentPrice <= trade.stop_loss
        : currentPrice >= trade.stop_loss;
      
      let tpHit = false;
      let hitTP = 0;
      for (const tp of takeProfits) {
        const tpHitCheck = isLong ? currentPrice >= tp : currentPrice <= tp;
        if (tpHitCheck) {
          tpHit = true;
          hitTP = tp;
          break;
        }
      }

      logger.debug('Simulation position close check', {
        tradeId: trade.id,
        isLong,
        currentPrice,
        stopLoss: trade.stop_loss,
        stopLossHit,
        takeProfits,
        tpHit,
        hitTP,
        exchange: 'ctrader'
      });

      if (stopLossHit || tpHit) {
        const exitPrice = currentPrice;
        const priceDiff = exitPrice - trade.entry_price;
        const pnl = isLong ? priceDiff : -priceDiff;
        const positionSize = (trade.entry_price * (trade.risk_percentage / 100)) / Math.abs(priceDiff / trade.entry_price);
        const actualPnl = (pnl / trade.entry_price) * positionSize * trade.leverage;
        
        logger.info('Position closed in simulation', {
          tradeId: trade.id,
          exitPrice,
          pnl: actualPnl,
          stopLossHit,
          tpHit,
          hitTP,
          exchange: 'ctrader'
        });
        
        return {
          closed: true,
          exitPrice,
          pnl: actualPnl
        };
      }
      
      return { closed: false };
    } else if (ctraderClient && trade.position_id) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      logger.info('Checking if cTrader position closed', {
        tradeId: trade.id,
        symbol,
        positionId: trade.position_id,
        channel: trade.channel,
        exchange: 'ctrader'
      });
      
      // Get positions with retry logic (Gap #4)
      let positions: any[] = [];
      const maxRetries = 3;
      const retryDelay = 1000;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          positions = await ctraderClient.getOpenPositions();
          
          logger.info('cTrader positions received for close check', {
            tradeId: trade.id,
            symbol,
            positionId: trade.position_id,
            positionsCount: positions.length,
            channel: trade.channel,
            exchange: 'ctrader'
          });
          
          if (positions.length >= 0) {
            break; // Got response, exit retry loop
          }
        } catch (error) {
          logger.debug('Error getting positions for close check, retrying', {
            tradeId: trade.id,
            symbol,
            attempt,
            maxRetries,
            error: error instanceof Error ? error.message : String(error),
            exchange: 'ctrader'
          });
          
          if (attempt < maxRetries) {
            await sleep(retryDelay);
          }
        }
      }
      
      const position = positions.find((p: any) => {
        const positionId = p.positionId || p.id;
        const positionSymbol = p.symbolName || p.symbol;
        const matches = positionSymbol === symbol && positionId?.toString() === trade.position_id;
        
        logger.debug('Checking position match for close check', {
          tradeId: trade.id,
          positionId: positionId?.toString(),
          expectedPositionId: trade.position_id,
          positionSymbol,
          expectedSymbol: symbol,
          matches,
          volume: p.volume || p.quantity,
          exchange: 'ctrader'
        });
        
        return matches;
      });
      
      // If position doesn't exist or volume is 0, it's closed
      if (!position || Math.abs(position.volume || position.quantity || 0) === 0) {
        logger.info('cTrader position closed', {
          tradeId: trade.id,
          symbol,
          positionId: trade.position_id,
          foundPosition: !!position,
          positionVolume: position ? (position.volume || position.quantity) : 0,
          exchange: 'ctrader',
          note: 'Position not found or volume is zero - position is closed'
        });
        // Try to get closed position info from deal history or similar
        // cTrader API might have a way to get closed positions
        // For now, return closed without exit price/PNL
        return { closed: true };
      } else {
        logger.debug('Position still open', {
          tradeId: trade.id,
          symbol,
          positionId: trade.position_id,
          volume: position.volume || position.quantity,
          exchange: 'ctrader'
        });
      }
    } else if (ctraderClient && !trade.position_id && db && trade.entry_filled_at) {
      // Fallback: derive position from our pending orders on exchange - detects orphans when position_id was never set
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      const pendingOrders = await db.getOrdersByTradeId(trade.id);
      const pendingWithOrderId = pendingOrders.filter(o => o.status === 'pending' && o.order_id);
      if (pendingWithOrderId.length === 0) return { closed: false };

      const [openOrders, positions] = await Promise.all([
        ctraderClient.getOpenOrders(),
        ctraderClient.getOpenPositions()
      ]);
      const ourOrderIds = new Set(pendingWithOrderId.map(o => String(o.order_id)));
      const matchingExchangeOrders = openOrders.filter((o: any) => {
        const oid = String(o.orderId ?? o.id ?? '');
        return ourOrderIds.has(oid);
      });
      if (matchingExchangeOrders.length === 0) return { closed: false }; // Our orders not on exchange (filled/cancelled)

      const positionIds = new Set<string>();
      for (const o of matchingExchangeOrders) {
        const pid = extractPositionIdFromOrder(o);
        if (pid) positionIds.add(pid);
      }
      if (positionIds.size === 0) return { closed: false };

      const openPositionIds = new Set(
        positions.map((p: any) => {
          const id = p.positionId ?? p.id;
          return id != null ? String(protobufLongToNumber(id) ?? id) : '';
        }).filter(Boolean)
      );
      const ourPositionsExist = [...positionIds].some(pid => openPositionIds.has(pid));
      if (!ourPositionsExist) {
        logger.info('cTrader position closed (derived from orphaned orders)', {
          tradeId: trade.id,
          symbol,
          derivedPositionIds: [...positionIds],
          note: 'Our orders on exchange but their positions closed - cTrader does not auto-cancel',
          exchange: 'ctrader'
        });
        return { closed: true };
      }
      // Persist learned position_id for future runs
      const firstPosId = [...positionIds][0];
      await db.updateTrade(trade.id, { position_id: firstPosId });
      trade.position_id = firstPosId;
    } else {
      logger.debug('Cannot check position close - missing client or position ID', {
        tradeId: trade.id,
        hasClient: !!ctraderClient,
        hasPositionId: !!trade.position_id,
        exchange: 'ctrader'
      });
    }
    return { closed: false };
  } catch (error) {
    logger.error('Error checking cTrader position closed', {
      tradeId: trade.id,
      positionId: trade.position_id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      exchange: 'ctrader'
    });
    return { closed: false };
  }
};

/**
 * Cancel order for cTrader
 */
const cancelOrder = async (
  trade: Trade,
  ctraderClient?: CTraderClient
): Promise<void> => {
  try {
    if (ctraderClient && trade.order_id) {
      await ctraderClient.cancelOrder(trade.order_id);
      logger.info('cTrader order cancelled', {
        tradeId: trade.id,
        orderId: trade.order_id,
        channel: trade.channel,
        messageId: trade.message_id,
        symbol: trade.trading_pair,
        exchange: 'ctrader'
      });
    }
  } catch (error) {
    logger.error('Error cancelling cTrader order', {
      tradeId: trade.id,
      exchange: 'ctrader',
      orderId: trade.order_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

/**
 * Check if order is filled for cTrader
 * Implements advanced order querying with detailed logging (Gaps #5, #6)
 * @param openOrders - Optional pre-fetched open orders to avoid repeated reconcile calls (each getOpenOrders = full ProtoOAReconcileReq)
 */
const checkOrderFilled = async (
  order: Order,
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider?: HistoricalPriceProvider,
  openOrders?: any[]
): Promise<{ filled: boolean; filledPrice?: number }> => {
  try {
    // Position TP marker is on the position, not a separate order - fill is detected when position closes
    if (order.order_id === 'ctrader_position_tp') {
      return { filled: false };
    }

    logger.debug('Checking if cTrader order is filled', {
      orderId: order.id,
      orderType: order.order_type,
      orderPrice: order.price,
      tradeId: trade.id,
      symbol: trade.trading_pair,
      exchange: 'ctrader'
    });

    if (isSimulation && priceProvider) {
      const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
      if (currentPrice === null) {
        logger.debug('No current price available in simulation', {
          orderId: order.id,
          tradeId: trade.id,
          exchange: 'ctrader'
        });
        return { filled: false };
      }

      const isLong = currentPrice > trade.entry_price;
      let filled = false;

      if (order.order_type === 'stop_loss') {
        filled = isLong
          ? currentPrice <= order.price
          : currentPrice >= order.price;
        logger.debug('Simulation SL fill check', {
          orderId: order.id,
          tradeId: trade.id,
          isLong,
          currentPrice,
          slPrice: order.price,
          filled,
          exchange: 'ctrader'
        });
      } else if (order.order_type === 'take_profit' || order.order_type === 'breakeven_limit') {
        filled = isLong
          ? currentPrice >= order.price
          : currentPrice <= order.price;
        logger.debug('Simulation TP/BE fill check', {
          orderId: order.id,
          tradeId: trade.id,
          isLong,
          currentPrice,
          orderPrice: order.price,
          filled,
          exchange: 'ctrader'
        });
      }

      if (filled) {
        logger.info('Order filled in simulation', {
          orderId: order.id,
          orderType: order.order_type,
          tradeId: trade.id,
          filledPrice: currentPrice,
          exchange: 'ctrader'
        });
        return { filled: true, filledPrice: currentPrice };
      }
      return { filled: false };
    } else if (ctraderClient && order.order_id) {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      
      // Use pre-fetched open orders when provided to avoid N reconcile calls per trade
      let ordersToCheck = openOrders;
      if (ordersToCheck === undefined) {
        logger.debug('Querying cTrader open orders', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        ordersToCheck = await ctraderClient.getOpenOrders();
      }
      
      logger.debug('Open orders retrieved', {
        orderId: order.id,
        tradeId: trade.id,
        symbol,
        openOrdersCount: ordersToCheck.length,
        exchange: 'ctrader'
      });
      
      const foundOrder = ordersToCheck.find((o: any) => {
        const oId = o.orderId || o.id;
        const matches = oId?.toString() === order.order_id;
        
        logger.debug('Checking order match', {
          orderId: order.id,
          storedOrderId: order.order_id,
          foundOrderId: oId?.toString(),
          matches,
          exchange: 'ctrader'
        });
        
        return matches;
      });
      
      if (!foundOrder) {
        // Order not in open orders, likely filled
        logger.info('Order not found in open orders - likely filled', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        return { filled: true, filledPrice: order.price };
      } else {
        const orderStatus = foundOrder.orderStatus || foundOrder.status;
        logger.debug('Order found in open orders', {
          orderId: order.id,
          orderType: order.order_type,
          storedOrderId: order.order_id,
          orderStatus,
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
        
        if (orderStatus === 'FILLED') {
          const filledPrice = foundOrder.filledPrice || foundOrder.executionPrice || order.price;
          const finalPrice = typeof filledPrice === 'number' ? filledPrice : parseFloat(filledPrice || order.price.toString());
          
          logger.info('Order status indicates filled', {
            orderId: order.id,
            orderType: order.order_type,
            storedOrderId: order.order_id,
            orderStatus,
            filledPrice: finalPrice,
            tradeId: trade.id,
            symbol,
            exchange: 'ctrader'
          });
          
          return { filled: true, filledPrice: finalPrice };
        } else {
          logger.debug('Order still pending', {
            orderId: order.id,
            orderType: order.order_type,
            storedOrderId: order.order_id,
            orderStatus,
            tradeId: trade.id,
            exchange: 'ctrader'
          });
        }
      }
    } else {
      logger.debug('Cannot check order fill - missing client or order ID', {
        orderId: order.id,
        tradeId: trade.id,
        hasClient: !!ctraderClient,
        hasOrderId: !!order.order_id,
        exchange: 'ctrader'
      });
    }
    return { filled: false };
  } catch (error) {
    logger.error('Error checking cTrader order filled', {
      orderId: order.id,
      orderType: order.order_type,
      tradeId: trade.id,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return { filled: false };
  }
};

/**
 * Place take profit orders for cTrader
 * Implements position size validation and precision handling (Gaps #2, #3)
 */
const placeTakeProfitOrders = async (
  trade: Trade,
  ctraderClient: CTraderClient | undefined,
  db: DatabaseManager
): Promise<void> => {
  try {
    if (!trade.entry_filled_at) {
      logger.debug('Entry not filled yet, skipping TP order placement', {
        tradeId: trade.id,
        exchange: 'ctrader'
      });
      return;
    }

    const takeProfits = JSON.parse(trade.take_profits) as number[];
    if (!takeProfits || takeProfits.length === 0) {
      logger.debug('No take profits configured', {
        tradeId: trade.id,
        exchange: 'ctrader'
      });
      return;
    }

    // Check if TP orders already exist. Best TP is set on position (not in DB); non-best TPs are limit orders.
    // Skip when we have all non-best limit orders (n-1 for n TPs), or all TPs for single-TP case.
    let existingOrders = await db.getOrdersByTradeId(trade.id);
    const existingTPOrders = existingOrders.filter(o => o.order_type === 'take_profit');
    const nonBestCount = Math.max(0, takeProfits.length - 1);
    if (takeProfits.length === 1) {
      // Single TP: set on position only; no DB orders. Skip only if position already has TP (we can't verify).
      // We don't skip - always run to set SL and best TP on position (idempotent).
    } else if (existingTPOrders.length >= nonBestCount) {
      logger.debug('All non-best take profit orders already exist for cTrader trade, skipping placement', {
        tradeId: trade.id,
        existingTPCount: existingTPOrders.length,
        nonBestCount,
        expectedTPCount: takeProfits.length,
        exchange: 'ctrader'
      });
      return;
    }

    // Only proceed if we have a cTrader client and exchange is cTrader (for real exchange orders)
    if (!ctraderClient || trade.exchange !== 'ctrader') {
      logger.debug('Skipping take profit order placement - no cTrader client or not cTrader exchange', {
        tradeId: trade.id,
        exchange: trade.exchange,
        hasCTraderClient: !!ctraderClient
      });
      return;
    }

    const symbol = normalizeCTraderSymbol(trade.trading_pair);
    
    logger.info('Placing cTrader take profit orders', {
      tradeId: trade.id,
      symbol,
      tpCount: takeProfits.length,
      takeProfits,
      channel: trade.channel,
      exchange: 'ctrader'
    });
    
    // Get position info with retry logic (Gap #4)
    let position: any = null;
    let positionResponse: any[] = [];
    const maxRetries = 3;
    const retryDelay = 1000; // 1 second
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        positionResponse = await ctraderClient.getOpenPositions();
        
        logger.info('cTrader positions received for TP placement', {
          tradeId: trade.id,
          symbol,
          positionsCount: positionResponse.length,
          channel: trade.channel,
          exchange: 'ctrader'
        });

        // Resolve position by position_id or order_id (order_id → deal → positionId avoids wrong position when multiple per symbol)
        if (trade.position_id) {
          position = positionResponse.find((p: any) => {
            const positionId = p.positionId || p.id;
            const positionSymbol = p.symbolName || p.symbol;
            return positionSymbol === symbol && positionId?.toString() === trade.position_id;
          });
        }
        if (!position && trade.order_id) {
          const fillTime = trade.entry_filled_at || trade.created_at;
          const fromTs = fillTime ? new Date(fillTime).getTime() - 60000 : undefined;
          const resolvedPositionId = await ctraderClient.getPositionIdByEntryOrderId(
            trade.order_id,
            fromTs,
            Date.now()
          );
          if (resolvedPositionId) {
            position = positionResponse.find((p: any) =>
              String(p.positionId ?? p.id) === String(resolvedPositionId)
            );
          }
        }
        if (!position) {
          const positions = positionResponse.filter((p: any) => {
            const positionSymbol = p.symbolName || p.symbol;
            const volume = Math.abs(p.volume || p.quantity || 0);
            return positionSymbol === symbol && volume > 0;
          });
          if (positions.length > 0) {
            position = positions[0];
          }
        }
        
        if (position) {
          logger.debug('Position found', {
            tradeId: trade.id,
            symbol,
            positionId: (position.positionId || position.id)?.toString(),
            volume: position.volume || position.quantity,
            attempt,
            exchange: 'ctrader'
          });
          break; // Found position, exit retry loop
        }
      } catch (error) {
        logger.debug('Error getting positions, retrying', {
          tradeId: trade.id,
          symbol,
          attempt,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
          exchange: 'ctrader'
        });
      }
      
      // If this wasn't the last attempt, wait before retrying
      if (attempt < maxRetries && !position) {
        logger.debug('Position not found yet, retrying', {
          tradeId: trade.id,
          symbol,
          attempt,
          maxRetries,
          exchange: 'ctrader'
        });
        await sleep(retryDelay);
      }
    }

    if (!position) {
      logger.warn('No cTrader position found for TP order placement after retries', {
        tradeId: trade.id,
        symbol,
        positionId: trade.position_id,
        attempts: maxRetries,
        exchange: 'ctrader'
      });
      return;
    }

    const positionId = position.positionId || position.id;
    const positionVolume = Math.abs(position.volume || position.quantity || 0);
    
    // Determine position side
    let positionSide: 'BUY' | 'SELL';
    if (position.tradeSide && (position.tradeSide === 'BUY' || position.tradeSide === 'SELL')) {
      positionSide = position.tradeSide as 'BUY' | 'SELL';
    } else if (position.side && (position.side === 'BUY' || position.side === 'SELL')) {
      positionSide = position.side as 'BUY' | 'SELL';
    } else {
      // Fallback: infer from volume (positive = long/BUY, negative = short/SELL)
      positionSide = positionVolume > 0 ? 'BUY' : 'SELL';
      logger.debug('Position side not available, inferred from volume', {
        tradeId: trade.id,
        inferredSide: positionSide,
        positionVolume,
        exchange: 'ctrader'
      });
    }
    const expectedPositionSide = trade.direction === 'long' ? 'BUY' : 'SELL';
    if (positionSide !== expectedPositionSide) {
      logger.error('Position side mismatch, using expected side for TP orders', {
        tradeId: trade.id,
        symbol,
        expectedPositionSide,
        actualPositionSide: positionSide,
        note: 'TP side derived from trade.direction to avoid increasing position',
        exchange: 'ctrader'
      });
    }
    const effectivePositionSide = positionSide === expectedPositionSide ? positionSide : expectedPositionSide;

    // TP side is always opposite of position side
    // For Long (Buy) position, TP is Sell
    // For Short (Sell) position, TP is Buy
    const tpSide = effectivePositionSide === 'BUY' ? 'SELL' : 'BUY';

    // Set stop loss on position early for faster protection (later modifyPosition will reset it with best TP)
    if (trade.stop_loss != null) {
      try {
        await ctraderClient.modifyPosition({
          positionId: positionId?.toString() || '',
          stopLoss: trade.stop_loss
        });
        logger.info('cTrader stop loss set on position', {
          tradeId: trade.id,
          symbol,
          stopLoss: trade.stop_loss,
          positionId: positionId?.toString(),
          exchange: 'ctrader'
        });
      } catch (error) {
        logger.warn('Failed to set stop loss on cTrader position', {
          tradeId: trade.id,
          symbol,
          stopLoss: trade.stop_loss,
          channel: trade.channel,
          exchange: 'ctrader',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Get symbol info for precision (Gap #3) - needed before we can compute best TP and validTPOrders
    logger.debug('Getting symbol info for precision', {
      tradeId: trade.id,
      symbol,
      exchange: 'ctrader'
    });
    
    let symbolInfo: any;
    try {
      symbolInfo = await ctraderClient.getSymbolInfo(symbol);
      logger.debug('Symbol info retrieved', {
        tradeId: trade.id,
        symbol,
        symbolInfo: {
          symbolId: symbolInfo.symbolId,
          symbolName: symbolInfo.symbolName,
          digits: symbolInfo.digits,
          pipSize: symbolInfo.pipSize
        },
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.warn('Failed to get symbol info, using defaults', {
        tradeId: trade.id,
        symbol,
        channel: trade.channel,
        exchange: 'ctrader',
        error: error instanceof Error ? error.message : String(error)
      });
      symbolInfo = {};
    }

    // Extract precision and volume limits from symbol info
    // cTrader: ProtoOASymbol returns int64 as Long objects; normalize to number
    const pricePrecision = symbolInfo.digits !== undefined ? symbolInfo.digits : 5;
    const quantityPrecision = symbolInfo.volumePrecision !== undefined ? symbolInfo.volumePrecision : 2;
    const lotSize = protobufLongToNumber(symbolInfo.lotSize) ?? 100;
    const minOrderVolume = protobufLongToNumber(symbolInfo.minVolume) ?? protobufLongToNumber(symbolInfo.minLotSize) ?? 0;
    const maxOrderVolume = protobufLongToNumber(symbolInfo.maxVolume) ?? protobufLongToNumber(symbolInfo.maxLotSize);
    const volumeStep = protobufLongToNumber(symbolInfo.volumeStep) ?? protobufLongToNumber(symbolInfo.stepVolume) ?? protobufLongToNumber(symbolInfo.lotSize) ?? Math.pow(10, -quantityPrecision);

    logger.debug('Precision and limits extracted', {
      tradeId: trade.id,
      symbol,
      pricePrecision,
      quantityPrecision,
      minOrderVolume,
      maxOrderVolume,
      volumeStep,
      exchange: 'ctrader'
    });

    // Round TP prices (Gap #3)
    const roundedTPPrices = takeProfits.map(tpPrice => 
      roundPrice(tpPrice, pricePrecision, undefined)
    );

    logger.debug('TP prices rounded', {
      tradeId: trade.id,
      symbol,
      originalTPs: takeProfits,
      roundedTPs: roundedTPPrices,
      exchange: 'ctrader'
    });

    // Distribute quantity across TPs (Gap #2)
    const tpQuantities = distributeQuantityAcrossTPs(
      positionVolume,
      takeProfits.length,
      quantityPrecision
    );

    logger.debug('TP quantities distributed', {
      tradeId: trade.id,
      symbol,
      positionVolume,
      numTPs: takeProfits.length,
      tpQuantities,
      exchange: 'ctrader'
    });

    // Validate and redistribute TP quantities (Gap #2)
    const validTPOrders = validateAndRedistributeTPQuantities(
      tpQuantities,
      roundedTPPrices,
      positionVolume,
      volumeStep,
      minOrderVolume,
      maxOrderVolume,
      quantityPrecision
    );
    
    logger.info('TP orders validated and redistributed', {
      tradeId: trade.id,
      symbol,
      originalTPCount: takeProfits.length,
      validTPCount: validTPOrders.length,
      skippedTPCount: takeProfits.length - validTPOrders.length,
      validTPOrders: validTPOrders.map(tp => ({
        index: tp.index,
        price: tp.price,
        quantity: tp.quantity
      })),
      exchange: 'ctrader'
    });

    // Log that last TP uses remaining quantity
    if (validTPOrders.length > 0) {
      const lastTP = validTPOrders[validTPOrders.length - 1];
      const allocatedQty = validTPOrders.slice(0, -1).reduce((sum, tp) => sum + tp.quantity, 0);
      const remainingQty = positionVolume - allocatedQty;
      logger.info('Last TP order uses remaining quantity to close entire position', {
        tradeId: trade.id,
        symbol,
        lastTPIndex: lastTP.index,
        lastTPQuantity: lastTP.quantity,
        remainingQuantity: remainingQty,
        totalPositionQty: positionVolume,
        allocatedQty,
        exchange: 'ctrader',
        note: 'cTrader will automatically adjust last TP quantity to match available position size when executing'
      });
    }

    // Log redistribution if fewer TPs than expected
    if (validTPOrders.length < takeProfits.length) {
      const skippedCount = takeProfits.length - validTPOrders.length;
      const skippedIndices: number[] = [];
      for (let i = 0; i < takeProfits.length; i++) {
        if (!validTPOrders.find(tp => tp.index === i + 1)) {
          skippedIndices.push(i + 1);
        }
      }
      logger.warn('Some TP orders were skipped due to quantity validation', {
        tradeId: trade.id,
        symbol,
        skippedCount,
        skippedIndices,
        reason: 'Quantity too small after rounding or below minimum order volume',
        exchange: 'ctrader'
      });
    }

    // Best TP = last/furthest TP - set on position via modifyPosition (closes remainder when hit).
    // Monitor replaces SL and TP on position so they are always correct (handles initiator values or limit-order fills).
    const bestTpOrder = validTPOrders.find(tp => tp.index === takeProfits.length);
    const bestTpPrice = bestTpOrder?.price ?? roundedTPPrices[roundedTPPrices.length - 1];
    
    try {
      const modifyPayload: { positionId: string; stopLoss?: number; takeProfit?: number } = {
        positionId: positionId?.toString() || ''
      };
      if (trade.stop_loss != null) {
        modifyPayload.stopLoss = trade.stop_loss;
      }
      if (bestTpPrice != null && bestTpPrice > 0) {
        modifyPayload.takeProfit = bestTpPrice;
      }
      if (modifyPayload.stopLoss != null || modifyPayload.takeProfit != null) {
        await ctraderClient.modifyPosition(modifyPayload);
        logger.info('cTrader position SL and best TP set via modifyPosition', {
          tradeId: trade.id,
          symbol,
          stopLoss: modifyPayload.stopLoss,
          bestTpPrice: modifyPayload.takeProfit,
          positionId: positionId?.toString(),
          exchange: 'ctrader'
        });
      }
    } catch (error) {
      logger.warn('Failed to set stop loss or best TP on cTrader position', {
        tradeId: trade.id,
        symbol,
        stopLoss: trade.stop_loss,
        bestTpPrice,
        channel: trade.channel,
        exchange: 'ctrader',
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // When validation consolidated to only the best TP (all non-best rounded to 0), insert a marker
    // so the retry logic knows we're done and stops retrying every poll.
    if (validTPOrders.length === 1 && validTPOrders[0].index === takeProfits.length) {
      const existingPositionTp = existingTPOrders.find((o) => o.order_id === 'ctrader_position_tp');
      if (!existingPositionTp) {
        await db.insertOrder({
          trade_id: trade.id,
          order_type: 'take_profit',
          order_id: 'ctrader_position_tp',
          price: bestTpPrice,
          quantity: positionVolume / lotSize,
          tp_index: takeProfits.length,
          status: 'pending'
        });
        logger.info('Inserted position TP marker - validation consolidated all TPs to best (on position)', {
          tradeId: trade.id,
          symbol,
          exchange: 'ctrader'
        });
      }
    }

    // Place limit orders only for non-best TPs (indices 1..n-1). Best TP is on position.
    for (const tpOrder of validTPOrders) {
      if (tpOrder.index === takeProfits.length) {
        // Best TP - already set on position, skip separate order
        continue;
      }
      
      const tpPrice = tpOrder.price;
      const tpVolume = tpOrder.quantity;
      
      try {
        // cTrader placeLimitOrder expects volume in lots; tpOrder.quantity is in API units (cents)
        const volumeLots = tpVolume / lotSize;
        const orderId = await ctraderClient.placeLimitOrder({
          symbol,
          volume: volumeLots,
          tradeSide: tpSide,
          price: tpPrice,
          positionId: positionId?.toString() // Link to position (reduce-only-like guard - order modifies this position, not a new one)
        });
        
        logger.info('cTrader take profit limit order placed', {
          tradeId: trade.id,
          tpIndex: tpOrder.index,
          tpPrice,
          tpVolumeApiUnits: tpVolume,
          volumeLots,
          tpSide,
          orderId,
          positionId: positionId?.toString(),
          exchange: 'ctrader'
        });
        
        // Store TP order in database (quantity in lots for consistency with other exchanges)
        await db.insertOrder({
          trade_id: trade.id,
          order_type: 'take_profit',
          order_id: orderId,
          price: tpPrice,
          quantity: volumeLots,
          tp_index: tpOrder.index,
          status: 'pending'
        });
      } catch (error) {
        logger.error('Error placing cTrader take profit order', {
          tradeId: trade.id,
          symbol,
          channel: trade.channel,
          tpIndex: tpOrder.index,
          tpPrice,
          tpVolume,
          positionId: positionId?.toString(),
          exchange: 'ctrader',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    logger.error('Error placing cTrader take profit orders', {
      tradeId: trade.id,
      symbol: normalizeCTraderSymbol(trade.trading_pair),
      channel: trade.channel,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

/**
 * Place breakeven limit order for cTrader
 * Implements proper breakeven limit order placement (Gap #1)
 */
const placeBreakevenLimitOrder = async (
  trade: Trade,
  ctraderClient: CTraderClient,
  db: DatabaseManager,
  isLong: boolean
): Promise<void> => {
  try {
    const symbol = normalizeCTraderSymbol(trade.trading_pair);
    
    logger.debug('Getting position info for breakeven limit order', {
      tradeId: trade.id,
      symbol,
      positionId: trade.position_id,
      exchange: 'ctrader'
    });
    
    // Get position info with retry logic (Gap #4)
    let position: any = null;
    let positionResponse: any[] = [];
    const maxRetries = 3;
    const retryDelay = 1000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        positionResponse = await ctraderClient.getOpenPositions();
        
        logger.debug('Position API response received for breakeven order', {
          tradeId: trade.id,
          symbol,
          positionsCount: positionResponse.length,
          attempt,
          maxRetries,
          exchange: 'ctrader'
        });

        // Find the position
        if (trade.position_id) {
          position = positionResponse.find((p: any) => {
            const positionId = p.positionId || p.id;
            const positionSymbol = p.symbolName || p.symbol;
            return positionSymbol === symbol && positionId?.toString() === trade.position_id;
          });
        }
        
        if (!position) {
          const positions = positionResponse.filter((p: any) => {
            const positionSymbol = p.symbolName || p.symbol;
            const volume = Math.abs(p.volume || p.quantity || 0);
            return positionSymbol === symbol && volume > 0;
          });
          if (positions.length > 0) {
            position = positions[0];
          }
        }

        if (position) {
          logger.debug('Position found for breakeven order', {
            tradeId: trade.id,
            symbol,
            positionId: (position.positionId || position.id)?.toString(),
            volume: position.volume || position.quantity,
            attempt,
            exchange: 'ctrader'
          });
          break; // Found position, exit retry loop
        }
      } catch (error) {
        logger.debug('Error getting positions for breakeven order, retrying', {
          tradeId: trade.id,
          symbol,
          attempt,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
          exchange: 'ctrader'
        });
      }
      
      // If this wasn't the last attempt, wait before retrying
      if (attempt < maxRetries && !position) {
        await sleep(retryDelay);
      }
    }

    if (!position) {
      logger.warn('No cTrader position found for breakeven limit order', {
        tradeId: trade.id,
        symbol,
        positionId: trade.position_id,
        attempts: maxRetries,
        exchange: 'ctrader'
      });
      return;
    }

    const positionVolume = Math.abs(position.volume || position.quantity || 0);
    if (positionVolume === 0) {
      logger.warn('Position size is zero, cannot place breakeven limit order', {
        tradeId: trade.id,
        symbol,
        exchange: 'ctrader'
      });
      return;
    }

    // Get symbol info for precision (Gap #3)
    let symbolInfo: any;
    try {
      symbolInfo = await ctraderClient.getSymbolInfo(symbol);
      logger.debug('Symbol info retrieved for breakeven order', {
        tradeId: trade.id,
        symbol,
        symbolInfo: {
          symbolId: symbolInfo.symbolId,
          digits: symbolInfo.digits,
          volumePrecision: symbolInfo.volumePrecision
        },
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.warn('Failed to get symbol info for breakeven order, using defaults', {
        tradeId: trade.id,
        symbol,
        error: error instanceof Error ? error.message : String(error),
        exchange: 'ctrader'
      });
      symbolInfo = {};
    }

    // Extract precision from symbol info
    const pricePrecision = symbolInfo.digits !== undefined ? symbolInfo.digits : 5;
    const quantityPrecision = symbolInfo.volumePrecision !== undefined ? symbolInfo.volumePrecision : 2;

    // Round entry price (Gap #3)
    const entryPrice = roundPrice(trade.entry_price, pricePrecision, undefined);
    
    // Breakeven order side is opposite of position side (to close the position)
    // For Long (Buy) position, breakeven order is Sell
    // For Short (Sell) position, breakeven order is Buy
    const breakevenSide = isLong ? 'SELL' : 'BUY';

    // Round quantity (Gap #3)
    const quantity = roundQuantity(positionVolume, quantityPrecision, false);

    const breakevenPositionId = (position.positionId || position.id)?.toString() || trade.position_id;

    logger.info('Placing breakeven limit order', {
      tradeId: trade.id,
      symbol,
      entryPrice,
      quantity,
      side: breakevenSide,
      positionVolume,
      positionId: breakevenPositionId,
      exchange: 'ctrader'
    });

    const orderId = await ctraderClient.placeLimitOrder({
      symbol,
      volume: quantity,
      tradeSide: breakevenSide,
      price: entryPrice,
      positionId: breakevenPositionId
    });

    if (orderId) {
      // Store breakeven limit order in database
      await db.insertOrder({
        trade_id: trade.id,
        order_type: 'breakeven_limit',
        order_id: orderId,
        price: entryPrice,
        quantity: positionVolume,
        status: 'pending'
      });

      logger.info('Breakeven limit order placed successfully', {
        tradeId: trade.id,
        symbol,
        orderId,
        entryPrice,
        quantity,
        exchange: 'ctrader'
      });
    } else {
      logger.error('Failed to place breakeven limit order - no order ID returned', {
        tradeId: trade.id,
        symbol,
        entryPrice,
        quantity,
        exchange: 'ctrader'
      });
    }
  } catch (error) {
    logger.error('Failed to place breakeven limit order', {
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error),
      exchange: 'ctrader'
    });
  }
};

/**
 * Monitor a single cTrader trade
 */
const monitorTrade = async (
  channel: string,
  entryTimeoutMinutes: number,
  trade: Trade,
  db: DatabaseManager,
  ctraderClient: CTraderClient | undefined,
  isSimulation: boolean,
  priceProvider: HistoricalPriceProvider | undefined,
  breakevenAfterTPs: number,
  useLimitOrderForBreakeven: boolean = true
): Promise<void> => {
  const timings: Record<string, number> = {};
  let t0 = Date.now();
  const monitorStart = Date.now();

  try {
    logger.info('Monitoring cTrader trade', {
      tradeId: trade.id,
      status: trade.status,
      symbol: trade.trading_pair,
      orderId: trade.order_id,
      positionId: trade.position_id,
      channel: trade.channel,
      exchange: 'ctrader'
    });

    // Check if trade has expired
    t0 = Date.now();
    if (await checkTradeExpired(trade, isSimulation, priceProvider)) {
      timings.checkTradeExpired = Date.now() - t0;
      logger.info('cTrader trade expired - cancelling order', {
        tradeId: trade.id,
        orderId: trade.order_id,
        channel: trade.channel,
        messageId: trade.message_id,
        symbol: trade.trading_pair,
        expiresAt: trade.expires_at,
        cancelReason: 'expired',
        exchange: 'ctrader'
      });
      await cancelOrder(trade, ctraderClient);
      await cancelTrade(trade, db);
      return;
    }
    timings.checkTradeExpired = Date.now() - t0;

    // For pending trades, check if position already exists
    t0 = Date.now();
    if (trade.status === 'pending' && !isSimulation && ctraderClient) {
      try {
        const positions = await ctraderClient.getOpenPositions();
        const symbol = normalizeCTraderSymbol(trade.trading_pair);
        const position = positions.find((p: any) => {
          const positionSymbol = p.symbolName || p.symbol;
          const volume = Math.abs(p.volume || p.quantity || 0);
          return positionSymbol === symbol && volume > 0;
        });
        
        if (position) {
          const positionId = position.positionId || position.id;
          const fillTime = trade.entry_filled_at || dayjs().toISOString();
          
          logger.info('cTrader entry order filled', {
            tradeId: trade.id,
            tradingPair: trade.trading_pair,
            entryPrice: trade.entry_price,
            positionId: positionId?.toString(),
            channel: trade.channel,
            exchange: 'ctrader',
            note: 'Detected via position check - entry was filled but status not updated'
          });
          
          await db.updateTrade(trade.id, {
            status: 'active',
            entry_filled_at: fillTime,
            position_id: positionId?.toString()
          });
          trade.status = 'active';
          trade.entry_filled_at = fillTime;
          trade.position_id = positionId?.toString();

          await updateEntryOrderToFilled(trade, db, fillTime);
          await Promise.race([
            placeTakeProfitOrders(trade, ctraderClient, db),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error(`TP placement timeout after ${TP_PLACEMENT_TIMEOUT_MS}ms`)), TP_PLACEMENT_TIMEOUT_MS))
          ]).catch(err => {
            logger.warn('TP placement timed out or failed - will retry next poll', {
              tradeId: trade.id,
              channel: trade.channel,
              exchange: 'ctrader',
              error: err instanceof Error ? err.message : String(err)
            });
          });
        }
      } catch (error) {
        logger.debug('Error checking cTrader positions for pending trade', {
          tradeId: trade.id,
          exchange: 'ctrader',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    timings.pendingPositionCheck = Date.now() - t0;

    // Get current price
    t0 = Date.now();
    const currentPrice = await getCurrentPrice(trade.trading_pair, ctraderClient, isSimulation, priceProvider);
    if (!currentPrice) {
      logger.warn('Could not get current price for cTrader trade', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        exchange: 'ctrader'
      });
      return;
    }
    timings.getCurrentPrice = Date.now() - t0;

    // Check if entry price was hit before stop loss or take profit (for pending trades)
    if (trade.status === 'pending') {
      const isLong = getIsLong(trade);
      
      if (checkSLHitBeforeEntry(trade, currentPrice)) {
        logger.info('Price hit SL before entry - cancelling cTrader order', {
          tradeId: trade.id,
          currentPrice,
          stopLoss: trade.stop_loss,
          entryPrice: trade.entry_price,
          exchange: 'ctrader'
        });
        await cancelOrder(trade, ctraderClient);
        await cancelTrade(trade, db);
        return;
      }

      if (checkTPHitBeforeEntry(trade, currentPrice)) {
        logger.info('Price hit TP before entry - TP orders will fill and book profit', {
          tradeId: trade.id,
          currentPrice,
          entryPrice: trade.entry_price,
          exchange: 'ctrader',
          note: 'Relevant TP Orders will fill at current price and profit will be booked immediately'
        });
      }

      // Check if entry is filled
      logger.debug('Checking if cTrader entry order is filled', {
        tradeId: trade.id,
        symbol: trade.trading_pair,
        orderId: trade.order_id,
        status: trade.status,
        entryPrice: trade.entry_price,
        currentPrice,
        exchange: 'ctrader'
      });
      
      const entryResult = await checkEntryFilled(trade, ctraderClient, isSimulation, priceProvider);
      logger.debug('cTrader entry fill check result', {
        tradeId: trade.id,
        filled: entryResult.filled,
        positionId: entryResult.positionId,
        exchange: 'ctrader'
      });
      
      if (entryResult.filled) {
        logger.info('cTrader entry order filled', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair,
          entryPrice: trade.entry_price,
          positionId: entryResult.positionId,
          channel: trade.channel,
          exchange: 'ctrader'
        });
        
        // Use actual fill time from position when available; dayjs() is monitor poll time and can be delayed
        const fillTime = entryResult.filledAt ?? dayjs().toISOString();
        await db.updateTrade(trade.id, {
          status: 'active',
          entry_filled_at: fillTime,
          position_id: entryResult.positionId
        });
        trade.status = 'active';
        trade.entry_filled_at = fillTime;
        trade.position_id = entryResult.positionId;

        await updateEntryOrderToFilled(trade, db, fillTime);
        await Promise.race([
          placeTakeProfitOrders(trade, ctraderClient, db),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`TP placement timeout after ${TP_PLACEMENT_TIMEOUT_MS}ms`)), TP_PLACEMENT_TIMEOUT_MS))
        ]).catch(err => {
          logger.warn('TP placement timed out or failed - will retry next poll', {
            tradeId: trade.id,
            channel: trade.channel,
            exchange: 'ctrader',
            error: err instanceof Error ? err.message : String(err)
          });
        });
      }
    }

    // Monitor active trades
    if (trade.status === 'active' || trade.status === 'filled') {
      const orders = await db.getOrdersByTradeId(trade.id);

      // Retry TP placement if entry filled but we have fewer TPs than expected
      // Handles: initial placement failed, partial placement failed, monitor was down when entry filled
      // cTrader: best TP is on position (not in DB); only non-best TPs are limit orders in DB.
      // When validation consolidates to 1 TP (all non-best round to 0), we insert a position-TP marker.
      if (trade.entry_filled_at && ctraderClient) {
        const takeProfits = JSON.parse(trade.take_profits || '[]') as number[];
        if (takeProfits.length > 0) {
          const tpOrders = orders.filter((o) => o.order_type === 'take_profit');
          const tpCount = tpOrders.length;
          const nonBestCount = Math.max(0, takeProfits.length - 1);
          const hasPositionTpMarker = tpOrders.some((o) => o.order_id === 'ctrader_position_tp');
          const expectedMet = tpCount >= nonBestCount || (tpCount >= 1 && hasPositionTpMarker);
          if (!expectedMet) {
            logger.info('Retrying TP placement - active trade has fewer TPs than expected', {
              tradeId: trade.id,
              tpCount,
              expectedCount: nonBestCount,
              hasPositionTpMarker,
              exchange: 'ctrader'
            });
            await Promise.race([
              placeTakeProfitOrders(trade, ctraderClient, db),
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error(`TP placement timeout after ${TP_PLACEMENT_TIMEOUT_MS}ms`)), TP_PLACEMENT_TIMEOUT_MS))
            ]).catch(err => {
              logger.warn('TP placement timed out or failed - will retry next poll', {
                tradeId: trade.id,
                channel: trade.channel,
                exchange: 'ctrader',
                error: err instanceof Error ? err.message : String(err)
              });
            });
          }
        }
      }

      // Check SL/TP orders for fills
      const pendingOrders = orders.filter(o => o.status === 'pending');
      // Fetch open orders ONCE and reuse - avoid N reconcile calls (was causing 60s timeout for trades with multiple orders)
      let cachedOpenOrders: any[] | undefined;
      t0 = Date.now();
      if (pendingOrders.length > 0 && ctraderClient) {
        try {
          cachedOpenOrders = await ctraderClient.getOpenOrders();
        } catch (err) {
          logger.warn('Failed to fetch open orders for fill check, will fetch per-order', {
            tradeId: trade.id,
            error: err instanceof Error ? err.message : String(err),
            exchange: 'ctrader'
          });
        }
      }
      timings.fetchOpenOrders = Date.now() - t0;

      t0 = Date.now();
      for (const order of pendingOrders) {
        const orderResult = await checkOrderFilled(order, trade, ctraderClient, isSimulation, priceProvider, cachedOpenOrders);
        if (orderResult.filled) {
          if (order.order_type === 'take_profit') {
            logger.info('cTrader take profit order filled', {
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              orderId: order.id,
              tpIndex: order.tp_index,
              tpPrice: order.price,
              filledPrice: orderResult.filledPrice,
              channel: trade.channel,
              exchange: 'ctrader'
            });
          } else if (order.order_type === 'stop_loss') {
            logger.info('cTrader stop loss order filled', {
              tradeId: trade.id,
              tradingPair: trade.trading_pair,
              orderId: order.id,
              slPrice: order.price,
              filledPrice: orderResult.filledPrice,
              channel: trade.channel,
              exchange: 'ctrader'
            });
          } else {
            logger.info('cTrader order filled', {
              tradeId: trade.id,
              orderId: order.id,
              orderType: order.order_type,
              filledPrice: orderResult.filledPrice,
              exchange: 'ctrader'
            });
          }

          await updateOrderToFilled(order, db, orderResult.filledPrice);

          if (order.order_type === 'stop_loss') {
            await updateTradeOnStopLossHit(trade, db, orderResult.filledPrice);
          }
          
          if (order.order_type === 'breakeven_limit') {
            await updateTradeOnBreakevenFilled(trade, db, orderResult.filledPrice || trade.entry_price);
          }
        }
      }
      timings.checkOrderFillsLoop = Date.now() - t0;

      // Check if position is closed (pass db for fallback when position_id missing - detects orphans)
      t0 = Date.now();
      const positionResult = await checkPositionClosed(trade, ctraderClient, isSimulation, priceProvider, db);
      timings.checkPositionClosed = Date.now() - t0;
      if (positionResult.closed) {
        logger.info('cTrader position closed', {
          tradeId: trade.id,
          exitPrice: positionResult.exitPrice,
          pnl: positionResult.pnl,
          exchange: 'ctrader'
        });
        // Cancel any pending TP/SL/breakeven orders - cTrader does not auto-cancel them when position closes
        if (ctraderClient) {
          t0 = Date.now();
          await cancelCTraderPendingOrders(trade, db, ctraderClient);
          timings.cancelPendingOrders = Date.now() - t0;
        }
        await updateTradeOnPositionClosed(trade, db, positionResult.exitPrice, positionResult.pnl);
        return;
      }
      
      const isLong = getIsLong(trade);
      const filledTPCount = await countFilledTakeProfits(trade, db);

      // Check if we've hit the required number of TPs to move to breakeven
      if (filledTPCount >= breakevenAfterTPs && !trade.stop_loss_breakeven) {
        const existingBreakevenOrder = await getBreakevenLimitOrder(trade, db);

        if (useLimitOrderForBreakeven) {
          // Create limit order at entry price instead of moving stop loss (Gap #1)
          if (!existingBreakevenOrder && ctraderClient) {
            logger.info('Required take profits hit - creating cTrader breakeven limit order at entry price', {
              tradeId: trade.id,
              filledTPCount,
              breakevenAfterTPs,
              entryPrice: trade.entry_price,
              exchange: 'ctrader'
            });
            
            try {
              await placeBreakevenLimitOrder(trade, ctraderClient, db, isLong);
              await db.updateTrade(trade.id, {
                stop_loss_breakeven: true
              });
            } catch (error) {
              logger.warn('cTrader breakeven limit order placement failed - will retry on next poll', {
                tradeId: trade.id,
                exchange: 'ctrader',
                error: error instanceof Error ? error.message : String(error)
              });
            }
          } else if (existingBreakevenOrder) {
            logger.debug('cTrader breakeven limit order already exists', {
              tradeId: trade.id,
              orderId: existingBreakevenOrder.order_id,
              exchange: 'ctrader'
            });
            await db.updateTrade(trade.id, {
              stop_loss_breakeven: true
            });
          }
        } else {
          // Move stop loss to entry price
          logger.info('Required take profits hit - moving cTrader stop loss to breakeven', {
            tradeId: trade.id,
            filledTPCount,
            breakevenAfterTPs,
            entryPrice: trade.entry_price,
            exchange: 'ctrader'
          });
          
          if (trade.position_id && ctraderClient) {
            try {
              await ctraderClient.modifyPosition({
                positionId: trade.position_id,
                stopLoss: trade.entry_price
              });
              await db.updateTrade(trade.id, {
                stop_loss: trade.entry_price,
                stop_loss_breakeven: true
              });
            } catch (error) {
              logger.warn('cTrader stop loss move to breakeven failed - will retry on next poll', {
                tradeId: trade.id,
                exchange: 'ctrader',
                error: error instanceof Error ? error.message : String(error)
              });
            }
          } else {
            logger.warn('Cannot move cTrader SL to breakeven - missing position_id or client, will retry on next poll', {
              tradeId: trade.id,
              hasPositionId: !!trade.position_id,
              hasClient: !!ctraderClient,
              exchange: 'ctrader'
            });
          }
        }
      }

      // Check if stop loss is hit
      if (checkStopLossHit(trade, currentPrice)) {
        logger.info('cTrader stop loss hit', {
          tradeId: trade.id,
          currentPrice,
          stopLoss: trade.stop_loss,
          exchange: 'ctrader'
        });
        
        const stopLossResult = await checkPositionClosed(trade, ctraderClient, isSimulation, priceProvider, db);
        if (stopLossResult.closed) {
          if (ctraderClient) {
            await cancelCTraderPendingOrders(trade, db, ctraderClient);
          }
          await updateTradeOnStopLossHit(trade, db, stopLossResult.exitPrice, stopLossResult.pnl);
        } else {
          await db.updateTrade(trade.id, { status: 'stopped' });
        }
      }
    }
  } catch (error) {
    logger.error('Error monitoring cTrader trade', {
      tradeId: trade.id,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    const totalElapsedMs = Date.now() - monitorStart;
    const sumOfPhasesMs = Object.values(timings).reduce((a, b) => a + b, 0);
    logger.log('trace', 'cTrader monitor trade timings', {
      tradeId: trade.id,
      channel,
      exchange: 'ctrader',
      totalElapsedMs,
      sumOfPhasesMs,
      timings
    });
  }
};

/**
 * Start cTrader trade monitor
 */
export const startCTraderMonitor = async (
  monitorConfig: MonitorConfig,
  channel: string,
  db: DatabaseManager,
  isSimulation: boolean = false,
  priceProvider?: HistoricalPriceProvider,
  speedMultiplier?: number,
  getCTraderClient?: (accountName?: string) => Promise<CTraderClient | undefined>
): Promise<() => Promise<void>> => {
  logger.info('Starting cTrader trade monitor', { type: monitorConfig.type, channel });

  // Legacy support: create a single cTrader client if getCTraderClient not provided
  let ctraderClient: CTraderClient | undefined;
  if (!getCTraderClient) {
    const accessToken = process.env.CTRADER_ACCESS_TOKEN;
    const accountId = process.env.CTRADER_ACCOUNT_ID;
    const clientId = process.env.CTRADER_CLIENT_ID;
    const clientSecret = process.env.CTRADER_CLIENT_SECRET;

    if (!accessToken || !accountId) {
      logger.error('cTrader credentials not found in environment variables', {
        channel,
        missing: !accessToken ? 'CTRADER_ACCESS_TOKEN' : 'CTRADER_ACCOUNT_ID'
      });
      throw new Error('cTrader credentials required for ctrader monitor');
    }

    const clientConfig = {
      clientId: clientId || '',
      clientSecret: clientSecret || '',
      accessToken,
      accountId,
      environment: 'demo' as 'demo' | 'live'
    };
    
    ctraderClient = new CTraderClient(clientConfig);
    try {
      await ctraderClient.connect();
      await ctraderClient.authenticate();
      logger.info('cTrader monitor client initialized', {
        channel,
        type: monitorConfig.type,
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.error('Failed to initialize cTrader client', {
        channel,
        exchange: 'ctrader',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  let running = true;
  const pollInterval = monitorConfig.pollInterval || 10000;
  const entryTimeoutMinutes = monitorConfig.entryTimeoutMinutes || 2880;
  const breakevenAfterTPs = monitorConfig.breakevenAfterTPs ?? 1;
  const useLimitOrderForBreakeven = monitorConfig.useLimitOrderForBreakeven ?? true;
  const closeOrphanPositions = monitorConfig.closeOrphanPositions ?? false;
  const closeOrphanPositionsGraceMinutes = monitorConfig.closeOrphanPositionsGraceMinutes ?? 2;

  const monitorLoop = async (): Promise<void> => {
    const isMaxSpeed = speedMultiplier !== undefined && (speedMultiplier === 0 || speedMultiplier === Infinity || !isFinite(speedMultiplier));
    
    while (running) {
      try {
        if (closeOrphanPositions) {
          const getClient = getCTraderClient ?? (async () => ctraderClient);
          await checkAndCloseOrphanPositions(
            db,
            getClient,
            closeOrphanPositions,
            closeOrphanPositionsGraceMinutes
          );
        }

        const trades = (await db.getActiveTrades()).filter(t => t.channel === channel && t.exchange === 'ctrader');
        
        // Process each trade in parallel with per-trade timeout - prevents one stuck trade from blocking others
        const tradeTasks = trades.map(async (trade) => {
          const accountCTraderClient = getCTraderClient
            ? await getCTraderClient(trade.account_name)
            : ctraderClient;
          if (!accountCTraderClient) {
            logger.warn('No cTrader client for trade - cannot check position or cancel orders', {
              tradeId: trade.id,
              channel,
              accountName: trade.account_name ?? '(none)',
              exchange: 'ctrader'
            });
          }
          return Promise.race([
            monitorTrade(
              channel,
              entryTimeoutMinutes,
              trade,
              db,
              accountCTraderClient,
              isSimulation,
              priceProvider,
              breakevenAfterTPs,
              useLimitOrderForBreakeven
            ),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error(`Trade ${trade.id} monitor timeout after ${MONITOR_TRADE_TIMEOUT_MS}ms`)), MONITOR_TRADE_TIMEOUT_MS)
            )
          ]);
        });

        const results = await Promise.allSettled(tradeTasks);
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === 'rejected') {
            const trade = trades[i];
            const isTimeout = result.reason instanceof Error && result.reason.message.includes('timeout');
            logger.warn(isTimeout ? 'Monitor trade timed out - will retry next poll' : 'Monitor trade failed', {
              tradeId: trade.id,
              channel,
              exchange: 'ctrader',
              error: result.reason instanceof Error ? result.reason.message : String(result.reason)
            });
          }
        }

        if (!isMaxSpeed) {
          await sleep(pollInterval);
        } else {
          await new Promise(resolve => setImmediate(resolve));
        }
      } catch (error) {
        logger.error('Error in cTrader monitor loop', {
          channel,
          exchange: 'ctrader',
          error: error instanceof Error ? error.message : String(error)
        });
        if (!isMaxSpeed) {
          await sleep(pollInterval * 2);
        }
      }
    }
  };

  monitorLoop().catch(error => {
    logger.error('Fatal error in cTrader monitor loop', {
      channel,
      exchange: 'ctrader',
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return async (): Promise<void> => {
    logger.info('Stopping cTrader trade monitor', { type: monitorConfig.type, channel, exchange: 'ctrader' });
    running = false;
  };
};

