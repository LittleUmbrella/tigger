import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parser for star format messages like:
 * 
 * Format 1:
 * 🌟 #RIVER/USDT 
 * 
 * 🛑 Short 
 * 
 * 📊 EXCHANGE -BYBIT/BINGX/MEXC
 * 
 * 🧑‍🎤 Leverage: 3- 8X 🔥
 * 
 * 👉 Entry = 27.65 - 29.89
 * 
 * TARGET-  26.45 - 25.67 - 24.79 - 22.80 - 20.78+
 * 
 * ❌STOP LOSS - 31.89
 * 
 * Format 2:
 * 🌟 #SOL/USDT 
 * 
 * 🛑 Long /SPOT
 * 
 * 📊 EXCHANGE -BYBIT/BINGX/MEXC
 * 
 * 🧑‍🎤 Leverage: 6-7X 🔥
 * 
 * 👉 Entry = 117-123
 * 
 * TARGET- - 129-131-134-140-150+
 * 
 * ❌STOP LOSS - 109.70
 */
export const starFormatParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  // Trading pair - extract from "#RIVER/USDT" format
  const tradingPairRegex = /#([A-Z0-9]+)\/USDT/i;
  const tradingPairMatch = content.match(tradingPairRegex);
  if (!tradingPairMatch) return null;
  const tradingPair = tradingPairMatch[1].toUpperCase() + 'USDT';

  // Signal type - extract from "🛑 Short" or "🛑 Long" format (with optional /SPOT suffix)
  const shortMatch = content.match(/🛑\s*(?:Short|SHORT|short)(?:\s*\/SPOT)?/i);
  const longMatch = content.match(/🛑\s*(?:Long|LONG|long)(?:\s*\/SPOT)?/i);
  
  if (!shortMatch && !longMatch) return null;
  const signalType: 'long' | 'short' = shortMatch ? 'short' : 'long';

  // Entry price - extract from "👉 Entry = 27.65 - 29.89" format (range)
  const entryPriceStrategy = options?.entryPriceStrategy || 'worst';
  let entryPrice: number | undefined;
  
  const entryPriceRangeMatch = content.match(/👉\s*Entry\s*=\s*([\d.]+)\s*-\s*([\d.]+)/i);
  if (entryPriceRangeMatch) {
    const price1 = parseFloat(entryPriceRangeMatch[1]);
    const price2 = parseFloat(entryPriceRangeMatch[2]);
    if (!isNaN(price1) && !isNaN(price2)) {
      entryPrice = calculateEntryPrice(price1, price2, signalType, entryPriceStrategy);
    }
  } else {
    // Try without emoji: "Entry = 27.65 - 29.89"
    const entryPriceRangeMatch2 = content.match(/Entry\s*=\s*([\d.]+)\s*-\s*([\d.]+)/i);
    if (entryPriceRangeMatch2) {
      const price1 = parseFloat(entryPriceRangeMatch2[1]);
      const price2 = parseFloat(entryPriceRangeMatch2[2]);
      if (!isNaN(price1) && !isNaN(price2)) {
        entryPrice = calculateEntryPrice(price1, price2, signalType, entryPriceStrategy);
      }
    } else {
      // Try single entry price: "Entry = 27.65"
      const entryPriceSingleMatch = content.match(/Entry\s*=\s*([\d.]+)/i);
      if (entryPriceSingleMatch) {
        entryPrice = parseFloat(entryPriceSingleMatch[1]);
      } else {
        // No entry price found - allow undefined for market orders
        entryPrice = undefined;
      }
    }
  }

  // Stop loss - extract from "❌STOP LOSS - 31.89" format
  let stopLossMatch = content.match(/❌STOP\s*LOSS\s*-\s*([\d.]+)/i);
  if (!stopLossMatch) {
    // Try without emoji: "STOP LOSS - 31.89"
    stopLossMatch = content.match(/STOP\s*LOSS\s*-\s*([\d.]+)/i);
  }
  if (!stopLossMatch) {
    // Try other formats: "Stop Loss: 31.89" or "SL: 31.89"
    stopLossMatch = content.match(/(?:Stop\s*Loss|SL|stop\s*loss)[:\s-]+([\d.]+)/i);
  }
  
  if (!stopLossMatch) return null;
  
  // Validate stop loss - must be a valid number (no spaces in the middle)
  const stopLossStr = stopLossMatch[1];
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);

  // Take profits - extract from "TARGET-  26.45 - 25.67 - 24.79 - 22.80 - 20.78+" format
  // Also handles "TARGET- - 129-131-134-140-150+" (double dash format)
  const takeProfits: number[] = [];
  
  // Try "TARGET- -" format (double dash) first
  let takeProfitMatch = content.match(/TARGET\s*-\s*-\s*([\d.\s\-+]+)/i);
  if (!takeProfitMatch) {
    // Try "TARGET-" format with single dash and plus sign
    takeProfitMatch = content.match(/TARGET\s*-\s*([\d.\s\-+]+)/i);
  }
  if (!takeProfitMatch) {
    // Try "Target:" format
    takeProfitMatch = content.match(/Target[:\s-]+([\d.\s\-+]+)/i);
  }
  if (!takeProfitMatch) {
    // Try "TARGET:" format
    takeProfitMatch = content.match(/TARGET[:\s-]+([\d.\s\-+]+)/i);
  }
  
  if (takeProfitMatch) {
    const targetsString = takeProfitMatch[1];
    // Extract all numbers from the targets string
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

  // Leverage - extract from "🧑‍🎤 Leverage: 3- 8X 🔥" format (use lowest value if range)
  let leverageMatch = content.match(/🧑‍🎤\s*Leverage[:\s]*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  if (!leverageMatch) {
    // Try without emoji: "Leverage: 3- 8X"
    leverageMatch = content.match(/Leverage[:\s]*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  }
  if (!leverageMatch) {
    // Try single value: "Leverage: 8X"
    leverageMatch = content.match(/Leverage[:\s]*(\d+(?:\.\d+)?)\s*[Xx]/i);
  }
  
  // Use default leverage of 8x if not found
  let leverage = 8; // Default leverage
  if (leverageMatch) {
    const leverage1 = parseFloat(leverageMatch[1]);
    const leverage2 = leverageMatch[2] ? parseFloat(leverageMatch[2]) : null;
    // Use lowest value if range provided, otherwise use single value
    leverage = leverage2 !== null ? Math.min(leverage1, leverage2) : leverage1;
    if (leverage < 1) return null;
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

