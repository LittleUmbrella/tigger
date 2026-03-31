import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';

/**
 * Parser for cTrader gold trading signals. Supports multiple formats:
 *
 * Asset: gold, XAU, XAUT, or XAUUSD (case-insensitive)
 * SL/TP: space or colon separator (e.g. "SL 5184" or "SL:5184", "TP 5203" or "TP:5203")
 *
 * All supported formats are treated as market orders: any @ price, dash range, or zone
 * in the message is informational only; entryPrice is omitted so the cTrader initiator
 * executes at market (see channel useLimitOrderForEntry).
 *
 * Format 1:
 * gold buy Now!! - 5054
 * SL 5052
 * TP 5066
 * TP 5076
 *
 * Format 2:
 * gold buy Now!!@5055 - 5051
 * SL 5049
 * TP 5066
 * TP 5076
 *
 * Format 3 (compact, colon separators):
 * XAUUSD BUY NOW @5193 - 5187 SL:5184 TP:5203 TP:5210 TP:5218
 *
 * Optional leading # or $ (e.g. #XAUUSD …) is ignored for matching.
 */
export const ctraderGoldParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    // Normalize content - remove extra whitespace but preserve line breaks
    const normalizedContent = content.trim();
    
    // Extract trading pair - look for "gold", "XAU", "XAUT", or "XAUUSD" (case-insensitive)
    // Translate "gold" to "XAU", but keep as XAUUSD for cTrader (don't translate to crypto XAUT/USDT)
    const tradingPairMatch = normalizedContent.match(/^#?\$?\s*(gold|XAU|XAUT|XAUUSD)\s+/i);
    if (!tradingPairMatch) return null;
    
    const tradingPair = normalizeAssetAliasToCTraderPair(tradingPairMatch[1]);
    
    // Extract signal type - "buy" = long, "sell" = short
    const buyMatch = normalizedContent.match(/buy/i);
    const sellMatch = normalizedContent.match(/sell/i);
    
    if (!buyMatch && !sellMatch) return null;
    const signalType: 'long' | 'short' = buyMatch ? 'long' : 'short';
    
    let stopLoss: number | undefined;
    
    // Extract stop loss - look for "SL" followed by number (case-insensitive)
    // Only extract if not already found in Format 2
    if (stopLoss === undefined) {
      const stopLossMatch = normalizedContent.match(/S[Ll][\s:]+([\d.]+)/i);
      if (!stopLossMatch) return null;
      
      const stopLossStr = stopLossMatch[1];
      stopLoss = parseFloat(stopLossStr);
      
      if (isNaN(stopLoss) || stopLoss <= 0) {
        return null;
      }
    }
    
    // Extract take profits - look for "TP" followed by number (case-insensitive)
    // Match all TP lines: TP 5066, TP 5076, Tp 5086, etc.
    const takeProfits: number[] = [];
    const tpPattern = /T[Pp][\s:]+([\d.]+)/gi;
    let tpMatch;
    
    while ((tpMatch = tpPattern.exec(normalizedContent)) !== null) {
      const tpValue = parseFloat(tpMatch[1]);
      if (!isNaN(tpValue) && tpValue > 0) {
        takeProfits.push(tpValue);
      }
    }
    
    if (takeProfits.length === 0) return null;
    
    // Sort take profits based on signal type to ensure correct order
    if (signalType === 'long') {
      takeProfits.sort((a, b) => a - b); // Ascending for long
    } else {
      takeProfits.sort((a, b) => b - a); // Descending for short
    }
    
    // Deduplicate take profits
    const deduplicatedTPs = deduplicateTakeProfits(takeProfits, signalType);
    
    if (deduplicatedTPs.length === 0) return null;
    
    // Default leverage (can be overridden in config)
    const leverage = 20;
    
    const parsedOrder: ParsedOrder = {
      tradingPair,
      entryPrice: undefined,
      stopLoss,
      takeProfits: deduplicatedTPs,
      leverage,
      signalType,
    };
    
    // Validate parsed order
    if (!validateParsedOrder(parsedOrder, { message: content })) {
      return null;
    }
    
    return parsedOrder;
  } catch (error) {
    // Silently return null on parse errors
    return null;
  }
};
