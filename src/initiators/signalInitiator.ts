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
  startDate?: string
): Promise<void> => {
  // In simulation/evaluation mode, get all messages (including parsed ones)
  // so we can re-process them for backtesting
  const messages = isSimulation 
    ? await db.getMessagesByChannel(channel)
    : await db.getUnparsedMessages(channel);
  
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

  // In simulation mode, process messages in chronological order
  const sortedMessages = isSimulation
    ? [...filteredMessages].sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return dateA - dateB;
      })
    : filteredMessages;

  for (const message of sortedMessages) {
    try {
      // In simulation mode, set price provider time to message time
      if (isSimulation && priceProvider) {
        const messageTime = dayjs(message.date);
        priceProvider.setCurrentTime(messageTime);
      }

      const parsed = parseMessage(message.content, parserName);
      if (parsed) {
        // Create context for the initiator
        const context: InitiatorContext = {
          channel,
          riskPercentage: initiatorConfig.riskPercentage,
          entryTimeoutDays,
          message,
          order: parsed,
          db,
          isSimulation,
          priceProvider,
          config: initiatorConfig,
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
  }
};
