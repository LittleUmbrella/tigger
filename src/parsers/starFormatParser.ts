import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parser for star format messages like:
 * 
 * Format 1 (classic star):
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
 * Format 2 (classic star with double dash targets):
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
 * 
 * Format 3 (breakout expert):
 * 🟢 LONG #ENA/USDT BUY ⚙️ Leverage: 3x — 5x
 * ──────────────────────────
 * 💰 Entry › $0.078100
 * 🎯 TP1 › $0.080023
 * 🎯 TP2 › $0.081946
 * 🎯 TP3 › $0.084830
 * 🛑 SL › $0.075216
 * 
 * Format 4 (breakout expert without leverage, with percentages):
 * 🔴 SHORT #CTSI/USDT SELL
 * ──────────────────────────
 * 💰 Entry › $0.039480
 * 🎯 TP1 › $0.035369 +10.4%
 * 🎯 TP2 › $0.031258 +20.8%
 * 🎯 TP3 › $0.025092 +36.4%
 * 🛑 SL › $0.045646 15.6%
 */
export const starFormatParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  // Trading pair - extract from "#RIVER/USDT" format
  const tradingPairRegex = /#([A-Z0-9]+)\/USDT/i;
  const tradingPairMatch = content.match(tradingPairRegex);
  if (!tradingPairMatch) return null;
  const tradingPair = tradingPairMatch[1].toUpperCase() + 'USDT';

  // Signal type - extract from multiple formats:
  // Classic: "🛑 Short" / "🛑 Long" (with optional /SPOT suffix)
  // Breakout: "🔴 SHORT #.../USDT SELL" / "🟢 LONG #.../USDT BUY"
  const shortMatch = content.match(/🛑\s*(?:Short|SHORT|short)(?:\s*\/\s*SPOT)?/i)
    || content.match(/🛑\s*SPOT\s*\/\s*(?:Short|SHORT|short)/i)
    || content.match(/🔴\s*SHORT\b/i);
  const longMatch = content.match(/🛑\s*(?:Long|LONG|long)(?:\s*\/\s*SPOT)?/i)
    || content.match(/🛑\s*SPOT\s*\/\s*(?:Long|LONG|long)/i)
    || content.match(/🟢\s*LONG\b/i);
  
  if (!shortMatch && !longMatch) return null;
  const signalType: 'long' | 'short' = shortMatch ? 'short' : 'long';

  // Entry price - extract from multiple formats:
  // Classic: "👉 Entry = 27.65 - 29.89" (range) or "Entry = 27.65" (single)
  // Breakout: "💰 Entry › $0.078100" (single with $ prefix)
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
      // Try breakout format: "💰 Entry › $0.078100" or "Entry › $0.078100"
      const entryBreakoutMatch = content.match(/Entry\s*›\s*\$?([\d.]+)/i);
      if (entryBreakoutMatch) {
        entryPrice = parseFloat(entryBreakoutMatch[1]);
      } else {
        // Try single entry price: "Entry = 27.65"
        const entryPriceSingleMatch = content.match(/Entry\s*=\s*([\d.]+)/i);
        if (entryPriceSingleMatch) {
          entryPrice = parseFloat(entryPriceSingleMatch[1]);
        } else {
          entryPrice = undefined;
        }
      }
    }
  }

  // Stop loss - extract from multiple formats:
  // Classic: "❌STOP LOSS - 31.89"
  // Breakout: "🛑 SL › $0.075216" (with optional trailing percentage)
  let stopLossMatch = content.match(/❌STOP\s*LOSS\s*-\s*([\d.]+)/i);
  if (!stopLossMatch) {
    stopLossMatch = content.match(/STOP\s*LOSS\s*-\s*([\d.]+)/i);
  }
  if (!stopLossMatch) {
    // Breakout format: "🛑 SL › $0.075216"
    stopLossMatch = content.match(/🛑\s*SL\s*›\s*\$?([\d.]+)/i);
  }
  if (!stopLossMatch) {
    stopLossMatch = content.match(/(?:Stop\s*Loss|SL|stop\s*loss)[:\s-]+([\d.]+)/i);
  }
  
  if (!stopLossMatch) return null;
  
  // Validate stop loss - must be a valid number (no spaces in the middle)
  const stopLossStr = stopLossMatch[1];
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);

  // Take profits - extract from multiple formats:
  // Classic: "TARGET-  26.45 - 25.67 - 24.79 - 22.80 - 20.78+"
  // Breakout: "🎯 TP1 › $0.080023", "🎯 TP2 › $0.081946", etc.
  const takeProfits: number[] = [];
  
  // Try breakout format first: "🎯 TP1 › $0.080023" (possibly with trailing +10.4%)
  const breakoutTpMatches = content.matchAll(/🎯\s*TP\d+\s*›\s*\$?([\d.]+)/gi);
  for (const m of breakoutTpMatches) {
    const val = parseFloat(m[1]);
    if (!isNaN(val) && val > 0) takeProfits.push(val);
  }

  if (takeProfits.length === 0) {
    // Fall back to classic TARGET format
    let takeProfitMatch = content.match(/TARGET\s*-\s*-\s*([\d.\s\-+]+)/i);
    if (!takeProfitMatch) {
      takeProfitMatch = content.match(/TARGET\s*-\s*([\d.\s\-+]+)/i);
    }
    if (!takeProfitMatch) {
      takeProfitMatch = content.match(/Target[:\s-]+([\d.\s\-+]+)/i);
    }
    if (!takeProfitMatch) {
      takeProfitMatch = content.match(/TARGET[:\s-]+([\d.\s\-+]+)/i);
    }
    
    if (takeProfitMatch) {
      const targetsString = takeProfitMatch[1];
      const targetNumbers = targetsString.match(/[\d.]+/g);
      if (targetNumbers) {
        const validTargets = targetNumbers
          .map(t => parseFloat(t))
          .filter(t => !isNaN(t) && t > 0);
        takeProfits.push(...validTargets);
      }
    }
  }
  
  if (takeProfits.length === 0) return null;

  // Deduplicate take profits
  const deduplicatedTPs = deduplicateTakeProfits(takeProfits, signalType);
  
  // Replace takeProfits with deduplicated version
  takeProfits.length = 0;
  takeProfits.push(...deduplicatedTPs);
  
  if (takeProfits.length === 0) return null;

  // Leverage - extract from multiple formats (use lowest value if range):
  // Classic: "🧑‍🎤 Leverage: 3- 8X 🔥"
  // Breakout: "⚙️ Leverage: 3x — 5x" (em-dash separator, lowercase x)
  let leverageMatch = content.match(/🧑‍🎤\s*Leverage[:\s]*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  if (!leverageMatch) {
    // Breakout/generic range with hyphen, en-dash, or em-dash: "Leverage: 3x — 5x"
    leverageMatch = content.match(/Leverage[:\s]*(\d+(?:\.\d+)?)\s*[Xx]?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  }
  if (!leverageMatch) {
    // Classic range without emoji: "Leverage: 3- 8X"
    leverageMatch = content.match(/Leverage[:\s]*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  }
  if (!leverageMatch) {
    // Single value: "Leverage: 8X" or "Leverage: 8x"
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

