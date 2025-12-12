import { ParserConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { getParser, getParserSync, registerParser } from './parserRegistry.js';
import { defaultParser } from './defaultParser.js';
import { parseWithLLMFallback, LLMParserResult } from './llmFallbackParser.js';
import { parseManagementCommand } from '../managers/managementParser.js';

// Register the default parser
registerParser('default', defaultParser);
registerParser('default_parser', defaultParser); // Alias for backward compatibility

/**
 * Parse a message using the specified parser name
 * Falls back to default parser if parser not found
 */
export const parseMessage = (content: string, parserName?: string): ParsedOrder | null => {
  const parser = parserName ? getParserSync(parserName) : null;
  const actualParser = parser || defaultParser;
  
  return actualParser(content);
};

/**
 * Parse a message with fallback chain: configured parser -> default parser -> LLM fallback (if enabled)
 * This is the async version that supports LLM fallback
 */
export const parseMessageWithFallback = async (
  content: string,
  config: ParserConfig
): Promise<ParsedOrder | null> => {
  // Try configured parser first
  const parser = await getParser(config.name);
  if (parser) {
    const result = parser(content);
    if (result) {
      return result;
    }
  }

  // Try default parser
  const defaultResult = defaultParser(content);
  if (defaultResult) {
    return defaultResult;
  }

  // Try LLM fallback if configured
  if (config.ollama) {
    logger.debug('Attempting LLM fallback parser', {
      channel: config.channel,
      parserName: config.name,
    });
    try {
      const llmResult = await parseWithLLMFallback(content, {
        ...config.ollama,
        channel: config.channel,
      });
      if (llmResult && llmResult.type === 'order') {
        return llmResult.order;
      }
    } catch (error) {
      logger.warn('LLM fallback parser error', {
        channel: config.channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
};

export const parseUnparsedMessages = async (
  config: ParserConfig,
  db: DatabaseManager
): Promise<void> => {
  const messages = await db.getUnparsedMessages(config.channel);
  
  // Get the parser function for this parser config
  const parser = getParserSync(config.name);
  if (!parser) {
    logger.warn('Parser not found, using default parser', {
      parserName: config.name,
      channel: config.channel
    });
  }
  const parserFunction = parser || defaultParser;
  
  for (const message of messages) {
    try {
      // Try configured/default parser first (synchronous)
      let parsed = parserFunction(message.content);
      let usedLLMFallback = false;
      
      // If that fails, try LLM fallback (async)
      if (!parsed && config.ollama) {
        logger.debug('Trying LLM fallback parser', {
          channel: config.channel,
          parserName: config.name,
          messageId: message.message_id,
        });
        try {
          const llmResult = await parseWithLLMFallback(message.content, {
            ...config.ollama,
            channel: config.channel,
          });
          
          if (llmResult) {
            usedLLMFallback = true;
            
            // Check if LLM returned a management command
            if (llmResult.type === 'management') {
              // Management commands are handled separately by the orchestrator
              // Mark as parsed but log that it's a management command
              await db.markMessageParsed(message.id);
              logger.info('LLM parsed management command', {
                channel: config.channel,
                parserName: config.name,
                messageId: message.message_id,
                commandType: llmResult.command.type,
                tradingPair: llmResult.command.tradingPair,
              });
              continue; // Skip signal processing for management commands
            } else if (llmResult.type === 'order') {
              // LLM returned a ParsedOrder
              parsed = llmResult.order;
            }
          }
        } catch (error) {
          logger.warn('LLM fallback parser error', {
            channel: config.channel,
            messageId: message.message_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (parsed) {
        // Store parsed order data - will be used by initiator
        await db.markMessageParsed(message.id);
        logger.info('Successfully parsed message', {
          channel: config.channel,
          parserName: config.name,
          messageId: message.message_id,
          tradingPair: parsed.tradingPair,
          signalType: parsed.signalType,
          usedLLMFallback,
        });
      } else {
        logger.debug('Could not parse message with any parser', {
          channel: config.channel,
          parserName: config.name,
          messageId: message.message_id
        });
        // Mark as parsed even if we couldn't extract order data (to avoid reprocessing)
        await db.markMessageParsed(message.id);
      }
    } catch (error) {
      logger.error('Error parsing message', {
        channel: config.channel,
        parserName: config.name,
        messageId: message.message_id,
        error: error instanceof Error ? error.message : String(error)
      });
      await db.markMessageParsed(message.id); // Mark as parsed to avoid infinite retry
    }
  }
};
