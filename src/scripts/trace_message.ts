#!/usr/bin/env tsx
/**
 * Trace Message Script
 * 
 * Traces a message ID through the entire flow:
 * 1. Message receipt and storage
 * 2. Parsing (success/failure)
 * 3. Trade creation (success/failure)
 * 4. Order creation on Bybit (success/failure)
 * 5. Order execution status
 * 
 * Identifies failure points, especially where orders failed to be created.
 * 
 * Usage: npm run trace-message <message_id> [channel]
 */

import { DatabaseManager, Message, Trade, Order } from '../db/schema.js';
import { RestClientV5 } from 'bybit-api';
import { logger } from '../utils/logger.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import { BotConfig, AccountConfig } from '../types/config.js';
import fs from 'fs-extra';
import dotenv from 'dotenv';
import { parseMessage } from '../parsers/signalParser.js';
import dayjs from 'dayjs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env-investigation first, then fall back to .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Try .env-investigation first, then .env
const envInvestigationPath = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');

// Load .env-investigation if it exists, otherwise load .env
if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
  logger.info('Loaded environment variables from .env-investigation');
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  logger.info('Loaded environment variables from .env');
} else {
  dotenv.config(); // Fallback to default behavior
}

interface TraceStep {
  step: string;
  status: 'success' | 'failure' | 'skipped' | 'unknown';
  timestamp?: string;
  details: Record<string, any>;
  error?: string;
}

interface TraceResult {
  messageId: string;
  channel: string;
  steps: TraceStep[];
  failurePoint?: string;
  recommendations: string[];
}

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

/**
 * Get account credentials for a trade
 */
const getAccountCredentials = async (
  accountName: string | undefined,
  config: BotConfig | null
): Promise<{ apiKey: string | undefined; apiSecret: string | undefined; testnet: boolean; demo: boolean; baseUrl?: string }> => {
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
};

/**
 * Generate Loggly search query for a message ID
 * Returns search query string and URL for manual checking
 */
const getLogglySearchInfo = (messageId: string, channel: string, timeRange: { start: string; end: string }): { query: string; url: string } => {
  const subdomain = process.env.LOGGLY_SUBDOMAIN || 'your-subdomain';
  const query = `messageId:${messageId} AND channel:${channel}`;
  const url = `https://${subdomain}.loggly.com/search?q=${encodeURIComponent(query)}&from=${timeRange.start}&until=${timeRange.end}`;
  return { query, url };
};

/**
 * Trace a message through the entire system
 */
export const traceMessage = async (messageId: string, channel?: string): Promise<TraceResult> => {
  const steps: TraceStep[] = [];
  const recommendations: string[] = [];

  // Initialize database
  const db = new DatabaseManager();
  await db.initialize();

  // Load config to get parser name for channel
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

  try {
    // Step 1: Find message in database
    steps.push({
      step: '1. Message Storage',
      status: 'unknown',
      details: { messageId, channel }
    });

    let message: Message | null = null;
    
    logger.debug('traceMessage - querying database', {
      messageId,
      channel,
      messageIdType: typeof messageId,
      channelType: typeof channel
    });
    
    if (channel) {
      message = await db.getMessageByMessageId(messageId, channel);
      logger.debug('traceMessage - query result', {
        messageId,
        channel,
        found: !!message,
        messageDbId: message?.id
      });
    } else {
      // Search all channels
      const channels = ['2394142145', '3241720654', '2427485240']; // Add more as needed
      logger.debug('traceMessage - searching all channels', {
        messageId,
        channelsToSearch: channels
      });
      for (const ch of channels) {
        message = await db.getMessageByMessageId(messageId, ch);
        if (message) {
          channel = ch;
          logger.debug('traceMessage - found in channel', { channel: ch });
          break;
        }
      }
    }

    if (!message) {
      logger.warn('traceMessage - message not found', {
        messageId,
        channel: channel || 'none',
        searchedChannels: channel ? [channel] : ['2394142145', '3241720654', '2427485240']
      });
      steps[0].status = 'failure';
      steps[0].error = 'Message not found in database';
      recommendations.push('Check if message was harvested from Telegram/Discord');
      return {
        messageId,
        channel: channel || 'unknown',
        steps,
        failurePoint: 'Message Storage',
        recommendations
      };
    }

    steps[0].status = 'success';
    steps[0].timestamp = message.created_at;
    steps[0].details = {
      ...steps[0].details,
      content: message.content.substring(0, 100) + '...',
      sender: message.sender,
      date: message.date,
      parsed: message.parsed,
      analyzed: message.analyzed
    };

    // Step 2: Check if message was parsed
    steps.push({
      step: '2. Message Parsing',
      status: message.parsed ? 'success' : 'failure',
      timestamp: message.date,
      details: {}
    });

    // Get parser name from config for this channel
    let parserName: string | undefined;
    if (config && channel) {
      const channelConfig = config.channels?.find(ch => ch.channel === channel);
      if (channelConfig?.parser) {
        parserName = channelConfig.parser;
      }
    }

    const parsedOrder = parseMessage(message.content, parserName);
    if (parsedOrder) {
      steps[1].status = 'success';
      steps[1].details = {
        tradingPair: parsedOrder.tradingPair,
        signalType: parsedOrder.signalType,
        entryPrice: parsedOrder.entryPrice,
        stopLoss: parsedOrder.stopLoss,
        takeProfits: parsedOrder.takeProfits,
        leverage: parsedOrder.leverage
      };
    } else {
      steps[1].status = 'failure';
      steps[1].error = 'Message could not be parsed into a trade signal';
      recommendations.push('Check parser configuration for this channel');
      recommendations.push('Message may not be a trade signal (could be management command or unrelated message)');
      return {
        messageId,
        channel: channel || 'unknown',
        steps,
        failurePoint: 'Message Parsing',
        recommendations
      };
    }

    // Step 3: Check if trade was created
    steps.push({
      step: '3. Trade Creation',
      status: 'unknown',
      details: {}
    });

    const trades = await db.getTradesByMessageId(messageId, channel || 'unknown');
    if (trades.length === 0) {
      steps[2].status = 'failure';
      steps[2].error = 'No trade created for this message';
      recommendations.push('Check initiator logs for errors');
      recommendations.push('Check if message was marked as parsed before trade creation');
      recommendations.push('Verify initiator configuration is correct');
      return {
        messageId,
        channel: channel || 'unknown',
        steps,
        failurePoint: 'Trade Creation',
        recommendations
      };
    }

    steps[2].status = 'success';
    steps[2].details = {
      tradeCount: trades.length,
      trades: trades.map(t => ({
        id: t.id,
        status: t.status,
        tradingPair: t.trading_pair,
        accountName: t.account_name,
        orderId: t.order_id,
        positionId: t.position_id,
        createdAt: t.created_at
      }))
    };

    // Step 4: Check order creation for each trade
    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i];
      const stepIndex = 3 + i * 2; // Step 4, 6, 8, etc. for entry orders
      const tpStepIndex = stepIndex + 1; // Step 5, 7, 9, etc. for TP orders

      // Step 4.x: Entry order creation
      steps.push({
        step: `${stepIndex}. Trade ${i + 1} - Entry Order Creation`,
        status: 'unknown',
        timestamp: trade.created_at,
        details: {
          tradeId: trade.id,
          accountName: trade.account_name,
          tradingPair: trade.trading_pair,
          orderId: trade.order_id,
          status: trade.status
        }
      });

      if (!trade.order_id) {
        steps[stepIndex].status = 'failure';
        steps[stepIndex].error = 'No entry order ID stored in database';
        recommendations.push(`Trade ${i + 1}: Entry order was never created or order ID was not saved`);
        recommendations.push(`Check initiator logs around ${trade.created_at} for errors`);
        continue;
      }

      steps[stepIndex].status = 'success';
      steps[stepIndex].details = {
        ...steps[stepIndex].details,
        entryOrderType: trade.entry_order_type,
        entryPrice: trade.entry_price,
        quantity: trade.quantity,
        entryFilledAt: trade.entry_filled_at
      };

      // Step 4.x+1: Check entry order on Bybit
      steps.push({
        step: `${tpStepIndex}. Trade ${i + 1} - Entry Order on Bybit`,
        status: 'unknown',
        details: {
          orderId: trade.order_id,
          symbol: normalizeBybitSymbol(trade.trading_pair)
        }
      });

      // Load config to get account credentials
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
      if (!credentials.apiKey || !credentials.apiSecret) {
        steps[tpStepIndex].status = 'failure';
        steps[tpStepIndex].error = 'Bybit API credentials not found';
        recommendations.push(`Trade ${i + 1}: Cannot verify order on Bybit - missing credentials`);
        continue;
      }

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
          steps[tpStepIndex].status = 'success';
          steps[tpStepIndex].details = {
            ...steps[tpStepIndex].details,
            foundIn: 'active_orders',
            orderStatus: getBybitField<string>(order, 'orderStatus', 'order_status'),
            orderType: order.orderType,
            price: order.price,
            qty: order.qty,
            cumExecQty: getBybitField<string>(order, 'cumExecQty', 'cum_exec_qty'),
            avgPrice: getBybitField<string>(order, 'avgPrice', 'avg_price')
          };
          continue;
        }
      } catch (error) {
        logger.warn('Error checking active orders', { error });
      }

      // Check order history
      try {
        const orderHistory = await bybitClient.getHistoricOrders({
          category: 'linear',
          symbol: symbol,
          orderId: trade.order_id,
          limit: 10
        });

        if (orderHistory.retCode === 0 && orderHistory.result?.list && orderHistory.result.list.length > 0) {
          const order = orderHistory.result.list[0];
          steps[tpStepIndex].status = 'success';
          steps[tpStepIndex].details = {
            ...steps[tpStepIndex].details,
            foundIn: 'order_history',
            orderStatus: getBybitField<string>(order, 'orderStatus', 'order_status'),
            orderType: order.orderType,
            avgPrice: getBybitField<string>(order, 'avgPrice', 'avg_price'),
            cumExecQty: getBybitField<string>(order, 'cumExecQty', 'cum_exec_qty'),
            filledAt: getBybitField<string>(order, 'createdTime', 'created_time')
          };
          continue;
        }
      } catch (error) {
        logger.warn('Error checking order history', { error });
      }

      // Order not found on Bybit
      steps[tpStepIndex].status = 'failure';
      steps[tpStepIndex].error = 'Order not found on Bybit exchange';
      recommendations.push(`Trade ${i + 1}: Entry order ${trade.order_id} was never created on Bybit`);
      recommendations.push(`Check initiator logs for API errors when creating order`);
      recommendations.push(`Verify Bybit API credentials are correct for account: ${trade.account_name || 'default'}`);

      // Step 4.x+2: Check TP/SL orders
      const orders = await db.getOrdersByTradeId(trade.id);
      if (orders.length > 0) {
        const stepIndexTP = tpStepIndex + 1;
        steps.push({
          step: `${stepIndexTP}. Trade ${i + 1} - TP/SL Orders`,
          status: 'unknown',
          details: {
            orderCount: orders.length,
            orders: orders.map(o => ({
              type: o.order_type,
              orderId: o.order_id,
              status: o.status,
              price: o.price,
              tpIndex: o.tp_index
            }))
          }
        });

        let allTPOrdersFound = true;
        for (const order of orders) {
          if (!order.order_id) {
            allTPOrdersFound = false;
            recommendations.push(`Trade ${i + 1}: ${order.order_type} order (TP ${order.tp_index || 'N/A'}) was never created`);
            continue;
          }

          try {
            const orderHistory = await bybitClient.getHistoricOrders({
              category: 'linear',
              symbol: symbol,
              orderId: order.order_id,
              limit: 10
            });

            if (orderHistory.retCode !== 0 || !orderHistory.result?.list || orderHistory.result.list.length === 0) {
              allTPOrdersFound = false;
              recommendations.push(`Trade ${i + 1}: ${order.order_type} order ${order.order_id} not found on Bybit`);
            }
          } catch (error) {
            allTPOrdersFound = false;
            recommendations.push(`Trade ${i + 1}: Error checking ${order.order_type} order ${order.order_id}`);
          }
        }

        steps[stepIndexTP].status = allTPOrdersFound ? 'success' : 'failure';
      }
    }

    // Determine failure point
    const failureStep = steps.find(s => s.status === 'failure');
    const failurePoint = failureStep ? failureStep.step : undefined;

    return {
      messageId,
      channel: channel || 'unknown',
      steps,
      failurePoint,
      recommendations
    };
  } catch (error) {
    logger.error('Error tracing message', {
      messageId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    await db.close();
  }
};

/**
 * Print trace results in a readable format
 */
const printTraceResults = (result: TraceResult): void => {
  console.log('\n' + '='.repeat(80));
  console.log(`TRACE RESULTS FOR MESSAGE ID: ${result.messageId}`);
  console.log(`Channel: ${result.channel}`);
  console.log('='.repeat(80) + '\n');

  for (const step of result.steps) {
    const statusIcon = {
      success: '✅',
      failure: '❌',
      skipped: '⏭️',
      unknown: '❓'
    }[step.status];

    console.log(`${statusIcon} ${step.step}`);
    if (step.timestamp) {
      console.log(`   Timestamp: ${step.timestamp}`);
    }
    if (step.error) {
      console.log(`   Error: ${step.error}`);
    }
    if (Object.keys(step.details).length > 0) {
      console.log(`   Details:`, JSON.stringify(step.details, null, 2));
    }
    console.log('');
  }

  if (result.failurePoint) {
    console.log('🔴 FAILURE POINT:', result.failurePoint);
    console.log('');
  }

  if (result.recommendations.length > 0) {
    console.log('💡 RECOMMENDATIONS:');
    result.recommendations.forEach((rec, i) => {
      console.log(`   ${i + 1}. ${rec}`);
    });
    console.log('');
  }

  console.log('='.repeat(80));
  
  // Generate Loggly search info
  const startTime = result.steps[0]?.timestamp || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const endTime = new Date().toISOString();
  const logglyInfo = getLogglySearchInfo(result.messageId, result.channel, { start: startTime, end: endTime });
  
  console.log('\n📋 LOGGLY SEARCH:');
  console.log(`  Query: ${logglyInfo.query}`);
  console.log(`  URL: ${logglyInfo.url}`);
  console.log(`  Time range: ${startTime} to ${endTime}`);
  console.log('\n💡 TIPS:');
  console.log('  - Check Loggly for detailed error logs around the failure point');
  console.log('  - Look for Bybit API responses in logs');
  console.log('  - Search for "Error initiating trade" or "Failed to create order"');
  console.log('  - Check account credentials and API permissions\n');
};

// Main execution - only run if this file is executed directly
const isMainModule = process.argv[1] && (process.argv[1].endsWith('trace_message.ts') || process.argv[1].endsWith('trace_message.js') || __filename === process.argv[1]);

if (isMainModule) {
  const messageId = process.argv[2] || null;
  const channel = process.argv[3];
  const outputFormat = process.argv[4] === '--json' ? 'json' : 'text';

  if (!messageId) {
    console.error('Usage: npm run trace-message <message_id> [channel] [--json]');
    console.error('Example: npm run trace-message 12345 2394142145');
    console.error('Example: npm run trace-message 12345 2394142145 --json');
    process.exit(1);
  }

  traceMessage(String(messageId), channel)
    .then(result => {
      if (outputFormat === 'json') {
        // Output JSON for use with custom prompts
        console.log(JSON.stringify(result, null, 2));
      } else {
        // Output human-readable format
        printTraceResults(result);
      }
      
      // Exit with error code if failure detected
      if (result.failurePoint) {
        process.exit(1);
      }
    })
    .catch(error => {
      logger.error('Fatal error tracing message', {
        messageId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      process.exit(1);
    });
}

