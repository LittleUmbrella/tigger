#!/usr/bin/env tsx
/**
 * Fix Trade TP Orders Script
 * 
 * Manually updates trade status and places TP orders if entry was filled but TPs weren't placed
 */

import { DatabaseManager, Trade } from '../db/schema.js';
import { RestClientV5 } from 'bybit-api';
import { logger } from '../utils/logger.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import dotenv from 'dotenv';
import dayjs from 'dayjs';

dotenv.config();

/**
 * Normalize trading pair symbol for Bybit API calls
 */
const normalizeBybitSymbol = (tradingPair: string): string => {
  let normalized = tradingPair.replace('/', '').toUpperCase();
  if (!normalized.endsWith('USDT') && !normalized.endsWith('USDC')) {
    normalized = `${normalized}USDT`;
  }
  return normalized;
};

async function fixTradeTPs(tradeId: number) {
  logger.info('Starting trade TP fix', { tradeId });

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

    logger.info('Trade found', {
      tradeId: trade.id,
      symbol: trade.trading_pair,
      status: trade.status,
      entryFilledAt: trade.entry_filled_at,
      positionId: trade.position_id,
      accountName: trade.account_name
    });

    // Check if TP orders already exist
    const orders = await db.getOrdersByTradeId(tradeId);
    const existingTPOrders = orders.filter(o => o.order_type === 'take_profit');
    
    if (existingTPOrders.length > 0) {
      logger.info('TP orders already exist', {
        tradeId,
        tpCount: existingTPOrders.length
      });
      return;
    }

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
    
    // First, check order history to confirm entry was filled
    let entryFilledConfirmed = false;
    if (trade.order_id) {
      logger.info('Checking order history to confirm entry fill', {
        orderId: trade.order_id,
        symbol
      });
      
      try {
        const orderHistory = await bybitClient.getHistoricOrders({
          category: 'linear',
          symbol: symbol,
          orderId: trade.order_id,
          limit: 10
        });

        if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list) {
          const historicalOrder = orderHistory.result.list.find((o: any) => 
            getBybitField<string>(o, 'orderId', 'order_id') === trade.order_id
          );
          
          if (historicalOrder) {
            const orderStatus = getBybitField<string>(historicalOrder, 'orderStatus', 'order_status');
            entryFilledConfirmed = orderStatus === 'Filled' || orderStatus === 'PartiallyFilled';
            logger.info('Order history check', {
              orderId: trade.order_id,
              orderStatus,
              entryFilledConfirmed
            });
          }
        }
      } catch (error) {
        logger.warn('Error checking order history', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    // Check for open position
    logger.info('Checking for open position', { symbol });
    const positions = await bybitClient.getPositionInfo({
      category: 'linear',
      symbol: symbol
    });

    let position: any = null;
    if (positions.retCode === 0 && positions.result && positions.result.list) {
      // Find position with non-zero size
      position = positions.result.list.find((p: any) => {
        const size = parseFloat(getBybitField<string>(p, 'size') || '0');
        return p.symbol === symbol && size !== 0;
      });
    }

    if (!position && !entryFilledConfirmed) {
      logger.warn('No open position found and entry fill not confirmed in order history.', {
        tradeId,
        symbol
      });
      logger.info('Cannot proceed without confirmation that entry was filled.');
      return;
    }

    if (!position) {
      logger.warn('No open position found, but entry fill confirmed. Position may have been closed.', {
        tradeId,
        symbol
      });
      
      // Update trade status even if position is closed
      if (trade.status === 'pending' || !trade.entry_filled_at) {
        const fillTime = dayjs().toISOString();
        logger.info('Updating trade status to active (position closed)', {
          tradeId
        });

        await db.updateTrade(trade.id, {
          status: 'active',
          entry_filled_at: fillTime
        });

        // Update entry order status
        const entryOrder = orders.find(o => o.order_type === 'entry');
        if (entryOrder && entryOrder.status !== 'filled') {
          await db.updateOrder(entryOrder.id, {
            status: 'filled',
            filled_at: fillTime,
            filled_price: trade.entry_price
          });
          logger.info('Entry order updated to filled', {
            orderId: entryOrder.id
          });
        }
      }
      
      logger.info('TP orders cannot be placed without an active position.');
      return;
    }

    logger.info('Found open position', {
      tradeId,
      symbol,
      size: getBybitField<string>(position, 'size'),
      positionIdx: getBybitField<string | number>(position, 'positionIdx', 'position_idx')
    });

    // Update trade status if needed
    if (trade.status === 'pending' || !trade.entry_filled_at) {
      const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
      const fillTime = dayjs().toISOString();
      
      logger.info('Updating trade status to active', {
        tradeId,
        positionId: positionIdx?.toString()
      });

      await db.updateTrade(trade.id, {
        status: 'active',
        entry_filled_at: fillTime,
        position_id: positionIdx?.toString()
      });

      // Update entry order status
      const entryOrder = orders.find(o => o.order_type === 'entry');
      if (entryOrder && entryOrder.status !== 'filled') {
        await db.updateOrder(entryOrder.id, {
          status: 'filled',
          filled_at: fillTime,
          filled_price: trade.entry_price
        });
        logger.info('Entry order updated to filled', {
          orderId: entryOrder.id
        });
      }
    }

    // Now place TP orders
    logger.info('Placing TP orders', { tradeId });
    
    // Import the placeTakeProfitOrders function logic
    // For now, let's call the monitor's placeTakeProfitOrders by importing it
    // Actually, we can't easily import it, so let's manually place the orders
    
    const takeProfits = JSON.parse(trade.take_profits) as number[];
    if (!takeProfits || takeProfits.length === 0) {
      logger.warn('No take profits defined', { tradeId });
      return;
    }

    const positionSize = Math.abs(parseFloat(getBybitField<string>(position, 'size') || '0'));
    const positionSizeStr = getBybitField<string>(position, 'size') || '0';
    const positionSide = parseFloat(positionSizeStr) > 0 ? 'Buy' : 'Sell';
    const tpSide = positionSide === 'Buy' ? 'Sell' : 'Buy';
    
    const positionIdx = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
    let positionIdxNum: 0 | 1 | 2 = 0;
    if (positionIdx !== undefined) {
      const idx = typeof positionIdx === 'string' ? parseInt(positionIdx, 10) : positionIdx;
      if (!isNaN(idx) && (idx === 0 || idx === 1 || idx === 2)) {
        positionIdxNum = idx as 0 | 1 | 2;
      }
    }

    // Get symbol info for precision
    const { getSymbolInfo } = await import('../initiators/symbolValidator.js');
    const symbolInfo = await getSymbolInfo(bybitClient, symbol);
    const decimalPrecision = symbolInfo?.qtyPrecision ?? 2;
    const pricePrecision = symbolInfo?.pricePrecision;
    const qtyStep = symbolInfo?.qtyStep;

    // Round TP prices
    const { roundPrice } = await import('../utils/positionSizing.js');
    const roundedTPPrices = takeProfits.map(tpPrice => 
      roundPrice(tpPrice, pricePrecision, undefined)
    );

    // Distribute quantity across TPs
    const numTPs = takeProfits.length;
    const baseQty = positionSize / numTPs;
    const tpQuantities: number[] = [];
    for (let i = 0; i < numTPs - 1; i++) {
      tpQuantities.push(Math.floor(baseQty * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision));
    }
    const allocatedQty = tpQuantities.reduce((sum, qty) => sum + qty, 0);
    const remainingQty = positionSize - allocatedQty;
    tpQuantities.push(Math.ceil(remainingQty * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision));

    // Round quantities to qtyStep if specified
    const effectiveQtyStep = qtyStep !== undefined && qtyStep > 0 ? qtyStep : Math.pow(10, -decimalPrecision);
    const roundedTPQuantities = tpQuantities.map(qty => {
      if (effectiveQtyStep > 0) {
        return Math.floor(qty / effectiveQtyStep) * effectiveQtyStep;
      }
      return qty;
    });

    // Format quantity helper
    const formatQuantity = (quantity: number, precision: number): string => {
      const formatted = quantity.toFixed(precision);
      return formatted.replace(/\.?0+$/, '');
    };

    // Place TP orders
    for (let i = 0; i < roundedTPPrices.length; i++) {
      try {
        const tpOrderParams = {
          category: 'linear' as const,
          symbol: symbol,
          side: tpSide as 'Buy' | 'Sell',
          orderType: 'Limit' as const,
          qty: formatQuantity(roundedTPQuantities[i], decimalPrecision),
          price: roundedTPPrices[i].toString(),
          timeInForce: 'GTC' as const,
          reduceOnly: true,
          closeOnTrigger: false,
          positionIdx: positionIdxNum,
        };

        logger.info('Placing TP order', {
          tradeId,
          tpIndex: i + 1,
          tpPrice: roundedTPPrices[i],
          tpQty: roundedTPQuantities[i],
          tpSide
        });

        const tpOrderResponse = await bybitClient.submitOrder(tpOrderParams);
        const tpOrderId = getBybitField<string>(tpOrderResponse.result, 'orderId', 'order_id');
        
        if (tpOrderResponse.retCode === 0 && tpOrderResponse.result && tpOrderId) {
          await db.insertOrder({
            trade_id: trade.id,
            order_type: 'take_profit',
            order_id: tpOrderId,
            price: roundedTPPrices[i],
            tp_index: i + 1,
            quantity: roundedTPQuantities[i],
            status: 'pending'
          });

          logger.info('TP order placed successfully', {
            tradeId,
            tpIndex: i + 1,
            tpOrderId
          });
        } else {
          logger.error('Failed to place TP order', {
            tradeId,
            tpIndex: i + 1,
            error: JSON.stringify(tpOrderResponse)
          });
        }
      } catch (error) {
        logger.error('Error placing TP order', {
          tradeId,
          tpIndex: i + 1,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    logger.info('TP order placement complete', { tradeId });

  } catch (error) {
    logger.error('Error fixing trade TPs', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  } finally {
    await db.close();
  }
}

// Get trade ID from command line args
const tradeId = process.argv[2] ? parseInt(process.argv[2], 10) : 13;

if (isNaN(tradeId)) {
  logger.error('Invalid trade ID', { provided: process.argv[2] });
  process.exit(1);
}

fixTradeTPs(tradeId).catch(error => {
  logger.error('Fatal error', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exit(1);
});

