import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { ParserOptions } from './parserRegistry.js';

/** Decimal with optional US thousands separators (e.g. 2,201.43). */
const RE_USD_GROUP = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';

const parseUsdPrice = (raw: string): number | null => {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/\+$/, '').replace(/,/g, '');
  if (cleaned === '' || cleaned.includes(' ')) return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
};

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
  
  const entryPriceRangeMatch = content.match(
    new RegExp(`👉\\s*Entry\\s*=\\s*\\$?(${RE_USD_GROUP})\\s*-\\s*\\$?(${RE_USD_GROUP})`, 'i'),
  );
  if (entryPriceRangeMatch) {
    const price1 = parseUsdPrice(entryPriceRangeMatch[1]);
    const price2 = parseUsdPrice(entryPriceRangeMatch[2]);
    if (price1 !== null && price2 !== null) {
      entryPrice = calculateEntryPrice(price1, price2, signalType, entryPriceStrategy);
    }
  } else {
    // Try without emoji: "Entry = 27.65 - 29.89" (optional $ on each side)
    const entryPriceRangeMatch2 = content.match(
      new RegExp(`Entry\\s*=\\s*\\$?(${RE_USD_GROUP})\\s*-\\s*\\$?(${RE_USD_GROUP})`, 'i'),
    );
    if (entryPriceRangeMatch2) {
      const price1 = parseUsdPrice(entryPriceRangeMatch2[1]);
      const price2 = parseUsdPrice(entryPriceRangeMatch2[2]);
      if (price1 !== null && price2 !== null) {
        entryPrice = calculateEntryPrice(price1, price2, signalType, entryPriceStrategy);
      }
    } else {
      // Try breakout format: "💰 Entry › $0.078100" or "Entry › $0.078100"
      const entryBreakoutMatch = content.match(new RegExp(`Entry\\s*›\\s*\\$?(${RE_USD_GROUP})`, 'i'));
      if (entryBreakoutMatch) {
        entryPrice = parseUsdPrice(entryBreakoutMatch[1]) ?? undefined;
      } else {
        // Try single entry price: "Entry = 27.65" (avoid matching the low end of a range: require no second dash-price)
        const entryPriceSingleMatch = content.match(
          new RegExp(`Entry\\s*=\\s*\\$?(${RE_USD_GROUP})(?!\\s*-\\s*\\$?${RE_USD_GROUP})`, 'i'),
        );
        if (entryPriceSingleMatch) {
          entryPrice = parseUsdPrice(entryPriceSingleMatch[1]) ?? undefined;
        } else {
          entryPrice = undefined;
        }
      }
    }
  }

  // Stop loss - extract from multiple formats:
  // Classic: "❌STOP LOSS - 31.89"
  // Breakout: "🛑 SL › $0.075216" (with optional trailing percentage)
  // Optional space after ❌; optional $ before price (e.g. "❌ Stop Loss - $355.30")
  let stopLossMatch = content.match(
    new RegExp(`❌\\s*STOP\\s*LOSS\\s*-\\s*\\$?(${RE_USD_GROUP})`, 'i'),
  );
  if (!stopLossMatch) {
    stopLossMatch = content.match(new RegExp(`STOP\\s*LOSS\\s*-\\s*\\$?(${RE_USD_GROUP})`, 'i'));
  }
  if (!stopLossMatch) {
    // Breakout format: "🛑 SL › $0.075216"
    stopLossMatch = content.match(new RegExp(`🛑\\s*SL\\s*›\\s*\\$?(${RE_USD_GROUP})`, 'i'));
  }
  if (!stopLossMatch) {
    stopLossMatch = content.match(new RegExp(`(?:Stop\\s*Loss|SL|stop\\s*loss)[:\\s-]+\\$?(${RE_USD_GROUP})`, 'i'));
  }

  if (!stopLossMatch) return null;

  const stopLossParsed = parseUsdPrice(stopLossMatch[1]);
  if (stopLossParsed === null) return null;
  const stopLoss = stopLossParsed;

  // Take profits - extract from multiple formats:
  // Classic: "TARGET-  26.45 - 25.67 - 24.79 - 22.80 - 20.78+"
  // Breakout: "🎯 TP1 › $0.080023", "🎯 TP2 › $0.081946", etc.
  const takeProfits: number[] = [];
  
  // Try breakout format first: "🎯 TP1 › $0.080023" (possibly with trailing +10.4%)
  const breakoutTpMatches = content.matchAll(
    new RegExp(`🎯\\s*TP\\d+\\s*›\\s*\\$?(${RE_USD_GROUP})`, 'gi'),
  );
  for (const m of breakoutTpMatches) {
    const val = parseUsdPrice(m[1]);
    if (val !== null && val > 0) takeProfits.push(val);
  }

  if (takeProfits.length === 0) {
    // Fall back to classic TARGET format ($ allowed in target list, e.g. "$296 - $272")
    const targetTail = '[\\d,.\\s\\-+\\$]+';
    let takeProfitMatch = content.match(new RegExp(`TARGET\\s*-\\s*-\\s*(${targetTail})`, 'i'));
    if (!takeProfitMatch) {
      takeProfitMatch = content.match(new RegExp(`TARGET\\s*-\\s*(${targetTail})`, 'i'));
    }
    if (!takeProfitMatch) {
      takeProfitMatch = content.match(new RegExp(`Target[:\\s-]+(${targetTail})`, 'i'));
    }
    if (!takeProfitMatch) {
      takeProfitMatch = content.match(new RegExp(`TARGET[:\\s-]+(${targetTail})`, 'i'));
    }
    
    if (takeProfitMatch) {
      const targetsString = takeProfitMatch[1];
      const targetTokenRe = new RegExp(`\\$?${RE_USD_GROUP}\\+?`, 'g');
      const targetTokens = targetsString.match(targetTokenRe);
      if (targetTokens) {
        const validTargets = targetTokens
          .map(t => parseUsdPrice(t))
          .filter((t): t is number => t !== null && t > 0);
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

