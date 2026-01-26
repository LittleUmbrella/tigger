import { ParserConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { getParser, getParserSync, registerParser } from './parserRegistry.js';
import { defaultParser } from './defaultParser.js';
import { parseWithLLMFallback, LLMParserResult } from './llmFallbackParser.js';
import { parseManagementCommand } from '../managers/managementParser.js';
import { vipCryptoSignals } from './channels/2427485240/vip-future.js';
import { ronnieCryptoSignals } from './channels/3241720654/ronnie-crypto-signals.js';
import { connect } from './channels/2394142145/connect.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';

// Register the default parser
registerParser('default', defaultParser);
registerParser('default_parser', defaultParser); // Alias for backward compatibility
registerParser('vip_crypto_signals', vipCryptoSignals);
registerParser('ronnie_crypto_signals', ronnieCryptoSignals);
registerParser('connect', connect);

/**
 * Parse a message using the specified parser name
 * Returns null if parser not found (no fallback to default parser)
 */
export const parseMessage = (content: string, parserName?: string, options?: { entryPriceStrategy?: 'worst' | 'average' }): ParsedOrder | null => {
  if (!parserName) {
    return null; // No parser specified, return null
  }
  const parser = getParserSync(parserName);
  if (!parser) {
    return null; // Parser not found, return null (no fallback)
  }
  
  return parser(content, options);
};

/**
 * Parse a message with fallback chain: configured parser -> LLM fallback (if enabled)
 * No default parser fallback - parsers should be strict and specific
 * This is the async version that supports LLM fallback
 */
export const parseMessageWithFallback = async (
  content: string,
  config: ParserConfig
): Promise<ParsedOrder | null> => {
  // Prepare parser options from config
  const parserOptions = config.entryPriceStrategy ? { entryPriceStrategy: config.entryPriceStrategy } : undefined;
  
  // Try configured parser first
  const parser = await getParser(config.name);
  if (parser) {
    const result = parser(content, parserOptions);
    if (result) {
      return result;
    }
  }

  // No fallback to default parser - parsers should be strict and specific

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
        db: config.db,
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
  db: DatabaseManager,
  maxStalenessMinutes?: number
): Promise<void> => {
  const messages = await db.getUnparsedMessages(config.channel, maxStalenessMinutes);
  
  // Get the parser function for this parser config
  const parser = getParserSync(config.name);
  if (!parser) {
    logger.warn('Parser not found, skipping parsing', {
      parserName: config.name,
      channel: config.channel
    });
    return; // Don't fall back to default parser - parsers should be strict and specific
  }
  const parserFunction = parser;
  
  // Prepare parser options from config
  const parserOptions = config.entryPriceStrategy ? { entryPriceStrategy: config.entryPriceStrategy } : undefined;
  
  for (const message of messages) {
    try {
      // Try configured/default parser first (synchronous)
      let parsed = parserFunction(message.content, parserOptions);
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
            db: config.db,
          }, message);
          
          if (llmResult) {
            usedLLMFallback = true;
            
            // Check if LLM returned a management command
            if (llmResult.type === 'management') {
              // Management commands are handled separately by the orchestrator
              // Don't mark as parsed here - let the orchestrator mark it after processing
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
        // Final validation check (safety net for parsers that don't validate internally)
        // This is especially important for market orders where entryPrice might be set later
        if (!validateParsedOrder(parsed, { channel: config.channel, messageId: message.message_id, message: message.content })) {
          logger.warn('Parsed order failed validation, rejecting', {
            channel: config.channel,
            parserName: config.name,
            messageId: message.message_id,
            tradingPair: parsed.tradingPair,
            signalType: parsed.signalType,
          });
          parsed = null; // Reject invalid order
        }
      }

      if (parsed) {
        // Don't mark as parsed here - let the initiator mark it after successfully initiating a trade
        // This ensures the initiator can process the message even if parser runs first
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
        // Don't mark as parsed here - let the initiator mark it after attempting to process
        // The initiator will mark unparseable messages as parsed to avoid reprocessing
      }
    } catch (error) {
      logger.error('Error parsing message', {
        channel: config.channel,
        parserName: config.name,
        messageId: message.message_id,
        error: error instanceof Error ? error.message : String(error)
      });
      // Don't mark as parsed here - let the initiator handle error cases
      // The initiator will mark non-retryable errors as parsed to avoid infinite retries
    }
  }
};
