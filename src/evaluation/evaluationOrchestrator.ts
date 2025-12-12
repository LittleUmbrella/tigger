/**
 * Evaluation Orchestrator
 * 
 * Processes messages, simulates trades using historical price data,
 * and evaluates performance against prop firm rules.
 */

import { DatabaseManager, Trade, Message } from '../db/schema.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { parseMessage } from '../parsers/signalParser.js';
import { PropFirmEvaluator, EvaluationResult } from './propFirmEvaluator.js';
import { PropFirmRule, getPropFirmRule, createCustomPropFirmRule } from './propFirmRules.js';
import { logger } from '../utils/logger.js';
import { processUnparsedMessages } from '../initiators/signalInitiator.js';
import { startTradeMonitor } from '../monitors/tradeMonitor.js';
import { InitiatorConfig, ParserConfig, MonitorConfig } from '../types/config.js';
import { EvaluationConfig } from '../types/config.js';
import { EvaluationResultRecord } from '../db/schema.js';
import dayjs from 'dayjs';

export interface EvaluationRunResult {
  channel: string;
  propFirmResults: EvaluationResult[];
  startDate: string;
  endDate: string;
  totalTrades: number;
  totalMessages: number;
}

/**
 * Run evaluation for a channel
 */
export async function runEvaluation(
  db: DatabaseManager,
  config: EvaluationConfig,
  channel: string,
  parserName: string,
  initiatorConfig: InitiatorConfig,
  monitorConfig: MonitorConfig
): Promise<EvaluationRunResult> {
  logger.info('Starting evaluation', {
    channel,
    propFirms: config.propFirms.map(f => typeof f === 'string' ? f : f.name).join(', ')
  });

  // Initialize historical price provider
  const startDate = config.startDate || new Date().toISOString();
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;

  const priceProvider = new HistoricalPriceProvider(
    startDate,
    config.speedMultiplier || 0, // Use max speed by default
    apiKey,
    apiSecret
  );

  logger.info('Historical price provider initialized', {
    startDate,
    speedMultiplier: config.speedMultiplier || 0
  });

  // Get all messages for this channel, sorted chronologically
  const messages = await db.getUnparsedMessages(channel);
  const sortedMessages = [...messages].sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateA - dateB;
  });

  if (sortedMessages.length === 0) {
    logger.warn('No messages found for evaluation', { channel });
    return {
      channel,
      propFirmResults: [],
      startDate,
      endDate: new Date().toISOString(),
      totalTrades: 0,
      totalMessages: 0,
    };
  }

  logger.info('Processing messages for evaluation', {
    channel,
    messageCount: sortedMessages.length,
    firstMessage: sortedMessages[0].date,
    lastMessage: sortedMessages[sortedMessages.length - 1].date
  });

  // Process messages and create trades (similar to simulation mode)
  // First, parse all messages
  for (const message of sortedMessages) {
    try {
      const messageTime = dayjs(message.date);
      priceProvider.setCurrentTime(messageTime);

      const parsed = parseMessage(message.content, parserName);
      if (parsed) {
        await db.markMessageParsed(message.id);
        logger.debug('Parsed message in evaluation', {
          channel,
          messageId: message.message_id,
          tradingPair: parsed.tradingPair
        });
      } else {
        await db.markMessageParsed(message.id);
      }
    } catch (error) {
      logger.error('Error parsing message in evaluation', {
        channel,
        messageId: message.message_id,
        error: error instanceof Error ? error.message : String(error)
      });
      await db.markMessageParsed(message.id);
    }
  }

  // Process unparsed messages to initiate trades
  await processUnparsedMessages(
    initiatorConfig,
    channel,
    monitorConfig.entryTimeoutDays || 2,
    db,
    true, // isSimulation
    priceProvider,
    parserName
  );

  // Start trade monitor to close trades
  const stopMonitor = await startTradeMonitor(
    monitorConfig,
    channel,
    db,
    true, // isSimulation
    priceProvider,
    config.speedMultiplier || 0
  );

  // Wait for all trades to close (or timeout)
  const maxWaitTime = config.maxTradeDurationDays || 7;
  const startTime = Date.now();
  const maxWaitMs = maxWaitTime * 24 * 60 * 60 * 1000;

  while (Date.now() - startTime < maxWaitMs) {
    const activeTrades = await db.getActiveTrades();
    const channelActiveTrades = activeTrades.filter(t => t.channel === channel);

    if (channelActiveTrades.length === 0) {
      logger.info('All trades closed for evaluation', { channel });
      break;
    }

    // Advance time and check trades
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Stop monitor
  await stopMonitor();

  // Get all closed trades for this channel
  const allTrades = await db.getTradesByStatus('closed');
  const channelTrades = allTrades.filter(t => t.channel === channel);
  
  const stoppedTrades = await db.getTradesByStatus('stopped');
  const channelStoppedTrades = stoppedTrades.filter(t => t.channel === channel);

  const completedTrades = [...channelTrades, ...channelStoppedTrades];

  logger.info('Trades completed for evaluation', {
    channel,
    totalTrades: completedTrades.length,
    closed: channelTrades.length,
    stopped: channelStoppedTrades.length
  });

  // Evaluate against each prop firm
  const propFirmResults: EvaluationResult[] = [];

  for (const propFirmConfig of config.propFirms) {
    let rule: PropFirmRule | null = null;

    if (typeof propFirmConfig === 'string') {
      // Predefined prop firm
      rule = getPropFirmRule(propFirmConfig, {
        initialBalance: config.initialBalance || 10000
      });
    } else {
      // Custom prop firm configuration
      rule = createCustomPropFirmRule(
        propFirmConfig.name,
        propFirmConfig.displayName || propFirmConfig.name,
        {
          initialBalance: propFirmConfig.initialBalance || config.initialBalance || 10000,
          profitTarget: propFirmConfig.profitTarget,
          maxDrawdown: propFirmConfig.maxDrawdown,
          dailyDrawdown: propFirmConfig.dailyDrawdown,
          minTradingDays: propFirmConfig.minTradingDays,
          minTradesPerDay: propFirmConfig.minTradesPerDay,
          maxRiskPerTrade: propFirmConfig.maxRiskPerTrade,
          stopLossRequired: propFirmConfig.stopLossRequired,
          stopLossTimeLimit: propFirmConfig.stopLossTimeLimit,
          maxProfitPerDay: propFirmConfig.maxProfitPerDay,
          maxProfitPerTrade: propFirmConfig.maxProfitPerTrade,
          minTradeDuration: propFirmConfig.minTradeDuration,
          maxShortTradesPercentage: propFirmConfig.maxShortTradesPercentage,
          reverseTradingAllowed: propFirmConfig.reverseTradingAllowed,
          reverseTradingTimeLimit: propFirmConfig.reverseTradingTimeLimit,
          customRules: propFirmConfig.customRules,
        }
      );
    }

    if (!rule) {
      logger.error('Invalid prop firm configuration', {
        channel,
        propFirm: typeof propFirmConfig === 'string' ? propFirmConfig : propFirmConfig.name
      });
      continue;
    }

    // Create evaluator
    const evaluator = new PropFirmEvaluator(rule);

    // Add all trades to evaluator
    for (const trade of completedTrades) {
      evaluator.addTrade(trade);
    }

    // Update equity with open trades (if any)
    const openTrades = await db.getActiveTrades();
    const channelOpenTrades = openTrades.filter(t => t.channel === channel);
    
    // Calculate unrealized P&L for open trades
    let unrealizedPnL = 0;
    for (const trade of channelOpenTrades) {
      if (trade.entry_filled_at && trade.entry_price) {
        try {
          const currentPrice = await priceProvider.getCurrentPrice(trade.trading_pair);
          if (currentPrice) {
            const isLong = trade.entry_price < (trade.stop_loss || trade.entry_price);
            const priceDiff = isLong
              ? currentPrice - trade.entry_price
              : trade.entry_price - currentPrice;
            const pnlPercentage = (priceDiff / trade.entry_price) * 100;
            const positionSize = (rule.initialBalance * (trade.risk_percentage / 100)) / 
              Math.abs(trade.entry_price - (trade.stop_loss || trade.entry_price)) * trade.entry_price;
            unrealizedPnL += (priceDiff * positionSize);
          }
        } catch (error) {
          logger.warn('Failed to calculate unrealized P&L', {
            tradeId: trade.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
    evaluator.updateEquity(unrealizedPnL);

    // Run evaluation
    const result = evaluator.evaluate();
    propFirmResults.push(result);

    logger.info('Prop firm evaluation completed', {
      channel,
      propFirm: rule.displayName,
      passed: result.passed,
      violations: result.violations.length,
      totalPnL: result.metrics.totalPnL,
      totalPnLPercentage: result.metrics.totalPnLPercentage
    });

    // Save evaluation result to database
    await saveEvaluationResult(db, channel, result);
  }

  const endDate = completedTrades.length > 0
    ? completedTrades[completedTrades.length - 1].exit_filled_at || completedTrades[completedTrades.length - 1].created_at
    : new Date().toISOString();

  return {
    channel,
    propFirmResults,
    startDate,
    endDate,
    totalTrades: completedTrades.length,
    totalMessages: sortedMessages.length,
  };
}

/**
 * Save evaluation result to database
 */
async function saveEvaluationResult(
  db: DatabaseManager,
  channel: string,
  result: EvaluationResult
): Promise<void> {
  try {
    const dbResult: Omit<EvaluationResultRecord, 'id' | 'created_at'> = {
      channel,
      prop_firm_name: result.propFirmName,
      passed: result.passed,
      violations: JSON.stringify(result.violations),
      metrics: JSON.stringify(result.metrics),
      start_date: result.startDate,
      end_date: result.endDate,
    };

    await db.insertEvaluationResult(dbResult);
    logger.info('Evaluation result saved to database', {
      channel,
      propFirm: result.propFirmName,
      passed: result.passed
    });
  } catch (error) {
    logger.error('Failed to save evaluation result', {
      channel,
      propFirm: result.propFirmName,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

