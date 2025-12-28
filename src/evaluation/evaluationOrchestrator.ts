/**
 * Evaluation Orchestrator
 * 
 * Processes messages, simulates trades using historical price data,
 * and evaluates performance against prop firm rules.
 */

import { DatabaseManager, Trade, Message } from '../db/schema.js';
import { createHistoricalPriceProvider, HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { parseMessage } from '../parsers/signalParser.js';
import { createPropFirmEvaluator, PropFirmEvaluator, EvaluationResult } from './propFirmEvaluator.js';
import { PropFirmRule, getPropFirmRule, createCustomPropFirmRule } from './propFirmRules.js';
import { logger } from '../utils/logger.js';
import { processUnparsedMessages } from '../initiators/signalInitiator.js';
import { InitiatorConfig, ParserConfig, MonitorConfig } from '../types/config.js';
import { EvaluationConfig } from '../types/config.js';
import { EvaluationResultRecord } from '../db/schema.js';
import { createMockExchange } from './mockExchange.js';
import { createBybitPublicRateLimiter } from '../utils/rateLimiter.js';
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

  // Initialize historical price provider with shared rate limiter
  // This ensures all parallel mock exchanges share the same rate limit tracking
  // Normalize startDate to ISO format if provided
  let startDate: string;
  if (config.startDate) {
    // Parse and normalize the start date to ISO format
    const parsedDate = dayjs(config.startDate);
    if (!parsedDate.isValid()) {
      throw new Error(`Invalid start date format: ${config.startDate}. Expected YYYY-MM-DD or ISO format.`);
    }
    startDate = parsedDate.startOf('day').toISOString();
  } else {
    startDate = new Date().toISOString();
  }

  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  const sharedRateLimiter = createBybitPublicRateLimiter();

  const priceProvider = createHistoricalPriceProvider(
    startDate,
    config.speedMultiplier || 0, // Use max speed by default
    apiKey,
    apiSecret,
    sharedRateLimiter
  );

  logger.info('Historical price provider initialized', {
    startDate,
    speedMultiplier: config.speedMultiplier || 0
  });

  // Get all messages for this channel (including parsed ones for evaluation)
  // In evaluation mode, we want to process all messages, not just unparsed ones
  const messages = await db.getMessagesByChannel(channel);
  const sortedMessages = [...messages].sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    return dateA - dateB;
  });

  // Filter messages by startDate if provided
  const startDateObj = dayjs(startDate);
  const filteredMessages = config.startDate
    ? sortedMessages.filter(msg => {
        const msgDate = dayjs(msg.date);
        // Include messages on or after startDate (same day or later)
        return msgDate.isAfter(startDateObj, 'day') || msgDate.isSame(startDateObj, 'day');
      })
    : sortedMessages;

  if (filteredMessages.length === 0) {
    logger.warn('No messages found for evaluation after filtering by start date', { 
      channel,
      startDate,
      totalMessagesBeforeFilter: sortedMessages.length
    });
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
    messageCount: filteredMessages.length,
    totalMessagesBeforeFilter: sortedMessages.length,
    startDate: config.startDate || 'not set',
    firstMessage: filteredMessages[0].date,
    lastMessage: filteredMessages[filteredMessages.length - 1].date
  });

  // Process unparsed messages to initiate trades
  // Pass startDate to filter messages during processing
  await processUnparsedMessages(
    initiatorConfig,
    channel,
    monitorConfig.entryTimeoutDays || 2,
    db,
    true, // isSimulation
    priceProvider,
    parserName,
    undefined, // accounts
    config.startDate ? startDate : undefined // startDate filter
  );

  // Get all trades for this channel that need simulation
  const pendingTrades = await db.getTradesByStatus('pending');
  const activeTrades = await db.getTradesByStatus('active');
  const allTradesToSimulate = [...pendingTrades, ...activeTrades].filter(t => t.channel === channel);

  logger.info('Starting trade simulation with mock exchanges', {
    channel,
    tradeCount: allTradesToSimulate.length
  });

  // Create and process mock exchanges for each trade
  const maxDurationDays = config.maxTradeDurationDays || 7;
  const mockExchanges = allTradesToSimulate.map(trade => ({
    trade,
    exchange: createMockExchange(trade, db, priceProvider, monitorConfig.breakevenAfterTPs ?? 1)
  }));

  // Initialize all mock exchanges (fetch price history)
  const initStartTime = Date.now();
  logger.info('Initializing mock exchanges (fetching price history)', {
    channel,
    totalTrades: mockExchanges.length
  });

  for (let i = 0; i < mockExchanges.length; i++) {
    const { trade, exchange } = mockExchanges[i];
    const progress = i + 1;
    const progressPercent = Math.round((progress / mockExchanges.length) * 100);
    
    try {
      logger.info('Initializing mock exchange', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        progress: `${progress}/${mockExchanges.length}`,
        progressPercent: `${progressPercent}%`,
        tradeCreatedAt: trade.created_at
      });
      
      await exchange.initialize(maxDurationDays);
      
      // Log progress every 10 trades or at milestones
      if (progress % 10 === 0 || progress === mockExchanges.length) {
        const elapsed = Date.now() - initStartTime;
        const avgTimePerTrade = elapsed / progress;
        const estimatedRemaining = avgTimePerTrade * (mockExchanges.length - progress);
        
        logger.info('Initialization progress', {
          channel,
          completed: progress,
          total: mockExchanges.length,
          progressPercent: `${progressPercent}%`,
          elapsedSeconds: Math.round(elapsed / 1000),
          estimatedRemainingSeconds: Math.round(estimatedRemaining / 1000)
        });
      }
    } catch (error) {
      logger.error('Failed to initialize mock exchange', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        progress: `${progress}/${mockExchanges.length}`,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const initElapsed = Date.now() - initStartTime;
  logger.info('All mock exchanges initialized', {
    channel,
    totalTrades: mockExchanges.length,
    elapsedSeconds: Math.round(initElapsed / 1000)
  });

  // Process all trades - they can run in parallel since each has its own price history
  // Each mock exchange processes its entire price history in one call
  const processStartTime = Date.now();
  logger.info('Processing trades with mock exchanges', {
    channel,
    totalTrades: mockExchanges.length
  });

  const processPromises = mockExchanges.map(async ({ trade, exchange }, index) => {
    try {
      const progress = index + 1;
      const progressPercent = Math.round((progress / mockExchanges.length) * 100);
      
      logger.debug('Processing mock exchange', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        progress: `${progress}/${mockExchanges.length}`,
        progressPercent: `${progressPercent}%`
      });
      
      const result = await exchange.process();
      
      // Log progress every 50 trades or at milestones
      if (progress % 50 === 0 || progress === mockExchanges.length) {
        const elapsed = Date.now() - processStartTime;
        const avgTimePerTrade = elapsed / progress;
        const estimatedRemaining = avgTimePerTrade * (mockExchanges.length - progress);
        
        logger.info('Processing progress', {
          channel,
          completed: progress,
          total: mockExchanges.length,
          progressPercent: `${progressPercent}%`,
          elapsedSeconds: Math.round(elapsed / 1000),
          estimatedRemainingSeconds: Math.round(estimatedRemaining / 1000)
        });
      }
      
      return result;
    } catch (error) {
      logger.error('Error processing mock exchange', {
        tradeId: trade.id,
        tradingPair: trade.trading_pair,
        progress: `${index + 1}/${mockExchanges.length}`,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  });

  // Wait for all trades to complete
  await Promise.all(processPromises);
  
  const processElapsed = Date.now() - processStartTime;
  logger.info('All trades processed', {
    channel,
    totalTrades: mockExchanges.length,
    elapsedSeconds: Math.round(processElapsed / 1000)
  });

  logger.info('All trades simulated', {
    channel,
    totalTrades: allTradesToSimulate.length
  });

  // Get all closed trades for this channel
  const allTrades = await db.getTradesByStatus('closed');
  const channelTrades = allTrades.filter(t => t.channel === channel);
  
  const stoppedTrades = await db.getTradesByStatus('stopped');
  const channelStoppedTrades = stoppedTrades.filter(t => t.channel === channel);

  // Only include trades that have a filled entry - if entry wasn't filled, the trade shouldn't count
  const completedTrades = [...channelTrades, ...channelStoppedTrades].filter(
    trade => trade.entry_filled_at !== null && trade.entry_filled_at !== undefined
  );

  const tradesWithoutEntry = [...channelTrades, ...channelStoppedTrades].filter(
    trade => !trade.entry_filled_at
  );

  logger.info('Trades completed for evaluation', {
    channel,
    totalTrades: completedTrades.length,
    closed: channelTrades.length,
    stopped: channelStoppedTrades.length,
    tradesWithoutEntryFill: tradesWithoutEntry.length,
    excludedTrades: tradesWithoutEntry.map(t => ({ id: t.id, status: t.status, tradingPair: t.trading_pair }))
  });

  if (tradesWithoutEntry.length > 0) {
    logger.warn('Excluding trades without filled entry from evaluation', {
      channel,
      excludedCount: tradesWithoutEntry.length,
      trades: tradesWithoutEntry.map(t => ({
        id: t.id,
        status: t.status,
        tradingPair: t.trading_pair,
        createdAt: t.created_at
      }))
    });
  }

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
    const evaluator = createPropFirmEvaluator(rule, db);

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
    const result = await evaluator.evaluate();
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
      totalMessages: filteredMessages.length,
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

