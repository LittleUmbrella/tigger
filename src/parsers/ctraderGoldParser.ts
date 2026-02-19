import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parser for cTrader gold trading signals with two formats:
 * 
 * Format 1:
 * gold buy Now!! - 5054
 * 
 * SL 5052
 * 
 * TP 5066
 * TP 5076
 * Tp 5086
 * 
 * Format 2:
 * gold buy Now!!@5055 - 5051
 * 
 * SL 5049
 * 
 * TP 5066
 * TP 5076
 * Tp 5086
 */
export const ctraderGoldParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    // Normalize content - remove extra whitespace but preserve line breaks
    const normalizedContent = content.trim();
    
    // Extract trading pair - look for "gold" (case-insensitive)
    // Translate "gold" to "XAU" (gold IS XAU), but keep as XAUUSD for cTrader (don't translate to crypto XAUT/USDT)
    const tradingPairMatch = normalizedContent.match(/^(gold|XAU|XAUT)\s+/i);
    if (!tradingPairMatch) return null;
    
    // Translate gold to XAU, then format as XAUUSD for cTrader
    // cTrader uses formats like "XAUUSD" (no slash, no USDT, not XAUT)
    const assetName = tradingPairMatch[1].toUpperCase();
    const tradingPair = assetName === 'GOLD' || assetName === 'XAU' || assetName === 'XAUT'
      ? 'XAUUSD'  // cTrader native format: XAU (not XAUT) + USD (not USDT)
      : `${assetName}USD`;
    
    // Extract signal type - "buy" = long, "sell" = short
    const buyMatch = normalizedContent.match(/buy/i);
    const sellMatch = normalizedContent.match(/sell/i);
    
    if (!buyMatch && !sellMatch) return null;
    const signalType: 'long' | 'short' = buyMatch ? 'long' : 'short';
    
    let entryPrice: number | undefined;
    let stopLoss: number | undefined;
    
    // Try Format 2 first: "gold buy Now!!@5055 - 5051"
    // Entry price after @, value after dash might be stop loss or something else
    // We'll use the SL line for stop loss, but extract entry from @
    const format2Match = normalizedContent.match(/@\s*([\d.]+)/i);
    if (format2Match) {
      const entryPriceStr = format2Match[1];
      entryPrice = parseFloat(entryPriceStr);
      
      if (isNaN(entryPrice) || entryPrice <= 0) {
        return null;
      }
      // Stop loss will be extracted from SL line below
    } else {
      // Try Format 1: "gold buy Now!! - 5054"
      // Entry price after dash on first line
      const format1Match = normalizedContent.match(/-\s*([\d.]+)/);
      if (format1Match) {
        const entryPriceStr = format1Match[1];
        entryPrice = parseFloat(entryPriceStr);
        
        if (isNaN(entryPrice) || entryPrice <= 0) {
          return null;
        }
      } else {
        return null; // Neither format matched
      }
    }
    
    // Extract stop loss - look for "SL" followed by number (case-insensitive)
    // Only extract if not already found in Format 2
    if (stopLoss === undefined) {
      const stopLossMatch = normalizedContent.match(/S[Ll]\s+([\d.]+)/i);
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
    const tpPattern = /T[Pp]\s+([\d.]+)/gi;
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
      entryPrice,
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
