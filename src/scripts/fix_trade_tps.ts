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
import { BotConfig, AccountConfig } from '../types/config.js';
import fs from 'fs-extra';
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

async function fixTradeTPs(tradeId: number, accountName?: string) {
  logger.info('Starting trade TP fix', { tradeId, accountName });

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

    // Initialize Bybit client - use account-specific credentials if available
    let apiKey: string | undefined;
    let apiSecret: string | undefined;
    let testnet = process.env.BYBIT_TESTNET === 'true';
    let demo = false;
    let baseUrl: string | undefined;

    // Use provided account name, or trade's account_name, or default to 'demo' if trade has no account_name
    const accountNameToUse = accountName || trade.account_name || 'demo';
    logger.info('Using account for TP fix', {
      requestedAccount: accountNameToUse,
      tradeAccountName: trade.account_name,
      providedAccountName: accountName
    });

    // Helper function to get API key fingerprint (first 8 and last 4 chars)
    const getApiKeyFingerprint = (key: string | undefined): string => {
      if (!key) return 'not set';
      if (key.length < 12) return key.substring(0, 4) + '...';
      return key.substring(0, 8) + '...' + key.substring(key.length - 4);
    };

    // Try to load account-specific credentials from config
    try {
      const configPath = process.env.CONFIG_PATH || 'config.json';
      logger.info('Loading config', { configPath, exists: fs.existsSync(configPath) });
      
      if (fs.existsSync(configPath)) {
        const configContent = await fs.readFile(configPath, 'utf-8');
        const config: BotConfig = JSON.parse(configContent);
        
        const account = config.accounts?.find(acc => acc.name === accountNameToUse);
        if (account) {
          logger.info('Found account config', {
            accountName: accountNameToUse,
            testnet: account.testnet,
            demo: account.demo,
            hasEnvVarNames: !!(account.envVarNames?.apiKey || account.envVarNames?.apiSecret),
            envVarNames: {
              apiKey: account.envVarNames?.apiKey || account.envVars?.apiKey,
              apiSecret: account.envVarNames?.apiSecret || account.envVars?.apiSecret
            },
            hasDirectApiKey: !!account.apiKey,
            hasDirectApiSecret: !!account.apiSecret
          });
          
          // Set demo flag and baseUrl if demo mode
          demo = account.demo || false;
          testnet = account.testnet || false;
          
          // Demo trading uses api-demo.bybit.com endpoint (different from testnet)
          if (demo) {
            baseUrl = 'https://api-demo.bybit.com';
            logger.info('Demo mode enabled - using demo endpoint', {
              baseUrl
            });
          }
          
          const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
          const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
          
          logger.info('Checking environment variables', {
            envVarNameForKey,
            envVarNameForSecret,
            envVarForKeySet: envVarNameForKey ? !!process.env[envVarNameForKey] : 'N/A',
            envVarForSecretSet: envVarNameForSecret ? !!process.env[envVarNameForSecret] : 'N/A',
            defaultBybitApiKeySet: !!process.env.BYBIT_API_KEY,
            defaultBybitApiSecretSet: !!process.env.BYBIT_API_SECRET
          });
          
          // Determine which API key to use
          if (envVarNameForKey && process.env[envVarNameForKey]) {
            apiKey = process.env[envVarNameForKey];
            logger.info('Using API key from envVarNames', {
              envVarName: envVarNameForKey,
              fingerprint: getApiKeyFingerprint(apiKey)
            });
          } else if (account.apiKey) {
            apiKey = account.apiKey;
            logger.info('Using API key from account config (direct)', {
              fingerprint: getApiKeyFingerprint(apiKey)
            });
          } else {
            apiKey = process.env.BYBIT_API_KEY;
            logger.info('Using API key from default BYBIT_API_KEY env var', {
              fingerprint: getApiKeyFingerprint(apiKey)
            });
          }
          
          // Determine which API secret to use
          if (envVarNameForSecret && process.env[envVarNameForSecret]) {
            apiSecret = process.env[envVarNameForSecret];
            logger.info('Using API secret from envVarNames', {
              envVarName: envVarNameForSecret,
              fingerprint: getApiKeyFingerprint(apiSecret)
            });
          } else if (account.apiSecret) {
            apiSecret = account.apiSecret;
            logger.info('Using API secret from account config (direct)', {
              fingerprint: getApiKeyFingerprint(apiSecret)
            });
          } else {
            apiSecret = process.env.BYBIT_API_SECRET;
            logger.info('Using API secret from default BYBIT_API_SECRET env var', {
              fingerprint: getApiKeyFingerprint(apiSecret)
            });
          }
          
          testnet = account.testnet || false;
        } else {
          logger.warn('Account not found in config, using default credentials', {
            accountName: accountNameToUse,
            availableAccounts: config.accounts?.map(a => a.name).join(', ') || 'none'
          });
          apiKey = process.env.BYBIT_API_KEY;
          apiSecret = process.env.BYBIT_API_SECRET;
          logger.info('Using default credentials', {
            apiKeyFingerprint: getApiKeyFingerprint(apiKey),
            apiSecretFingerprint: getApiKeyFingerprint(apiSecret)
          });
        }
      } else {
        logger.warn('Config file not found, using default credentials', {
          configPath
        });
        apiKey = process.env.BYBIT_API_KEY;
        apiSecret = process.env.BYBIT_API_SECRET;
        logger.info('Using default credentials (no config)', {
          apiKeyFingerprint: getApiKeyFingerprint(apiKey),
          apiSecretFingerprint: getApiKeyFingerprint(apiSecret)
        });
      }
    } catch (error) {
      logger.warn('Error loading config for account credentials', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      // Fallback to default
      apiKey = process.env.BYBIT_API_KEY;
      apiSecret = process.env.BYBIT_API_SECRET;
      logger.info('Using default credentials (error fallback)', {
        apiKeyFingerprint: getApiKeyFingerprint(apiKey),
        apiSecretFingerprint: getApiKeyFingerprint(apiSecret)
      });
    }

    if (!apiKey || !apiSecret) {
      logger.error('Bybit API credentials not found', {
        accountName: accountNameToUse,
        tradeAccountName: trade.account_name,
        hasApiKey: !!apiKey,
        hasApiSecret: !!apiSecret
      });
      return;
    }

    logger.info('Final Bybit credentials summary', {
      accountName: accountNameToUse,
      testnet,
      demo,
      baseUrl: baseUrl || 'default',
      apiKeyFingerprint: getApiKeyFingerprint(apiKey),
      apiSecretFingerprint: getApiKeyFingerprint(apiSecret),
      apiKeyLength: apiKey?.length || 0,
      apiSecretLength: apiSecret?.length || 0,
      hasApiKey: !!apiKey,
      hasApiSecret: !!apiSecret
    });

    const bybitClient = new RestClientV5({ 
      key: apiKey, 
      secret: apiSecret, 
      testnet,
      ...(baseUrl && { baseUrl }) // Use demo endpoint if demo mode
    });

    const symbol = normalizeBybitSymbol(trade.trading_pair);
    
    // Comprehensive check for entry fill - try multiple methods like the monitor does
    let entryFilledConfirmed = false;
    
    // Method 1: Check for open position first (most reliable indicator)
    logger.info('Checking for open position', { symbol });
    let positions = await bybitClient.getPositionInfo({
      category: 'linear',
      symbol: symbol
    });

    let position: any = null;
    if (positions.retCode === 0 && positions.result && positions.result.list) {
      // If we have a position_id, try to find the specific position first
      if (trade.position_id) {
        position = positions.result.list.find((p: any) => {
          const positionIdx = getBybitField<string | number>(p, 'positionIdx', 'position_idx');
          return p.symbol === symbol && positionIdx?.toString() === trade.position_id;
        });
        
        if (position) {
          const size = parseFloat(getBybitField<string>(position, 'size') || '0');
          if (size !== 0) {
            logger.info('Found matching position by position_id - entry filled', {
              tradeId,
              symbol,
              positionId: trade.position_id,
              size: getBybitField<string>(position, 'size')
            });
            entryFilledConfirmed = true;
          } else {
            logger.info('Position found by position_id but size is zero (position closed)', {
              tradeId,
              symbol,
              positionId: trade.position_id
            });
            position = null; // Reset to null since position is closed
          }
        }
      }
      
      // If not found by position_id, find any position with non-zero size
      if (!position) {
        position = positions.result.list.find((p: any) => {
          const size = parseFloat(getBybitField<string>(p, 'size') || '0');
          return p.symbol === symbol && size !== 0;
        });
        
        if (position) {
          logger.info('Found open position - entry likely filled', {
            tradeId,
            symbol,
            size: getBybitField<string>(position, 'size'),
            positionIdx: getBybitField<string | number>(position, 'positionIdx', 'position_idx'),
            note: trade.position_id ? 'Position ID mismatch - using found position' : 'No position_id stored in trade'
          });
          entryFilledConfirmed = true;
        }
      }
    }
    
    // Method 2: Check order history if we have order_id and no position found yet
    if (!entryFilledConfirmed && trade.order_id) {
      logger.info('Checking order history to confirm entry fill', {
        orderId: trade.order_id,
        symbol
      });
      
      // Try by orderId first
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
            logger.info('Order history check (by orderId)', {
              orderId: trade.order_id,
              orderStatus,
              entryFilledConfirmed
            });
          }
        }
      } catch (error) {
        logger.debug('Error checking order history by orderId', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      
      // Try by orderLinkId if orderId didn't work
      if (!entryFilledConfirmed) {
        try {
          const orderHistoryByLink = await bybitClient.getHistoricOrders({
            category: 'linear',
            symbol: symbol,
            orderLinkId: trade.order_id,
            limit: 10
          });

          if (orderHistoryByLink.retCode === 0 && orderHistoryByLink.result && orderHistoryByLink.result.list) {
            const historicalOrder = orderHistoryByLink.result.list.find((o: any) => {
              const oLinkId = getBybitField<string>(o, 'orderLinkId', 'order_link_id');
              return oLinkId === trade.order_id;
            });
            
            if (historicalOrder) {
              const orderStatus = getBybitField<string>(historicalOrder, 'orderStatus', 'order_status');
              entryFilledConfirmed = orderStatus === 'Filled' || orderStatus === 'PartiallyFilled';
              logger.info('Order history check (by orderLinkId)', {
                orderLinkId: trade.order_id,
                orderStatus,
                entryFilledConfirmed
              });
            }
          }
        } catch (error) {
          logger.debug('Error checking order history by orderLinkId', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      // Try active orders as fallback
      if (!entryFilledConfirmed) {
        try {
          const activeOrders = await bybitClient.getActiveOrders({
            category: 'linear',
            symbol: symbol,
            orderId: trade.order_id
          });

          if (activeOrders.retCode === 0 && activeOrders.result && activeOrders.result.list) {
            const order = activeOrders.result.list.find((o: any) => {
              const oId = getBybitField<string>(o, 'orderId', 'order_id');
              return oId === trade.order_id;
            });
            
            if (order) {
              const orderStatus = getBybitField<string>(order, 'orderStatus', 'order_status');
              entryFilledConfirmed = orderStatus === 'Filled';
              logger.info('Active orders check', {
                orderId: trade.order_id,
                orderStatus,
                entryFilledConfirmed
              });
            }
          }
        } catch (error) {
          logger.debug('Error checking active orders', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      // Final fallback: search order history without filter
      if (!entryFilledConfirmed) {
        try {
          const orderHistory = await bybitClient.getHistoricOrders({
            category: 'linear',
            symbol: symbol,
            limit: 50
          });

          if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list) {
            const historicalOrder = orderHistory.result.list.find((o: any) => {
              const oId = getBybitField<string>(o, 'orderId', 'order_id');
              const oLinkId = getBybitField<string>(o, 'orderLinkId', 'order_link_id');
              return oId === trade.order_id || oLinkId === trade.order_id;
            });
            
            if (historicalOrder) {
              const orderStatus = getBybitField<string>(historicalOrder, 'orderStatus', 'order_status');
              entryFilledConfirmed = orderStatus === 'Filled' || orderStatus === 'PartiallyFilled';
              logger.info('Order history check (fallback search)', {
                orderId: trade.order_id,
                orderStatus,
                entryFilledConfirmed
              });
            }
          }
        } catch (error) {
          logger.debug('Error in fallback order search', {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    if (!position && !entryFilledConfirmed) {
      logger.warn('No open position found and entry fill not confirmed after comprehensive checks.', {
        tradeId,
        symbol,
        orderId: trade.order_id,
        note: 'Tried: positions, order history by orderId, order history by orderLinkId, active orders, and fallback search'
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
    
    // Use Bybit's side field directly if available (authoritative source)
    // Fall back to inferring from size only if side field is not available
    let positionSide: 'Buy' | 'Sell';
    if (position.side && (position.side === 'Buy' || position.side === 'Sell')) {
      positionSide = position.side as 'Buy' | 'Sell';
    } else {
      // Fallback: infer from size (for backward compatibility)
      positionSide = parseFloat(positionSizeStr) > 0 ? 'Buy' : 'Sell';
      logger.debug('Position side not available, inferred from size', {
        tradeId,
        inferredSide: positionSide,
        positionSize: positionSizeStr
      });
    }
    
    // TP side is always opposite of position side
    // For Long (Buy) position, TP is Sell
    // For Short (Sell) position, TP is Buy
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

// Get trade ID and optional account name from command line args
// Usage: tsx fix_trade_tps.ts <tradeId> [accountName]
// Example: tsx fix_trade_tps.ts 18 demo
const tradeId = process.argv[2] ? parseInt(process.argv[2], 10) : 13;
const accountName = process.argv[3]; // Optional account name (e.g., 'demo', 'main', etc.)

if (isNaN(tradeId)) {
  logger.error('Invalid trade ID', { provided: process.argv[2] });
  process.exit(1);
}

fixTradeTPs(tradeId, accountName).catch(error => {
  logger.error('Fatal error', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  process.exit(1);
});

