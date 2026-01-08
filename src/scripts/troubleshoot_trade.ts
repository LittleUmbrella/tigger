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
import { BotConfig, AccountConfig } from '../types/config.js';
import fs from 'fs-extra';
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

    // Initialize Bybit client - use account-specific credentials if available
    let apiKey: string | undefined;
    let apiSecret: string | undefined;
    let testnet = process.env.BYBIT_TESTNET === 'true';
    let demo = false;
    let baseUrl: string | undefined;

    // Use "demo" account instead of trade.account_name
    const accountNameToUse = 'demo';
    logger.info('Using account for troubleshooting', {
      requestedAccount: accountNameToUse,
      tradeAccountName: trade.account_name,
      note: 'Using demo account instead of trade account for troubleshooting'
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
        accountName: trade.account_name,
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
    logger.info('Checking Bybit for symbol', { symbol, originalTradingPair: trade.trading_pair });

    // 1. Query active order directly by orderId
    logger.info('=== Step 1: Query Active Order by orderId ===');
    if (trade.order_id) {
      try {
        const activeOrders = await bybitClient.getActiveOrders({
          category: 'linear',
          symbol: symbol,
          orderId: trade.order_id
        });
        
        logger.info('Active orders response', {
          retCode: activeOrders.retCode,
          retMsg: activeOrders.retMsg,
          hasResult: !!activeOrders.result,
          hasList: !!(activeOrders.result && activeOrders.result.list),
          listLength: activeOrders.result?.list?.length || 0
        });

        if (activeOrders.retCode === 0 && activeOrders.result && activeOrders.result.list && activeOrders.result.list.length > 0) {
          const matchingOrder = activeOrders.result.list.find((o: any) => 
            getBybitField<string>(o, 'orderId', 'order_id') === trade.order_id
          );
          
          if (matchingOrder) {
            const orderStatus = getBybitField<string>(matchingOrder, 'orderStatus', 'order_status');
            logger.info('✅ Order found in active orders', {
              orderId: trade.order_id,
              orderStatus,
              orderType: matchingOrder.orderType,
              price: matchingOrder.price,
              qty: matchingOrder.qty
            });
          } else {
            logger.info('Order not found in active orders (query returned results but no match)', {
              orderId: trade.order_id,
              returnedOrders: activeOrders.result.list.length
            });
          }
        } else {
          logger.info('Order not found in active orders (empty result)', {
            orderId: trade.order_id
          });
        }
      } catch (error) {
        logger.error('Error querying active orders', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 2. Query order history directly by orderId
    logger.info('=== Step 2: Query Order History by orderId ===');
    if (trade.order_id) {
      try {
        const orderHistory = await bybitClient.getHistoricOrders({
          category: 'linear',
          symbol: symbol,
          orderId: trade.order_id,
          limit: 10
        });

        logger.info('Order history response (by orderId)', {
          retCode: orderHistory.retCode,
          retMsg: orderHistory.retMsg,
          hasResult: !!orderHistory.result,
          hasList: !!(orderHistory.result && orderHistory.result.list),
          listLength: orderHistory.result?.list?.length || 0
        });

        if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list && orderHistory.result.list.length > 0) {
          const matchingOrder = orderHistory.result.list.find((o: any) => {
            const oId = getBybitField<string>(o, 'orderId', 'order_id');
            return oId === trade.order_id;
          });
          
          if (matchingOrder) {
            const orderStatus = getBybitField<string>(matchingOrder, 'orderStatus', 'order_status');
            logger.info('✅ Order found in order history by orderId', {
              orderId: trade.order_id,
              orderStatus,
              avgPrice: getBybitField<string>(matchingOrder, 'avgPrice', 'avg_price'),
              cumExecQty: getBybitField<string>(matchingOrder, 'cumExecQty', 'cum_exec_qty'),
              orderType: matchingOrder.orderType,
              side: matchingOrder.side
            });
          } else {
            logger.info('Order not found in order history by orderId (query returned results but no match)', {
              orderId: trade.order_id,
              returnedOrders: orderHistory.result.list.length
            });
          }
        } else {
          logger.info('Order not found in order history by orderId (empty result)', {
            orderId: trade.order_id
          });
        }
      } catch (error) {
        logger.error('Error querying order history by orderId', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 3. Query order history by orderLinkId (in case stored ID is actually a link ID)
    logger.info('=== Step 3: Query Order History by orderLinkId ===');
    if (trade.order_id) {
      try {
        const orderHistoryByLink = await bybitClient.getHistoricOrders({
          category: 'linear',
          symbol: symbol,
          orderLinkId: trade.order_id,
          limit: 10
        });

        logger.info('Order history response (by orderLinkId)', {
          retCode: orderHistoryByLink.retCode,
          retMsg: orderHistoryByLink.retMsg,
          hasResult: !!orderHistoryByLink.result,
          hasList: !!(orderHistoryByLink.result && orderHistoryByLink.result.list),
          listLength: orderHistoryByLink.result?.list?.length || 0
        });

        if (orderHistoryByLink.retCode === 0 && orderHistoryByLink.result && orderHistoryByLink.result.list && orderHistoryByLink.result.list.length > 0) {
          const matchingOrder = orderHistoryByLink.result.list.find((o: any) => {
            const oLinkId = getBybitField<string>(o, 'orderLinkId', 'order_link_id');
            return oLinkId === trade.order_id;
          });
          
          if (matchingOrder) {
            const orderStatus = getBybitField<string>(matchingOrder, 'orderStatus', 'order_status');
            logger.info('✅ Order found in order history by orderLinkId', {
              orderLinkId: trade.order_id,
              orderId: getBybitField<string>(matchingOrder, 'orderId', 'order_id'),
              orderStatus,
              avgPrice: getBybitField<string>(matchingOrder, 'avgPrice', 'avg_price'),
              cumExecQty: getBybitField<string>(matchingOrder, 'cumExecQty', 'cum_exec_qty'),
              orderType: matchingOrder.orderType,
              side: matchingOrder.side
            });
          } else {
            logger.info('Order not found in order history by orderLinkId (query returned results but no match)', {
              orderLinkId: trade.order_id,
              returnedOrders: orderHistoryByLink.result.list.length
            });
          }
        } else {
          logger.info('Order not found in order history by orderLinkId (empty result)', {
            orderLinkId: trade.order_id
          });
        }
      } catch (error) {
        logger.error('Error querying order history by orderLinkId', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 4. Fallback: Search order history without filter
    logger.info('=== Step 4: Fallback - Search Order History ===');
    if (trade.order_id) {
      try {
        const orderHistory = await bybitClient.getHistoricOrders({
          category: 'linear',
          symbol: symbol,
          limit: 50
        });

        logger.info('Order history response (fallback search)', {
          retCode: orderHistory.retCode,
          retMsg: orderHistory.retMsg,
          hasResult: !!orderHistory.result,
          hasList: !!(orderHistory.result && orderHistory.result.list),
          listLength: orderHistory.result?.list?.length || 0
        });

        if (orderHistory.retCode === 0 && orderHistory.result && orderHistory.result.list) {
          const matchingOrder = orderHistory.result.list.find((o: any) => {
            const oId = getBybitField<string>(o, 'orderId', 'order_id');
            const oLinkId = getBybitField<string>(o, 'orderLinkId', 'order_link_id');
            return oId === trade.order_id || oLinkId === trade.order_id;
          });
          
          if (matchingOrder) {
            const orderStatus = getBybitField<string>(matchingOrder, 'orderStatus', 'order_status');
            const matchedById = getBybitField<string>(matchingOrder, 'orderId', 'order_id') === trade.order_id;
            const matchedByLinkId = getBybitField<string>(matchingOrder, 'orderLinkId', 'order_link_id') === trade.order_id;
            logger.info('✅ Order found via fallback search', {
              orderId: trade.order_id,
              orderStatus,
              matchedById,
              matchedByLinkId,
              avgPrice: getBybitField<string>(matchingOrder, 'avgPrice', 'avg_price'),
              cumExecQty: getBybitField<string>(matchingOrder, 'cumExecQty', 'cum_exec_qty')
            });
          } else {
            logger.warn('❌ Order not found in order history (searched all methods)', { 
              orderId: trade.order_id,
              searchedOrders: orderHistory.result.list.length,
              note: 'Tried: active orders by orderId, history by orderId, history by orderLinkId, and fallback search'
            });
          }
        }
      } catch (error) {
        logger.error('Error in fallback order search', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 5. Check positions
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

    // 6. Check current price
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

