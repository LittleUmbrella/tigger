import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parser for "gold_scalps" format messages like:
 * 
 * Sell Gold @5066-5075
 * 
 * Sl :5077
 * 
 * Tp1 :5061
 * Tp2 :5158
 * 
 * Enter Slowly-Layer with proper money management
 * 
 * Do not rush your entries
 */
export const goldScalpsParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  // Trading pair - extract from "Sell Gold" or "Buy Gold" or "Sell Gold USD" format
  const tradingPairMatch = content.match(/(?:Buy|Sell)\s+(Gold|XAU)(?:\s+(USD|USDT|USDC))?/i);
  if (!tradingPairMatch) return null;
  
  let asset = tradingPairMatch[1].toUpperCase();
  const baseCurrency = tradingPairMatch[2]?.toUpperCase() || 'USDT'; // Default to USDT if not specified
  let tradingPair = asset + baseCurrency;

  // Translate trading pair symbols
  // Translate "XAU" or "GOLD" (case-insensitive) to "XAUT"
  // Translate "USD" to "USDT"
  let normalizedPair = tradingPair.toUpperCase();
  
  // Replace XAU or GOLD with XAUT (case-insensitive, anywhere in the pair)
  normalizedPair = normalizedPair.replace(/XAU/g, 'XAUT');
  normalizedPair = normalizedPair.replace(/GOLD/g, 'XAUT');
  
  // Replace USD with USDT (only if it's not already USDT or USDC)
  normalizedPair = normalizedPair.replace(/USD$/g, 'USDT');
  normalizedPair = normalizedPair.replace(/USD([^TDC])/g, 'USDT$1');
  
  tradingPair = normalizedPair;

  // Signal type - extract from "Buy" or "Sell" at the start
  const buyMatch = content.match(/^Buy\s+/i);
  const sellMatch = content.match(/^Sell\s+/i);
  
  if (!buyMatch && !sellMatch) return null;
  const signalType: 'long' | 'short' = buyMatch ? 'long' : 'short';

  // Entry price - extract from "@5066-5075" format (range with @ symbol)
  const entryPriceRangeMatch = content.match(/@\s*([\d.]+)\s*-\s*([\d.]+)/i);
  if (!entryPriceRangeMatch) return null;
  
  const price1 = parseFloat(entryPriceRangeMatch[1]);
  const price2 = parseFloat(entryPriceRangeMatch[2]);
  
  if (isNaN(price1) || isNaN(price2)) return null;
  
  // Calculate entry price based on strategy
  const entryPriceStrategy = options?.entryPriceStrategy || 'worst';
  const entryPrice = calculateEntryPrice(price1, price2, signalType, entryPriceStrategy);

  // Stop loss - extract from "Sl :5077" format (case-insensitive, handles space before colon)
  const stopLossMatch = content.match(/S[Ll]\s*:\s*([\d.]+)/i);
  if (!stopLossMatch) return null;
  
  const stopLossStr = stopLossMatch[1];
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);

  // Take profit - extract from "Tp1 :5061", "Tp2 :5158" format (numbered TPs, case-insensitive, handles space before colon)
  const takeProfits: number[] = [];
  
  // Match all numbered TPs: Tp1, Tp2, Tp3, etc. (case-insensitive)
  const tpPattern = /T[Pp]\d+\s*:\s*([\d.]+)/gi;
  let tpMatch;
  
  while ((tpMatch = tpPattern.exec(content)) !== null) {
    const tpValue = parseFloat(tpMatch[1]);
    if (!isNaN(tpValue) && tpValue > 0) {
      takeProfits.push(tpValue);
    }
  }
  
  // Sort take profits based on signal type to ensure correct order
  if (signalType === 'long') {
    takeProfits.sort((a, b) => a - b); // Ascending for long
  } else {
    takeProfits.sort((a, b) => b - a); // Descending for short
  }
  
  if (takeProfits.length === 0) return null;

  // Deduplicate take profits
  const deduplicatedTPs = deduplicateTakeProfits(takeProfits, signalType);
  
  // Replace takeProfits with deduplicated version
  takeProfits.length = 0;
  takeProfits.push(...deduplicatedTPs);
  
  if (takeProfits.length === 0) return null;

  // Leverage - try to extract, but use default if not found
  // Handle formats: "Leverage: 20x", "20x Leverage", "20X", etc.
  let leverage = 20; // Default leverage
  let leverageMatch = content.match(/Leverage[:\s]*(\d+(?:\.\d+)?)\s*[Xx]/i);
  if (!leverageMatch) {
    // Try format without "Leverage" keyword: "20x" or "20X" standalone
    leverageMatch = content.match(/(\d+(?:\.\d+)?)\s*[Xx](?:\s+leverage)?/i);
  }
  
  if (leverageMatch) {
    const parsedLeverage = parseFloat(leverageMatch[1]);
    if (parsedLeverage >= 1) {
      leverage = parsedLeverage;
    }
  }

  const parsedOrder: ParsedOrder = {
    tradingPair,
    entryPrice,
    stopLoss,
    takeProfits,
    leverage,
    signalType,
  };

  // Validate parsed order
  if (!validateParsedOrder(parsedOrder, { message: content })) {
    return null;
  }

  return parsedOrder;
};

