import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parser for "school" format messages like:
 * 
 * #SIGNAL #MANA #ALTCOINS
 * 
 * Buy Between 0.29$ - 0.302$
 * 
 * Targets : 0.34$ - 0.37$ - 0.39$ 
 * 
 * Stop Loss : 0.255$
 */
export const schoolParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  // Trading pair - extract from #SYMBOL format (e.g., #MANA)
  // Look for # followed by letters/numbers, but skip #SIGNAL and #ALTCOINS
  const tradingPairMatch = content.match(/#([A-Z0-9]+)/gi);
  if (!tradingPairMatch) return null;
  
  // Filter out common non-trading-pair hashtags
  const excludedTags = ['SIGNAL', 'ALTCOINS', 'CRYPTO', 'TRADING', 'BITCOIN', 'ETHEREUM'];
  const tradingPairTag = tradingPairMatch.find(tag => {
    const symbol = tag.replace('#', '').toUpperCase();
    return !excludedTags.includes(symbol);
  });
  
  if (!tradingPairTag) return null;
  const tradingPair = tradingPairTag.replace('#', '').toUpperCase();

  // Signal type - "Buy" indicates LONG, "Sell" indicates SHORT
  const buyMatch = content.match(/\b(Buy|BUY|buy)\b/i);
  const sellMatch = content.match(/\b(Sell|SELL|sell)\b/i);
  
  if (!buyMatch && !sellMatch) return null;
  const signalType: 'long' | 'short' = buyMatch ? 'long' : 'short';

  // Entry price - extract range from "Buy Between 0.29$ - 0.302$" format
  const entryPriceStrategy = options?.entryPriceStrategy || 'worst';
  let entryPrice: number | undefined;
  
  // Try "Buy Between X$ - Y$" format
  const entryPriceRangeMatch = content.match(/(?:Buy|Sell|BUY|SELL)\s+Between\s+([\d.]+)\s*\$?\s*-\s*\$?\s*([\d.]+)\s*\$?/i);
  if (entryPriceRangeMatch) {
    const price1 = parseFloat(entryPriceRangeMatch[1]);
    const price2 = parseFloat(entryPriceRangeMatch[2]);
    entryPrice = calculateEntryPrice(price1, price2, signalType, entryPriceStrategy);
  } else {
    // Try single entry price: "Buy: 0.29$" or "Buy 0.29$"
    const entryPriceSingleMatch = content.match(/(?:Buy|Sell|BUY|SELL)[:\s]+([\d.]+)\s*\$?/i);
    if (entryPriceSingleMatch) {
      entryPrice = parseFloat(entryPriceSingleMatch[1]);
    } else {
      // No entry price found - allow undefined for market orders
      entryPrice = undefined;
    }
  }

  // Stop loss - extract from "Stop Loss : 0.255$" format
  // Handle variations: "Stop Loss:", "Stop Loss", "SL:", etc.
  const stopLossMatch = content.match(/(?:Stop\s*Loss|StopLoss|SL|stop\s*loss)[:\s]+([\d.]+)\s*\$?/i);
  if (!stopLossMatch) return null;
  
  const stopLossStr = stopLossMatch[1];
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);

  // Take profits - extract from "Targets : 0.34$ - 0.37$ - 0.39$" format
  const takeProfits: number[] = [];
  
  // Try "Targets : X$ - Y$ - Z$" format
  const targetsMatch = content.match(/(?:Targets?|TP|targets?)[:\s]+([\d.\s\-\$]+)/i);
  if (targetsMatch) {
    const targetsString = targetsMatch[1];
    // Extract all numbers from the targets string (handle $ signs)
    const targetNumbers = targetsString.match(/[\d.]+/g);
    if (targetNumbers) {
      const validTargets = targetNumbers
        .map(t => parseFloat(t))
        .filter(t => !isNaN(t) && t > 0);
      takeProfits.push(...validTargets);
    }
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

  // Validate parsed order (only if entryPrice is provided)
  if (!validateParsedOrder(parsedOrder, { message: content })) {
    return null;
  }

  return parsedOrder;
};

