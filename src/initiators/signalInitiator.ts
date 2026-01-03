import { InitiatorConfig, AccountConfig } from '../types/config.js';
import { DatabaseManager, Message } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { parseMessage } from '../parsers/signalParser.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { getInitiator, InitiatorContext, getRegisteredInitiators } from './initiatorRegistry.js';

export const processUnparsedMessages = async (
  initiatorConfig: InitiatorConfig,
  channel: string,
  entryTimeoutDays: number,
  db: DatabaseManager,
  isSimulation: boolean = false,
  priceProvider?: HistoricalPriceProvider,
  parserName?: string,
  accounts?: AccountConfig[],
  startDate?: string,
  channelBaseLeverage?: number // Per-channel override for baseLeverage
): Promise<void> => {
  // In simulation/evaluation mode, get all messages (including parsed ones)
  // so we can re-process them for backtesting
  const messages = isSimulation 
    ? await db.getMessagesByChannel(channel)
    : await db.getUnparsedMessages(channel);
  
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
  const processMessage = async (message: Message): Promise<void> => {
    try {
      // In simulation mode, set price provider time to message time
      if (isSimulation && priceProvider) {
        const messageTime = dayjs(message.date);
        priceProvider.setCurrentTime(messageTime);
      }

      const parsed = parseMessage(message.content, parserName);
      if (parsed) {
        // Merge channel-specific baseLeverage with initiator config
        // Channel-specific baseLeverage takes precedence over initiator config
        const mergedInitiatorConfig: InitiatorConfig = {
          ...initiatorConfig,
          baseLeverage: channelBaseLeverage !== undefined ? channelBaseLeverage : initiatorConfig.baseLeverage
        };
        
        // Create context for the initiator
        // Note: currentBalance is not passed here - quantities will be calculated later
        const context: InitiatorContext = {
          channel,
          riskPercentage: initiatorConfig.riskPercentage,
          entryTimeoutDays,
          message,
          order: parsed,
          db,
          isSimulation,
          priceProvider,
          config: mergedInitiatorConfig,
          accounts
        };

        // Call the registered initiator function
        await initiatorFunction(context);
        
        // Mark message as parsed after successful initiation
        await db.markMessageParsed(message.id);
      }
    } catch (error) {
      logger.error('Error processing message for initiation', {
        channel,
        messageId: message.message_id,
        initiatorName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  if (sortedMessages.length === 0) {
    logger.info('No messages to process', {
      channel,
      isSimulation,
      initiatorName
    });
    return;
  }

  logger.debug('Processing messages', {
    channel,
    messageCount: sortedMessages.length,
    isSimulation
  });

  // Process all messages in parallel
  await Promise.all(sortedMessages.map(processMessage));
  
  logger.debug('Finished processing messages', {
    channel,
    messageCount: sortedMessages.length
  });
};
