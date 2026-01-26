/**
 * /analyze Command
 * 
 * Deep analysis of a specific trade:
 * 1. Get trade details from database
 * 2. Check order status on Bybit
 * 3. Review related logs
 * 4. Analyze execution
 * 
 * Usage: /analyze trade:<trade_id>
 */

import { CommandContext, CommandResult } from '../commandRegistry.js';
import { logger } from '../../utils/logger.js';
import { getBybitField } from '../../utils/bybitFieldHelper.js';
import { RestClientV5 } from 'bybit-api';
import fs from 'fs-extra';
import { BotConfig } from '../../types/config.js';

function normalizeBybitSymbol(tradingPair: string): string {
  let normalized = tradingPair.replace('/', '').toUpperCase();
  if (!normalized.endsWith('USDT') && !normalized.endsWith('USDC')) {
    normalized = `${normalized}USDT`;
  }
  return normalized;
}

async function getAccountCredentials(
  accountName: string | undefined,
  config: BotConfig | null
): Promise<{ apiKey: string | undefined; apiSecret: string | undefined; testnet: boolean; demo: boolean; baseUrl?: string }> {
  if (!config || !accountName) {
    return {
      apiKey: process.env.BYBIT_API_KEY,
      apiSecret: process.env.BYBIT_API_SECRET,
      testnet: process.env.BYBIT_TESTNET === 'true',
      demo: false
    };
  }

  const account = config.accounts?.find(acc => acc.name === accountName);
  if (!account) {
    return {
      apiKey: process.env.BYBIT_API_KEY,
      apiSecret: process.env.BYBIT_API_SECRET,
      testnet: process.env.BYBIT_TESTNET === 'true',
      demo: false
    };
  }

  const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
  const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
  const apiKey = envVarNameForKey ? process.env[envVarNameForKey] : (account.apiKey || process.env.BYBIT_API_KEY);
  const apiSecret = envVarNameForSecret ? process.env[envVarNameForSecret] : (account.apiSecret || process.env.BYBIT_API_SECRET);
  const testnet = account.testnet || false;
  const demo = account.demo || false;
  const baseUrl = demo ? 'https://api-demo.bybit.com' : undefined;

  return { apiKey, apiSecret, testnet, demo, baseUrl };
}

export async function analyzeCommandHandler(context: CommandContext): Promise<CommandResult> {
  const tradeId = context.args.trade;

  if (!tradeId) {
    return {
      success: false,
      message: 'Missing required argument: trade',
      error: 'Usage: /analyze trade:<trade_id>'
    };
  }

  try {
    const db = context.db;
    const trade = await db.getTradeWithMessage(
      typeof tradeId === 'number' ? tradeId : parseInt(String(tradeId))
    );

    if (!trade) {
      return {
        success: false,
        message: `Trade ${tradeId} not found in database`,
        error: 'Trade does not exist',
        recommendations: [
          'Verify trade ID is correct',
          'Check if trade was deleted',
          'Try: /trace message:<message_id> to find related trades'
        ]
      };
    }

    const findings: string[] = [];
    const recommendations: string[] = [];
    const analysis: Record<string, any> = {
      trade: {
        id: trade.id,
        status: trade.status,
        tradingPair: trade.trading_pair,
        accountName: trade.account_name,
        orderId: trade.order_id,
        positionId: trade.position_id,
        createdAt: trade.created_at
      }
    };

    // Check order status on Bybit
    if (trade.order_id) {
      findings.push(`Order ID: ${trade.order_id}`);

      // Load config for credentials
      const configPath = process.env.CONFIG_PATH || 'config.json';
      let config: BotConfig | null = null;
      if (fs.existsSync(configPath)) {
        try {
          const configContent = await fs.readFile(configPath, 'utf-8');
          config = JSON.parse(configContent);
        } catch (error) {
          logger.warn('Failed to load config', { error });
        }
      }

      const credentials = await getAccountCredentials(trade.account_name, config);
      
      if (credentials.apiKey && credentials.apiSecret) {
        const bybitClient = new RestClientV5({
          key: credentials.apiKey,
          secret: credentials.apiSecret,
          testnet: credentials.testnet,
          ...(credentials.baseUrl && { baseUrl: credentials.baseUrl })
        });

        const symbol = normalizeBybitSymbol(trade.trading_pair);

        // Check active orders
        try {
          const activeOrders = await bybitClient.getActiveOrders({
            category: 'linear',
            symbol: symbol,
            orderId: trade.order_id
          });

          if (activeOrders.retCode === 0 && activeOrders.result?.list && activeOrders.result.list.length > 0) {
            const order = activeOrders.result.list[0];
            findings.push(`✅ Order found in active orders`);
            analysis.order = {
              status: getBybitField<string>(order, 'orderStatus', 'order_status'),
              type: order.orderType,
              price: order.price,
              qty: order.qty,
              cumExecQty: getBybitField<string>(order, 'cumExecQty', 'cum_exec_qty'),
              avgPrice: getBybitField<string>(order, 'avgPrice', 'avg_price')
            };
          } else {
            // Check order history
            const orderHistory = await bybitClient.getHistoricOrders({
              category: 'linear',
              symbol: symbol,
              orderId: trade.order_id,
              limit: 10
            });

            if (orderHistory.retCode === 0 && orderHistory.result?.list && orderHistory.result.list.length > 0) {
              const order = orderHistory.result.list[0];
              findings.push(`✅ Order found in order history`);
              analysis.order = {
                status: getBybitField<string>(order, 'orderStatus', 'order_status'),
                type: order.orderType,
                avgPrice: getBybitField<string>(order, 'avgPrice', 'avg_price'),
                cumExecQty: getBybitField<string>(order, 'cumExecQty', 'cum_exec_qty')
              };
            } else {
              findings.push(`❌ Order not found on Bybit exchange`);
              recommendations.push('Order was never created or was immediately cancelled');
              recommendations.push('Check initiator logs for API errors');
            }
          }
        } catch (error) {
          findings.push(`⚠️ Error checking order on Bybit: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        findings.push('⚠️ Cannot verify order - Bybit credentials not available');
      }
    } else {
      findings.push('❌ No order ID stored in database');
      recommendations.push('Entry order was never created');
      recommendations.push('Check initiator logs for errors');
    }

    // Check TP/SL orders
    const orders = await db.getOrdersByTradeId(trade.id);
    if (orders.length > 0) {
      findings.push(`Found ${orders.length} TP/SL orders`);
      analysis.orders = orders.map(o => ({
        type: o.order_type,
        orderId: o.order_id,
        status: o.status,
        price: o.price,
        tpIndex: o.tp_index
      }));
    } else {
      findings.push('No TP/SL orders found');
    }

    return {
      success: true,
      message: `Analysis complete for trade ${tradeId}`,
      data: analysis,
      recommendations,
      nextSteps: [
        '/check-logs message:' + trade.message_id + ' timeframe:10',
        '/trace message:' + trade.message_id + ' channel:' + trade.channel
      ]
    };
  } catch (error) {
    logger.error('Error in analyze command', {
      tradeId,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      success: false,
      message: 'Failed to analyze trade',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

