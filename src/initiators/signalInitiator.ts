import {
  InitiatorConfig,
  AccountConfig,
  AccountFilter,
  CustomPropFirmConfig,
  TradeObfuscationConfig,
  ChannelSetConfig
} from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { DatabaseManager, Message } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';
import dayjs from 'dayjs';
import { parseMessage } from '../parsers/signalParser.js';
import { applyTradeObfuscation } from '../utils/tradeObfuscation.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { getInitiator, InitiatorContext, getRegisteredInitiators } from './initiatorRegistry.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';

/**
 * Determine if an error is retryable (should not mark message as parsed)
 * Non-retryable errors are permanent failures that won't succeed on retry:
 * - Invalid symbol (not supported on exchange)
 * - Trade validation failures (invalid price relationships)
 * - Configuration errors (missing credentials, invalid config)
 * - Calculation errors (invalid quantity, missing required data)
 * 
 * Retryable errors are temporary failures that might succeed on retry:
 * - Network errors
 * - API rate limits
 * - API server errors (5xx)
 * - Timeout errors
 */
const isRetryableError = (error: unknown): boolean => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorString = errorMessage.toLowerCase();

  // Non-retryable error patterns (permanent failures)
  const nonRetryablePatterns = [
    'invalid symbol',
    'symbol not found',
    'symbol does not exist',
    'trade validation failed',
    'invalid quantity calculated',
    'cannot calculate position size',
    'no bybit client available',
    'api credentials not found',
    'credentials not found',
    'missing api',
    'entry price is required',
    'invalid price relationships',
    'entry order cancelled',
    'all take profit orders failed',
    'cannot place cTrader MARKET_RANGE',
    'max risk:'
  ];

  // Check if error matches any non-retryable pattern
  for (const pattern of nonRetryablePatterns) {
    if (errorString.includes(pattern)) {
      return false; // Non-retryable
    }
  }

  // Retryable error patterns (temporary failures)
  // "exceeds maximum limit" = order qty > maxOrderQty - retryable after quantity cap fix
  const retryablePatterns = [
    'exceeds maximum limit',
    'network',
    'timeout',
    'rate limit',
    'too many requests',
    'server error',
    'service unavailable',
    'internal server error',
    'bad gateway',
    'gateway timeout',
    'econnreset',
    'enotfound',
    'etimedout'
  ];

  // Check if error matches any retryable pattern
  for (const pattern of retryablePatterns) {
    if (errorString.includes(pattern)) {
      return true; // Retryable
    }
  }

  // Default: assume non-retryable for unknown errors (safer to mark as parsed than retry forever)
  // This prevents infinite retries for unexpected error types
  return false;
};

/**
 * Strategy path: no text parser. Builds a small audit `messages` row, then runs the channel initiator
 * with the given `ParsedOrder` (same `insertTrade` / exchange behavior as parsed Telegram signals).
 */
export const initiateFromStrategy = async (options: {
  strategyName: string;
  order: ParsedOrder;
  signalId: string;
  channelConfig: ChannelSetConfig;
  initiatorConfig: InitiatorConfig;
  entryTimeoutMinutes: number;
  db: DatabaseManager;
  isSimulation: boolean;
  priceProvider?: HistoricalPriceProvider;
  accounts?: AccountConfig[];
}): Promise<void> => {
  const {
    strategyName,
    order: inputOrder,
    signalId,
    channelConfig,
    initiatorConfig,
    entryTimeoutMinutes,
    db,
    isSimulation,
    priceProvider,
    accounts
  } = options;
  const channel = channelConfig.channel;
  const initiatorName = initiatorConfig.name || initiatorConfig.type;
  if (!initiatorName) {
    logger.error('initiateFromStrategy: initiator has no name', { channel, strategyName });
    return;
  }
  const initiatorFunction = getInitiator(initiatorName);
  if (!initiatorFunction) {
    logger.error('initiateFromStrategy: initiator not registered', { channel, strategyName, initiatorName });
    return;
  }
  if (!validateParsedOrder(inputOrder, { channel })) {
    logger.warn('initiateFromStrategy: order failed validation, skipping', { channel, strategyName });
    return;
  }
  let order = inputOrder;
  if (channelConfig.tradeObfuscation) {
    order = applyTradeObfuscation(order, channelConfig.tradeObfuscation);
  }
  const messageId = `strategy:${strategyName}:${signalId}`;
  const placeholder = `[strategy:${strategyName}]`;
  await db.insertMessage({
    message_id: messageId,
    channel,
    content: placeholder,
    sender: `strategy:${strategyName}`,
    date: new Date().toISOString()
  });
  const message = await db.getMessageByMessageId(messageId, channel);
  if (!message) {
    logger.error('initiateFromStrategy: message row missing after insert', { messageId, channel, strategyName });
    return;
  }
  if (isSimulation && priceProvider) {
    priceProvider.setCurrentTime(dayjs(message.date));
  }
  const mergedInitiatorConfig: InitiatorConfig = {
    ...initiatorConfig,
    baseLeverage:
      channelConfig.baseLeverage !== undefined ? channelConfig.baseLeverage : initiatorConfig.baseLeverage
  };
  const riskPercentage = channelConfig.riskPercentage ?? initiatorConfig.riskPercentage;
  const context: InitiatorContext = {
    channel,
    riskPercentage,
    entryTimeoutMinutes,
    message,
    order,
    db,
    isSimulation,
    priceProvider,
    config: mergedInitiatorConfig,
    accounts,
    accountFilters: channelConfig.accountFilters,
    propFirms: channelConfig.propFirms,
    maxRisk: channelConfig.maxRisk,
    slAdjustmentTolerancePercent: channelConfig.slAdjustmentTolerancePercent,
    useLimitOrderForEntry: channelConfig.useLimitOrderForEntry,
    maxSkippablePastTPs: channelConfig.maxSkippablePastTPs,
    useMarketRangeForEntry: channelConfig.useMarketRangeForEntry
  };
  try {
    logger.info('initiateFromStrategy: running initiator', {
      channel,
      strategyName,
      initiatorName,
      messageId: message.message_id,
      tradingPair: order.tradingPair
    });
    await initiatorFunction(context);
    await db.markMessageParsed(message.id);
    logger.info('initiateFromStrategy: completed, message marked parsed', {
      channel,
      messageId: message.message_id
    });
  } catch (initiatorError) {
    const isRetryable = isRetryableError(initiatorError);
    logger.error('initiateFromStrategy: initiator error', {
      channel,
      strategyName,
      initiatorName,
      isRetryable,
      error: serializeErrorForLog(initiatorError)
    });
    if (!isRetryable) {
      await db.markMessageParsed(message.id);
    }
  }
};

export const processUnparsedMessages = async (
  initiatorConfig: InitiatorConfig,
  channel: string,
  entryTimeoutMinutes: number,
  db: DatabaseManager,
  isSimulation: boolean = false,
  priceProvider?: HistoricalPriceProvider,
  parserName?: string,
  accounts?: AccountConfig[],
  startDate?: string,
  channelBaseLeverage?: number, // Per-channel override for baseLeverage
  channelRiskPercentage?: number, // Per-channel override for risk percentage (overrides initiator config)
  maxStalenessMinutes?: number, // Maximum age of messages to process in minutes
  accountFilters?: AccountFilter[], // Channel-level account filtering rules
  propFirms?: (string | CustomPropFirmConfig)[], // Prop firm names or custom configurations
  tradeObfuscation?: TradeObfuscationConfig, // Random percent adjustment for sl/entry/tp
  slAdjustmentTolerancePercent?: number, // When price past SL, max overshoot % to allow proportional SL adjustment (0 = reject)
  useLimitOrderForEntry?: boolean, // cTrader: When true use limit at current price; when false use market with relative SL/TP (default: true)
  maxSkippablePastTPs?: number, // cTrader market orders: max TPs to skip if already past current price (0 = reject, default)
  useMarketRangeForEntry?: boolean, // cTrader: MARKET_RANGE; boundary TP index = maxSkippablePastTPs (0=TP1, 1=TP2)
  maxRisk?: number
): Promise<void> => {
  // In simulation/evaluation mode, get all messages (including parsed ones)
  // so we can re-process them for backtesting
  const messages = isSimulation 
    ? await db.getMessagesByChannel(channel)
    : await db.getUnparsedMessages(channel, maxStalenessMinutes);
  
  logger.debug('Retrieved messages for processing', {
    channel,
    isSimulation,
    messageCount: messages.length,
    messageIds: messages.map(m => m.message_id).slice(0, 10)
  });
  
  // Filter messages by startDate if provided
  let filteredMessages = messages;
  if (startDate) {
    const startDateObj = dayjs(startDate);
    filteredMessages = messages.filter(msg => {
      const msgDate = dayjs(msg.date);
      // Include messages on or after startDate (same day or later)
      return msgDate.isAfter(startDateObj, 'day') || msgDate.isSame(startDateObj, 'day');
    });
    
    if (filteredMessages.length < messages.length) {
      logger.info('Filtered messages by start date', {
        channel,
        startDate,
        totalMessages: messages.length,
        filteredMessages: filteredMessages.length,
        excludedMessages: messages.length - filteredMessages.length
      });
    }
  }
  
  // Get initiator name (support both 'name' and deprecated 'type' field for backward compatibility)
  const initiatorName = initiatorConfig.name || initiatorConfig.type;
  
  if (!initiatorName) {
    logger.error('Initiator name not specified in config', { channel });
    return;
  }

  // Get the initiator function from registry
  const initiatorFunction = getInitiator(initiatorName);
  
  if (!initiatorFunction) {
    const availableInitiators = getRegisteredInitiators();
    logger.error('Initiator not found in registry', {
      channel,
      initiatorName,
      availableInitiators
    });
    return;
  }

  // In simulation mode, process messages in chronological order for sorting
  // But process them in parallel for efficiency - quantities will be calculated later
  const sortedMessages = isSimulation
    ? [...filteredMessages].sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return dateA - dateB;
      })
    : filteredMessages;

  // Process messages in parallel - trade creation is independent
  // Quantities will be set to 0 initially and recalculated after mock exchanges complete
  await processMessages(
    sortedMessages,
    initiatorConfig,
    channel,
    entryTimeoutMinutes,
    db,
    isSimulation,
    priceProvider,
    parserName,
    accounts,
    channelBaseLeverage,
    channelRiskPercentage,
    initiatorFunction,
    initiatorName,
    accountFilters,
    propFirms,
    tradeObfuscation,
    slAdjustmentTolerancePercent,
    useLimitOrderForEntry,
    maxSkippablePastTPs,
    useMarketRangeForEntry,
    maxRisk
  );
  
  logger.debug('Finished processing messages', {
    channel,
    messageCount: sortedMessages.length
  });
};

/**
 * Process a list of messages through parsing and initiation
 * This is a reusable function that can be used by both the orchestrator and scripts
 */
export const processMessages = async (
  messages: Message[],
  initiatorConfig: InitiatorConfig,
  channel: string,
  entryTimeoutMinutes: number,
  db: DatabaseManager,
  isSimulation: boolean = false,
  priceProvider?: HistoricalPriceProvider,
  parserName?: string,
  accounts?: AccountConfig[],
  channelBaseLeverage?: number,
  channelRiskPercentage?: number,
  initiatorFunction?: (context: InitiatorContext) => Promise<void>,
  initiatorName?: string,
  accountFilters?: AccountFilter[],
  propFirms?: (string | CustomPropFirmConfig)[],
  tradeObfuscation?: TradeObfuscationConfig,
  slAdjustmentTolerancePercent?: number,
  useLimitOrderForEntry?: boolean,
  maxSkippablePastTPs?: number,
  /** cTrader: MARKET_RANGE; boundary TP index = maxSkippablePastTPs (0=TP1, 1=TP2) */
  useMarketRangeForEntry?: boolean,
  maxRisk?: number
): Promise<void> => {
  // Get initiator function if not provided
  if (!initiatorFunction) {
    const actualInitiatorName = initiatorName || initiatorConfig.name || initiatorConfig.type;
    if (!actualInitiatorName) {
      logger.error('Initiator name not specified', { channel });
      return;
    }
    initiatorFunction = getInitiator(actualInitiatorName);
    if (!initiatorFunction) {
      const availableInitiators = getRegisteredInitiators();
      logger.error('Initiator not found in registry', {
        channel,
        initiatorName: actualInitiatorName,
        availableInitiators
      });
      return;
    }
    initiatorName = actualInitiatorName;
  }

  const processMessage = async (message: Message): Promise<void> => {
    try {
      // Log message processing start - critical for tracing flow in Loggly
      logger.info('Processing message for trade initiation', {
        channel,
        messageId: message.message_id,
        messageDate: message.date,
        contentPreview: message.content.substring(0, 200),
        parserName: parserName || 'default',
        initiatorName
      });

      // In simulation mode, set price provider time to message time
      if (isSimulation && priceProvider) {
        const messageTime = dayjs(message.date);
        priceProvider.setCurrentTime(messageTime);
      }

      let parsed = parseMessage(message.content, parserName);
      if (parsed) {
        // Obfuscate before any rounding for exchange constraints (must stay first)
        if (tradeObfuscation) {
          parsed = applyTradeObfuscation(parsed, tradeObfuscation);
        }
        // Log successful parsing - critical for investigations
        logger.info('Message parsed successfully', {
          channel,
          messageId: message.message_id,
          tradingPair: parsed.tradingPair,
          signalType: parsed.signalType,
          entryPrice: parsed.entryPrice,
          stopLoss: parsed.stopLoss,
          takeProfits: parsed.takeProfits?.length || 0,
          parserName: parserName || 'default'
        });
        // Merge channel-specific baseLeverage and riskPercentage with initiator config
        // Channel-specific overrides take precedence over initiator config
        const mergedInitiatorConfig: InitiatorConfig = {
          ...initiatorConfig,
          baseLeverage: channelBaseLeverage !== undefined ? channelBaseLeverage : initiatorConfig.baseLeverage
        };

        const riskPercentage = channelRiskPercentage ?? initiatorConfig.riskPercentage;
        
        // Create context for the initiator
        // Note: currentBalance is not passed here - quantities will be calculated later
        const context: InitiatorContext = {
          channel,
          riskPercentage,
          entryTimeoutMinutes,
          message,
          order: parsed,
          db,
          isSimulation,
          priceProvider,
          config: mergedInitiatorConfig,
          accounts,
          accountFilters,
          propFirms,
          maxRisk,
          slAdjustmentTolerancePercent,
          useLimitOrderForEntry,
          maxSkippablePastTPs,
          useMarketRangeForEntry
        };

        try {
          // Log trade initiation start - critical for investigations
          logger.info('Initiating trade', {
            channel,
            messageId: message.message_id,
            tradingPair: parsed.tradingPair,
            signalType: parsed.signalType,
            initiatorName,
            accountCount: accounts?.length || 0,
            accountNames: accounts?.map(a => a.name) || []
          });

          // Call the registered initiator function
          await initiatorFunction(context);
          
          // Mark message as parsed after successful initiation
          await db.markMessageParsed(message.id);
          
          // Log successful completion - critical for investigations
          logger.info('Trade initiated successfully, message marked as parsed', {
            channel,
            messageId: message.message_id,
            tradingPair: parsed.tradingPair,
            signalType: parsed.signalType,
            initiatorName
          });
        } catch (initiatorError) {
          const isRetryable = isRetryableError(initiatorError);
          
          logger.error('Error initiating trade', {
            channel,
            messageId: message.message_id,
            initiatorName,
            tradingPair: parsed.tradingPair,
            signalType: parsed.signalType,
            isRetryable,
            error: serializeErrorForLog(initiatorError)
          });

          // Mark message as parsed for non-retryable errors to prevent infinite retries
          // (e.g., unsupported symbols, validation failures, configuration errors)
          if (!isRetryable) {
            await db.markMessageParsed(message.id);
            logger.info('Marked message as parsed due to non-retryable error', {
              channel,
              messageId: message.message_id,
              tradingPair: parsed.tradingPair,
              signalType: parsed.signalType,
              initiatorName,
              error: serializeErrorForLog(initiatorError),
              errorType: 'non-retryable',
              reason: 'Permanent failure - will not succeed on retry'
            });
          } else {
            // Log retryable errors - don't mark as parsed, allow retry
            logger.warn('Trade initiation failed with retryable error, message will be retried', {
              channel,
              messageId: message.message_id,
              tradingPair: parsed.tradingPair,
              signalType: parsed.signalType,
              initiatorName,
              error: serializeErrorForLog(initiatorError),
              errorType: 'retryable',
              reason: 'Temporary failure - will retry on next iteration'
            });
          }
          // For retryable errors, don't mark as parsed - allow retry on next iteration
        }
      } else {
        // Message couldn't be parsed - mark as parsed to avoid reprocessing
        logger.warn('Message parsing failed, marking as parsed to avoid reprocessing', {
          channel,
          messageId: message.message_id,
          contentPreview: message.content.substring(0, 200),
          parserName: parserName || 'default',
          reason: 'Parse returned null - message format not recognized'
        });
        await db.markMessageParsed(message.id);
      }
    } catch (error) {
      logger.error('Error processing message for initiation', {
        channel,
        messageId: message.message_id,
        initiatorName,
        error: serializeErrorForLog(error)
      });
      // Don't mark as parsed on unexpected errors - allow retry
    }
  };

  if (messages.length === 0) {
    logger.debug('No messages to process', {
      channel,
      isSimulation,
      initiatorName
    });
    return;
  }

  logger.debug('Processing messages', {
    channel,
    messageCount: messages.length,
    isSimulation
  });

  // Process all messages in parallel
  await Promise.all(messages.map(processMessage));
  
  logger.debug('Finished processing messages', {
    channel,
    messageCount: messages.length
  });
};
