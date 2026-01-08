#!/usr/bin/env tsx
/**
 * Troubleshoot Trade Script
 * 
 * Connects to database and Bybit to diagnose trade issues
 */

import { DatabaseManager, Trade, Order } from '../db/schema.js';
import { RestClientV5 } from 'bybit-api';
import { logger } from '../utils/logger.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Normalize trading pair symbol for Bybit API calls
 * Converts "PAXG" or "PAXG/USDT" to "PAXGUSDT"
 */
const normalizeBybitSymbol = (tradingPair: string): string => {
  let normalized = tradingPair.replace('/', '').toUpperCase();
  
  // If symbol doesn't end with USDT or USDC, add USDT
  if (!normalized.endsWith('USDT') && !normalized.endsWith('USDC')) {
    normalized = `${normalized}USDT`;
  }
  
  return normalized;
};

async function troubleshootTrade(tradeId: number) {
  logger.info('Starting trade troubleshooting', { tradeId });

  // Initialize database
  const db = new DatabaseManager();
  await db.initialize();

  try {
    // Get trade from database
    const trade = await db.getTradeWithMessage(tradeId);
    if (!trade) {
      logger.error('Trade not found in database', { tradeId });
      return;
    }

    logger.info('Trade found in database', {
      tradeId: trade.id,
      symbol: trade.trading_pair,
      status: trade.status,
      orderId: trade.order_id,
      positionId: trade.position_id,
      entryFilledAt: trade.entry_filled_at,
      entryPrice: trade.entry_price,
      direction: trade.direction,
      accountName: trade.account_name
    });

    // Get orders for this trade
    const orders = await db.getOrdersByTradeId(tradeId);
    logger.info('Orders in database', {
      tradeId,
      orders: orders.map(o => ({
        id: o.id,
        type: o.order_type,
        orderId: o.order_id,
        status: o.status,
        price: o.price,
        tpIndex: o.tp_index
      }))
    });

    // Initialize Bybit client
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    const testnet = process.env.BYBIT_TESTNET === 'true';

    if (!apiKey || !apiSecret) {
      logger.error('Bybit API credentials not found');
      return;
    }

    const bybitClient = new RestClientV5({ 
      key: apiKey, 
      secret: apiSecret, 
      testnet 
    });

    const symbol = normalizeBybitSymbol(trade.trading_pair);
    logger.info('Checking Bybit for symbol', { symbol, originalTradingPair: trade.trading_pair });

    // 1. Check active orders
    logger.info('=== Checking Active Orders ===');
    try {
      const activeOrders = await bybitClient.getActiveOrders({
        category: 'linear',
        symbol: symbol
      });
      
      logger.info('Active orders response', {
        retCode: activeOrders.retCode,
        retMsg: activeOrders.retMsg,
        hasResult: !!activeOrders.result,
        hasList: !!(activeOrders.result && activeOrders.result.list),
        listLength: activeOrders.result?.list?.length || 0
      });

      if (activeOrders.retCode === 0 && activeOrders.result && activeOrders.result.list) {
        logger.info('Active orders list', {
          orders: activeOrders.result.list.map((o: any) => ({
            orderId: getBybitField<string>(o, 'orderId', 'order_id'),
            orderLinkId: getBybitField<string>(o, 'orderLinkId', 'order_link_id'),
            symbol: o.symbol,
            side: o.side,
            orderStatus: getBybitField<string>(o, 'orderStatus', 'order_status'),
            orderType: o.orderType,
            price: o.price,
            qty: o.qty
          }))
        });

        if (trade.order_id) {
          const matchingOrder = activeOrders.result.list.find((o: any) => 
            getBybitField<string>(o, 'orderId', 'order_id') === trade.order_id
          );
          if (matchingOrder) {
            logger.info('Found matching order in active orders', {
              orderId: trade.order_id,
              orderStatus: getBybitField<string>(matchingOrder, 'orderStatus', 'order_status')
            });
          } else {
            logger.warn('Order not found in active orders', { orderId: trade.order_id });
          }
        }
      }
    } catch (error) {
      logger.error('Error checking active orders', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // 2. Check order history
    logger.info('=== Checking Order History ===');
    if (trade.order_id) {
      try {
        const orderHistory = await bybitClient.getHistoricOrders({
          category: 'linear',
          symbol: symbol,
          orderId: trade.order_id,
          limit: 10
        });

        logger.info('Order history response', {
          retCode: orderHistory.retCode,
          retMsg: orderHistory.retMsg,
          hasResult: !!orderHistory.result,
          hasList: !!(orderHistory.result && orderHistory.result.list),
          listLength: orderHistory.result?.list?.length || 0
        });

        if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list) {
          logger.info('Order history list', {
            orders: orderHistory.result.list.map((o: any) => ({
              orderId: getBybitField<string>(o, 'orderId', 'order_id'),
              orderLinkId: getBybitField<string>(o, 'orderLinkId', 'order_link_id'),
              symbol: o.symbol,
              side: o.side,
              orderStatus: getBybitField<string>(o, 'orderStatus', 'order_status'),
              orderType: o.orderType,
              price: o.price,
              qty: o.qty,
              avgPrice: getBybitField<string>(o, 'avgPrice', 'avg_price'),
              cumExecQty: getBybitField<string>(o, 'cumExecQty', 'cum_exec_qty')
            }))
          });

          const matchingOrder = orderHistory.result.list.find((o: any) => 
            getBybitField<string>(o, 'orderId', 'order_id') === trade.order_id
          );
          if (matchingOrder) {
            const orderStatus = getBybitField<string>(matchingOrder, 'orderStatus', 'order_status');
            logger.info('Found matching order in history', {
              orderId: trade.order_id,
              orderStatus,
              avgPrice: getBybitField<string>(matchingOrder, 'avgPrice', 'avg_price'),
              cumExecQty: getBybitField<string>(matchingOrder, 'cumExecQty', 'cum_exec_qty')
            });
          } else {
            logger.warn('Order not found in order history', { orderId: trade.order_id });
          }
        }
      } catch (error) {
        logger.error('Error checking order history', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 3. Check positions
    logger.info('=== Checking Positions ===');
    try {
      const positions = await bybitClient.getPositionInfo({
        category: 'linear',
        symbol: symbol
      });

      logger.info('Positions response', {
        retCode: positions.retCode,
        retMsg: positions.retMsg,
        hasResult: !!positions.result,
        hasList: !!(positions.result && positions.result.list),
        listLength: positions.result?.list?.length || 0
      });

      if (positions.retCode === 0 && positions.result && positions.result.list) {
        logger.info('Positions list', {
          positions: positions.result.list.map((p: any) => ({
            symbol: p.symbol,
            side: p.side,
            size: getBybitField<string>(p, 'size'),
            positionIdx: getBybitField<string | number>(p, 'positionIdx', 'position_idx'),
            avgPrice: getBybitField<string>(p, 'avgPrice', 'avg_price'),
            markPrice: getBybitField<string>(p, 'markPrice', 'mark_price'),
            leverage: getBybitField<string>(p, 'leverage'),
            unrealisedPnl: getBybitField<string>(p, 'unrealisedPnl', 'unrealised_pnl')
          }))
        });

        const openPositions = positions.result.list.filter((p: any) => 
          p.symbol === symbol && parseFloat(getBybitField<string>(p, 'size') || '0') !== 0
        );

        if (openPositions.length > 0) {
          logger.info('Found open positions', {
            count: openPositions.length,
            positions: openPositions.map((p: any) => ({
              symbol: p.symbol,
              size: getBybitField<string>(p, 'size'),
              positionIdx: getBybitField<string | number>(p, 'positionIdx', 'position_idx'),
              avgPrice: getBybitField<string>(p, 'avgPrice', 'avg_price')
            }))
          });

          if (trade.position_id) {
            const matchingPosition = openPositions.find((p: any) => {
              const positionIdx = getBybitField<string | number>(p, 'positionIdx', 'position_idx');
              return positionIdx?.toString() === trade.position_id;
            });
            if (matchingPosition) {
              logger.info('Found matching position', {
                positionId: trade.position_id,
                size: getBybitField<string>(matchingPosition, 'size'),
                avgPrice: getBybitField<string>(matchingPosition, 'avgPrice', 'avg_price')
              });
            } else {
              logger.warn('Position ID in database does not match any open position', {
                positionId: trade.position_id
              });
            }
          } else {
            logger.warn('Trade has no position_id but open positions exist', {
              openPositions: openPositions.length
            });
          }
        } else {
          logger.info('No open positions found for symbol', { symbol });
        }
      }
    } catch (error) {
      logger.error('Error checking positions', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // 4. Check current price
    logger.info('=== Checking Current Price ===');
    try {
      const ticker = await bybitClient.getTickers({
        category: 'linear',
        symbol: symbol
      });

      if (ticker.retCode === 0 && ticker.result && ticker.result.list) {
        const matchingTicker = ticker.result.list.find((t: any) => 
          t.symbol && t.symbol.toUpperCase() === symbol.toUpperCase()
        );
        if (matchingTicker) {
          logger.info('Current price', {
            symbol: matchingTicker.symbol,
            lastPrice: matchingTicker.lastPrice,
            entryPrice: trade.entry_price,
            priceDiff: matchingTicker.lastPrice ? parseFloat(matchingTicker.lastPrice) - trade.entry_price : null
          });
        } else {
          logger.warn('Ticker not found for symbol', { symbol });
        }
      }
    } catch (error) {
      logger.error('Error checking current price', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // 5. Summary and recommendations
    logger.info('=== Summary ===');
    logger.info('Database state', {
      status: trade.status,
      orderId: trade.order_id,
      positionId: trade.position_id,
      entryFilledAt: trade.entry_filled_at
    });

    logger.info('Troubleshooting complete. Review logs above for discrepancies.');

  } catch (error) {
    logger.error('Error during troubleshooting', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  } finally {
    await db.close();
  }
}

// Get trade ID from command line args
const tradeId = process.argv[2] ? parseInt(process.argv[2], 10) : 9;

if (isNaN(tradeId)) {
  logger.error('Invalid trade ID', { provided: process.argv[2] });
  process.exit(1);
}

troubleshootTrade(tradeId).catch(error => {
  logger.error('Fatal error', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exit(1);
});

