/**
 * Utility to extract trading context from message reply chains
 * Used to infer symbol, side, and other context when management commands don't specify them
 */
import { Message, DatabaseManager } from '../db/schema.js';
import { ParsedOrder } from '../types/order.js';
import { parseMessage } from '../parsers/signalParser.js';
import { logger } from '../utils/logger.js';

export interface ReplyContext {
  symbol?: string; // Trading pair (e.g., "BTCUSDT")
  side?: 'long' | 'short'; // Trade direction
  sourceMessage?: Message; // The original signal message
}

/**
 * Extract trading context from a message's reply chain
 * Walks up the reply chain to find the original signal message
 */
export async function extractReplyContext(
  message: Message,
  db: DatabaseManager
): Promise<ReplyContext> {
  const context: ReplyContext = {};

  // If message has no reply, return empty context
  if (!message.reply_to_message_id) {
    return context;
  }

  try {
    // Get the full reply chain
    const replyChain = await db.getMessageReplyChain(message.message_id, message.channel);
    
    if (replyChain.length === 0) {
      return context;
    }

    // Find the original signal message (the one that started the chain)
    // Usually the first message in the chain, but we'll check all for a parsed signal
    for (const chainMessage of replyChain) {
      // Try to parse the message to see if it's a signal
      const parsed = parseMessage(chainMessage.content);
      
      if (parsed) {
        // Found a signal message - extract context
        context.symbol = parsed.tradingPair;
        context.side = parsed.signalType;
        context.sourceMessage = chainMessage;
        
        logger.debug('Extracted context from reply chain', {
          messageId: message.message_id,
          sourceMessageId: chainMessage.message_id,
          symbol: context.symbol,
          side: context.side,
        });
        
        return context;
      }
    }

    // If no parsed signal found, try to extract symbol from any message in the chain
    for (const chainMessage of replyChain) {
      // Look for common symbol patterns
      const symbolMatch = chainMessage.content.match(/#?([A-Z]{2,10})\/?USDT/i);
      if (symbolMatch) {
        context.symbol = symbolMatch[1].toUpperCase().replace('/', '') + 'USDT';
        context.sourceMessage = chainMessage;
        
        // Try to infer side from keywords
        const contentLower = chainMessage.content.toLowerCase();
        if (contentLower.includes('long') || contentLower.includes('buy') || contentLower.includes('🟢')) {
          context.side = 'long';
        } else if (contentLower.includes('short') || contentLower.includes('sell') || contentLower.includes('🔴')) {
          context.side = 'short';
        }
        
        logger.debug('Extracted partial context from reply chain', {
          messageId: message.message_id,
          sourceMessageId: chainMessage.message_id,
          symbol: context.symbol,
          side: context.side,
        });
        
        return context;
      }
    }
  } catch (error) {
    logger.warn('Error extracting reply context', {
      messageId: message.message_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return context;
}

/**
 * Find active trades that match the reply context
 * Used to narrow down which trades a management command refers to
 */
export async function findTradesByContext(
  context: ReplyContext,
  channel: string,
  db: DatabaseManager
): Promise<any[]> {
  const activeTrades = await db.getActiveTrades();
  
  let matchingTrades = activeTrades.filter(
    trade => trade.channel === channel && 
             trade.status === 'active' && 
             trade.position_id
  );

  // Filter by symbol if available
  if (context.symbol) {
    const normalizedSymbol = context.symbol.replace('/', '').toUpperCase();
    matchingTrades = matchingTrades.filter(
      trade => trade.trading_pair.replace('/', '').toUpperCase() === normalizedSymbol
    );
  }

  // Filter by side if available (need to check signal type from source message)
  if (context.side && context.sourceMessage) {
    const parsed = parseMessage(context.sourceMessage.content);
    if (parsed) {
      matchingTrades = matchingTrades.filter(
        trade => {
          // Get the source message for this trade
          return trade.trading_pair.replace('/', '').toUpperCase() === context.symbol?.replace('/', '').toUpperCase();
        }
      );
    }
  }

  return matchingTrades;
}




