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
  accounts?: AccountConfig[]
): Promise<void> => {
  const messages = await db.getUnparsedMessages(channel);
  
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
    ? [...messages].sort((a, b) => {
        const dateA = new Date(a.date).getTime();
        const dateB = new Date(b.date).getTime();
        return dateA - dateB;
      })
    : messages;

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
