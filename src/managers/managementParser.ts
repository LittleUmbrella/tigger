import { ParsedManagementCommand } from './managerRegistry.js';
import { parseWithLLMFallback } from '../parsers/llmFallbackParser.js';
import { Message, DatabaseManager } from '../db/schema.js';
import { extractReplyContext, ReplyContext } from './replyContextExtractor.js';

/**
 * Parse a message to detect management commands
 * Returns null if the message is not a management command
 * 
 * This function first tries strict pattern matching, then falls back to LLM parsing if configured.
 * It also considers reply chain context to infer symbol and side when not explicitly specified.
 */
export const parseManagementCommand = async (
  content: string,
  ollamaConfig?: { baseUrl?: string; model?: string; timeout?: number; maxRetries?: number; rateLimit?: { perChannel?: number; perMinute?: number }; channel?: string },
  message?: Message,
  db?: DatabaseManager
): Promise<ParsedManagementCommand | null> => {
  const normalized = content.toLowerCase().trim();

  // Close all longs
  if (
    normalized.includes('close all longs') ||
    normalized.includes('closed all longs') ||
    normalized.includes('close all long') ||
    normalized === 'close longs' ||
    normalized === 'closed longs'
  ) {
    return { type: 'close_all_longs' };
  }

  // Close all shorts
  if (
    normalized.includes('close all shorts') ||
    normalized.includes('closed all shorts') ||
    normalized.includes('close all short') ||
    normalized === 'close shorts' ||
    normalized === 'closed shorts'
  ) {
    return { type: 'close_all_shorts' };
  }

  // Close all trades
  if (
    normalized.includes('close all trades') ||
    normalized.includes('closed all trades') ||
    normalized.includes('close all positions') ||
    normalized.includes('closed all positions') ||
    normalized === 'close all' ||
    normalized === 'close everything' ||
    normalized === 'close it' ||
    normalized === 'close'
  ) {
    return { type: 'close_all_trades' };
  }

  // Close percentage of position (e.g., "Close 25% Here And Move SL On Entry")
  const percentageMatch = normalized.match(/close\s+(\d+(?:\.\d+)?)\s*%/);
  if (percentageMatch) {
    const percentage = parseFloat(percentageMatch[1]);
    const moveSLToEntry = normalized.includes('move sl') || normalized.includes('move stop loss') || 
                          normalized.includes('sl on entry') || normalized.includes('stop loss on entry');
    
    // Try to extract trading pair if mentioned
    let tradingPair: string | undefined;
    const pairMatch = normalized.match(/#?([a-z]{2,10})\/?usdt/i);
    if (pairMatch) {
      tradingPair = `${pairMatch[1].toUpperCase()}/USDT`;
    } else if (message && db) {
      // If not found in message, try to get from reply chain context
      const replyContext = await extractReplyContext(message, db);
      if (replyContext.symbol) {
        tradingPair = replyContext.symbol.includes('/') 
          ? replyContext.symbol 
          : `${replyContext.symbol.replace('USDT', '')}/USDT`;
      }
    }
    
    return {
      type: 'close_percentage',
      percentage,
      tradingPair,
      moveStopLossToEntry: moveSLToEntry
    };
  }

  // Close specific position (e.g., "Close #BTCUSDT")
  const specificPairMatch = normalized.match(/close\s+#?([a-z]{2,10})\/?usdt/i);
  if (specificPairMatch) {
    return {
      type: 'close_position',
      tradingPair: `${specificPairMatch[1].toUpperCase()}/USDT`
    };
  }

  // If strict parsing failed and LLM is configured, try LLM fallback
  if (ollamaConfig) {
    try {
      // Build enhanced prompt with reply chain context if available
      let enhancedContent = content;
      if (message && db) {
        const replyContext = await extractReplyContext(message, db);
        if (replyContext.symbol || replyContext.side) {
          const contextInfo = [];
          if (replyContext.symbol) {
            contextInfo.push(`Symbol: ${replyContext.symbol}`);
          }
          if (replyContext.side) {
            contextInfo.push(`Side: ${replyContext.side.toUpperCase()}`);
          }
          if (contextInfo.length > 0) {
            enhancedContent = `${content}\n\n[Context from replied message: ${contextInfo.join(', ')}]`;
          }
        }
      }
      
      const llmResult = await parseWithLLMFallback(enhancedContent, ollamaConfig);
      if (llmResult && llmResult.type === 'management') {
        // If LLM didn't provide tradingPair but we have context, add it
        if (!llmResult.command.tradingPair && message && db) {
          const replyContext = await extractReplyContext(message, db);
          if (replyContext.symbol) {
            llmResult.command.tradingPair = replyContext.symbol.includes('/') 
              ? replyContext.symbol 
              : `${replyContext.symbol.replace('USDT', '')}/USDT`;
          }
        }
        return llmResult.command;
      }
    } catch (error) {
      // Log but don't throw - fallback failed, return null
      // Error logging is handled in the LLM parser
    }
  }

  return null;
};

