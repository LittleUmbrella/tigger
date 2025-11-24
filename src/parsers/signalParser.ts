import { ParserConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { getParser, registerParser } from './parserRegistry.js';
import { defaultParser } from './defaultParser.js';

// Register the default parser
registerParser('default', defaultParser);
registerParser('default_parser', defaultParser); // Alias for backward compatibility

/**
 * Parse a message using the specified parser name
 * Falls back to default parser if parser not found
 */
export const parseMessage = (content: string, parserName?: string): ParsedOrder | null => {
  const parser = parserName ? getParser(parserName) : null;
  const actualParser = parser || defaultParser;
  
  return actualParser(content);
};

export const parseUnparsedMessages = async (
  config: ParserConfig,
  db: DatabaseManager
): Promise<void> => {
  const messages = db.getUnparsedMessages(config.channel);
  
  // Get the parser function for this parser config
  const parser = getParser(config.name);
  if (!parser) {
    logger.warn('Parser not found, using default parser', {
      parserName: config.name,
      channel: config.channel
    });
  }
  const parserFunction = parser || defaultParser;
  
  for (const message of messages) {
    try {
      const parsed = parserFunction(message.content);
      if (parsed) {
        // Store parsed order data - will be used by initiator
        db.markMessageParsed(message.id);
        logger.info('Successfully parsed message', {
          channel: config.channel,
          parserName: config.name,
          messageId: message.message_id,
          tradingPair: parsed.tradingPair,
          signalType: parsed.signalType
        });
      } else {
        logger.debug('Could not parse message', {
          channel: config.channel,
          parserName: config.name,
          messageId: message.message_id
        });
        // Mark as parsed even if we couldn't extract order data (to avoid reprocessing)
        db.markMessageParsed(message.id);
      }
    } catch (error) {
      logger.error('Error parsing message', {
        channel: config.channel,
        parserName: config.name,
        messageId: message.message_id,
        error: error instanceof Error ? error.message : String(error)
      });
      db.markMessageParsed(message.id); // Mark as parsed to avoid infinite retry
    }
  }
};
