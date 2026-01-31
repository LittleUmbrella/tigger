import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parser for "big" format messages like:
 * 
 * Format 1:
 * Gold buy setup.
 * 
 * Entry: 5503
 * SL: 5463
 * TP: 5596
 * 
 * Manage your risk
 * 
 * Format 2:
 * 🛎️ XAUUSD trade projection🛎️
 * 
 * Entry: 4624
 * Sl: 4630
 * Tp: 4579
 * 
 * Manage your risk
 * 
 * Format 3:
 * 🛎️Xauusd Buy Limit🛎️
 * 
 * Entry : 4490
 * SL: 4483
 * TP: 4500
 * 
 * Manage your risk
 */
export const bigParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  // Trading pair - try multiple formats
  let tradingPair: string | null = null;
  
  // Format 1: "Gold buy setup." or "GOLD buy setup."
  const format1Match = content.match(/([A-Z][A-Z0-9a-z]*)\s+(?:buy|sell)\s+setup/i);
  if (format1Match) {
    tradingPair = format1Match[1].toUpperCase();
  }
  
  // Format 2: "🛎️ XAUUSD trade projection🛎️" - extract trading pair after emoji
  if (!tradingPair) {
    const format2Match = content.match(/[^\w]*([A-Z][A-Z0-9]+)\s+trade\s+projection/i);
    if (format2Match) {
      tradingPair = format2Match[1].toUpperCase();
    }
  }
  
  // Format 3: "🛎️Xauusd Buy Limit🛎️" - extract trading pair (no space after emoji, "Buy Limit" instead of "trade projection")
  if (!tradingPair) {
    const format3Match = content.match(/[^\w]*([A-Z][A-Z0-9a-z]+)\s+(?:Buy|Sell)\s+Limit/i);
    if (format3Match) {
      tradingPair = format3Match[1].toUpperCase();
    }
  }
  
  // Fallback: try to find any uppercase trading pair symbol (like XAUUSD, BTCUSDT, etc.)
  if (!tradingPair) {
    const symbolMatch = content.match(/\b([A-Z]{3,10}(?:USD|USDT|USDC)?)\b/);
    if (symbolMatch) {
      tradingPair = symbolMatch[1].toUpperCase();
    }
  }
  
  if (!tradingPair) return null;

  // Translate trading pair symbols
  // Translate "XAU" or "GOLD" (case-insensitive) to "PAXG"
  // Translate "USD" to "USDT"
  let normalizedPair = tradingPair.toUpperCase();
  
  // Replace XAU or GOLD with PAXG (case-insensitive, anywhere in the pair)
  normalizedPair = normalizedPair.replace(/XAU/g, 'PAXG');
  normalizedPair = normalizedPair.replace(/GOLD/g, 'PAXG');
  
  // Replace USD with USDT (only if it's not already USDT or USDC)
  normalizedPair = normalizedPair.replace(/USD$/g, 'USDT');
  normalizedPair = normalizedPair.replace(/USD([^TDC])/g, 'USDT$1');
  
  tradingPair = normalizedPair;

  // Signal type - try to extract from "buy"/"sell" keywords first
  let signalType: 'long' | 'short' | null = null;
  const buyMatch = content.match(/\b(buy|BUY)\b/i);
  const sellMatch = content.match(/\b(sell|SELL)\b/i);
  
  if (buyMatch) {
    signalType = 'long';
  } else if (sellMatch) {
    signalType = 'short';
  }

  // Entry price - extract from "Entry: 5503" or "Entry : 4490" format (handles optional space before/after colon)
  const entryPriceMatch = content.match(/Entry\s*:\s*([\d.]+)/i);
  if (!entryPriceMatch) return null;
  
  const entryPriceStr = entryPriceMatch[1];
  if (entryPriceStr.includes(' ') || isNaN(parseFloat(entryPriceStr))) {
    return null; // Malformed entry price
  }
  const entryPrice = parseFloat(entryPriceStr);

  // Stop loss - extract from "SL:" or "Sl:" format (case-insensitive)
  const stopLossMatch = content.match(/S[Ll][:\s]+([\d.]+)/i);
  if (!stopLossMatch) return null;
  
  const stopLossStr = stopLossMatch[1];
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);

  // Take profit - extract from "TP:" or "Tp:" format (case-insensitive)
  // This format typically has a single TP, but we'll handle multiple if present
  const takeProfits: number[] = [];
  
  // Try "TP:" or "Tp:" format (single or multiple, case-insensitive)
  const tpMatch = content.match(/T[Pp][:\s]+([\d.\s\-\$]+)/i);
  if (tpMatch) {
    const tpString = tpMatch[1];
    // Extract all numbers from the TP string
    const tpNumbers = tpString.match(/[\d.]+/g);
    if (tpNumbers) {
      const validTPs = tpNumbers
        .map(t => parseFloat(t))
        .filter(t => !isNaN(t) && t > 0);
      takeProfits.push(...validTPs);
    }
  }
  
  if (takeProfits.length === 0) return null;
  
  // Infer signal type from price relationships if not found from keywords
  if (!signalType) {
    // For long: Entry < TP, Entry > SL
    // For short: Entry > TP, Entry < SL
    const firstTP = takeProfits[0];
    if (entryPrice < firstTP && entryPrice > stopLoss) {
      signalType = 'long';
    } else if (entryPrice > firstTP && entryPrice < stopLoss) {
      signalType = 'short';
    } else {
      // If we can't infer, default to long (most common)
      signalType = 'long';
    }
  }

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

