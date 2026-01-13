import { ParsedOrder } from '../../../types/order';
import { validateParsedOrder } from '../../../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../../../utils/deduplication.js';
import { calculateEntryPrice } from '../../../utils/entryPriceStrategy.js';
import { ParserOptions } from '../../parserRegistry.js';

const signalTypeRegex = /(?:🟢\s*)?(?:LONG|Long|long)|(?:🔴\s*)?(?:SHORT|Short|short)/i;

export const vipCryptoSignals = (content: string, options?: ParserOptions): ParsedOrder | null => {
  // Channel ID - optional check, don't fail if not present
  const channelIdMatch = content.match(/#(\d+)/);
  if (channelIdMatch && channelIdMatch[1] !== '2427485240') {
    // If channel ID is present but doesn't match, skip
    return null;
  }

  // Trading pair - handle both #SYMBOL/USDT and #SYMBOLUSDT formats (allow single character symbols like #W/USDT)
  const tradingPairRegex = /#([A-Z0-9]+)(?:\/USDT|USDT)/i;
  const tradingPairMatch = content.match(tradingPairRegex);
  if (!tradingPairMatch) return null;
  const tradingPair = tradingPairMatch[1].toUpperCase();

  // Signal type - check first to determine if we should continue
  const signalTypeMatch = content.match(signalTypeRegex);
  if (!signalTypeMatch) return null;
  
  const signalTypeText = signalTypeMatch[0].toLowerCase();
  const signalType: 'long' | 'short' = signalTypeText.includes('short') ? 'short' : 'long';

  // Entry price - extract range and use configured strategy (default: worst), or allow "current"/"market"
  const entryPriceStrategy = options?.entryPriceStrategy || 'worst';
  let entryPrice: number | undefined;
  const entryPriceCurrentMatch = content.match(/(?:LONG|BUY|SHORT|SELL|Entry|ENTRY|Entry Price|Entry Targets|Buy)[:\s=]*-?\s*(current|market|CMP)/i);
  if (entryPriceCurrentMatch) {
    // Entry price is "current" or "market" - leave undefined for market order
    entryPrice = undefined;
  } else {
    // Try range format: "Entry: 0.3140 - 0.3100" or "Entry = 2.17-2.05" or "Entry: 0.48-0.46" or "Entry - 0.80-0.821" or "📍Entry - 0.643-0.662" or "ENTRY :- 1.234$ - 1.244$" or "Entry Price: 598-560" or "➡️Entry Price: 598-560"
    const entryPriceRangeMatch = content.match(/(?:LONG|BUY|SHORT|SELL|Entry|ENTRY|Entry Price|Entry Targets|📍Entry|ENTRY|Buy|➡️Entry Price)[:\s=]*-?\s*([\d.]+)\s*-\s*([\d.]+)/i);
    if (entryPriceRangeMatch) {
      const price1 = parseFloat(entryPriceRangeMatch[1]);
      const price2 = parseFloat(entryPriceRangeMatch[2]);
      // Use configured strategy (worst or average)
      entryPrice = calculateEntryPrice(price1, price2, signalType, entryPriceStrategy);
    } else {
      // Try "Entry Targets: 1) 51.70 2) 46.00" - use first entry target
      const entryTargetsMatch = content.match(/Entry Targets?\s*:\s*1\)\s*([\d.]+)/i);
      if (entryTargetsMatch) {
        entryPrice = parseFloat(entryTargetsMatch[1]);
      } else {
        // Try single entry price: "Entry Price: 6.27" or "📍Entry - 0.643" (with emoji) or "Buy: 0.1116" or "➡️Entry Price: 6.27"
        const entryPriceSingleMatch = content.match(/(?:LONG|BUY|SHORT|SELL|Entry|ENTRY|Entry Price|📍Entry|Buy|➡️Entry Price)[:\s=]*-?\s*([\d.]+)/i);
        if (entryPriceSingleMatch) {
          entryPrice = parseFloat(entryPriceSingleMatch[1]);
        } else {
          // No entry price found - allow undefined for market orders
          entryPrice = undefined;
        }
      }
    }
  }

  // Stop loss - handle various formats: "Stop Loss: 0.3000", "❌Stop Loss 0.3000", "Stop Loss - 2.0", "STOP LOSS - 2.0", "Stoploss: 0.44", "Stop-Loss: 6.08", "⛔Stop loss :- 1.1965$", "Stop: 5.1000"
  // Skip malformed stop losses like "Stop Loss -0. 84" (has space in number)
  let stopLossMatch = content.match(/(?:StopLoss|stoploss|❌Stop Loss|Stop Loss|Stop loss|SL|stop|STOP LOSS|Stop-Loss|Stoploss|⛔Stop loss|Stop)[:\s-]+([\d.]+)/i);
  if (!stopLossMatch) return null;
  
  // Validate stop loss - must be a valid number (no spaces in the middle)
  const stopLossStr = stopLossMatch[1];
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);

  // Take profits - extract all numbers from targets line
  // Handle formats with or without 🚀, with various separators
  const takeProfits: number[] = [];
  
  // Try multiple patterns for take profits
  // Pattern 1: "Targets: 0.3250 - 0.3400 - 0.3600 + 🚀"
  let takeProfitMatch = content.match(/Targets?:?\s*[:\-]?\s*([\d.\s\-+]+?)(?:\s*\+?\s*🚀|👩‍🚀|$)/i);
  if (!takeProfitMatch) {
    // Pattern 2: "TP: 0.3250 - 0.3400" or "Target: 0.3250 - 0.3400" or "TARGET- 2.23-2.30" or "Targets : 0.50-0.55" or "💸TP :- 1.26$ - 1.274$"
    takeProfitMatch = content.match(/(?:TP|Target|TARGET|Targets|💸TP)[:\s=-]+([\d.\s\-+$]+)/i);
  }
  if (!takeProfitMatch) {
    // Pattern 3: "🎯 5.135 2) 🎯 5.25" format
    takeProfitMatch = content.match(/Targets?:?\s*([\d.\s\)]+)/i);
  }
  if (!takeProfitMatch) {
    // Pattern 4: "🎯1 Target - 4.470$ 🎯2 Target - 6.560$"
    takeProfitMatch = content.match(/Targets?:?\s*([\d.\s\$]+)/i);
  }
  if (!takeProfitMatch) {
    // Pattern 5: "💫Take-Profit 1: 6.47 💫Take-Profit 2: 6.67" (numbered targets with emoji prefix) - capture everything after first 💫Take-Profit
    takeProfitMatch = content.match(/💫Take-Profit[\s\d:]+([\d.\s💫]+?)(?:\s*Mid-Term|⛔|🎗|$)/i);
  }
  if (!takeProfitMatch) {
    // Pattern 6: "Take-Profit 1: 6.47 💫Take-Profit 2: 6.67" (numbered targets)
    takeProfitMatch = content.match(/(?:Take-Profit|Take Profit|TP)[\s\d:]+([\d.\s💫]+?)(?:\s*Mid-Term|⛔|🎗|$)/i);
  }
  if (!takeProfitMatch) {
    // Pattern 7: "📌Take-Profit Targets: 1) 53.50💲 2) 55.50💲" (numbered with emoji)
    takeProfitMatch = content.match(/Take-Profit Targets?:?\s*([\d.\s\)💲💵]+)/i);
  }
  if (!takeProfitMatch) {
    // Pattern 8: "💫Take-Profit 610 💫Take-Profit 640" (multiple take profits without numbers)
    takeProfitMatch = content.match(/💫Take-Profit[\s\d:]*([\d.\s💫]+)/i);
  }
  if (!takeProfitMatch) {
    // Pattern 9: "Target: 0.1127 - 0.1138" (simple Target format)
    takeProfitMatch = content.match(/Target[:\s]+([\d.\s\-]+)/i);
  }
  
  if (takeProfitMatch) {
    const targetsString = takeProfitMatch[1];
    // Extract all numbers from the targets string, filtering out malformed ones (with spaces in middle)
    const targetNumbers = targetsString.match(/[\d.]+/g);
    if (targetNumbers) {
      // Filter out numbers that are part of malformed entries like "0 0.60" (should be "0.60")
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

  // Leverage - extract number and use lowest value if range
  // Handle formats: "20X To 10X", "20x to 10x", "20X 10X", "20.0X To 10.0X", "20X - 10X", "10X To 20X Only", "2-3X", "20X(", "Leverage [20x Cross)", "10X - 20X"
  let leverageMatch = content.match(/Leverage[:\s\[]*(\d+(?:\.\d+)?)\s*[Xx](?:\s*(?:To|to|-)\s*(\d+(?:\.\d+)?)\s*[Xx](?:\s+Only)?)?/i);
  // Handle "10X To 20X Only" format specifically
  if (!leverageMatch) {
    leverageMatch = content.match(/Leverage[:\s\[]*(\d+(?:\.\d+)?)\s*[Xx]\s*To\s*(\d+(?:\.\d+)?)\s*[Xx]\s*Only/i);
  }
  if (!leverageMatch) {
    // Try format: "Leverage: 2-3X" (dash between numbers) or "10X - 20X" (dash format)
    leverageMatch = content.match(/Leverage[:\s\[]*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  }
  if (!leverageMatch) {
    // Try format: "Leverage: 20X( " or "Leverage [20x Cross)" or single value
    leverageMatch = content.match(/Leverage[:\s\[]*(\d+(?:\.\d+)?)\s*[Xx]/i);
  }
  // Try format without "Leverage" keyword: "10X - 20X leverage" or "5X - 15X leverage"
  if (!leverageMatch) {
    leverageMatch = content.match(/(\d+(?:\.\d+)?)\s*[Xx]\s*-\s*(\d+(?:\.\d+)?)\s*[Xx]\s*leverage/i);
  }
  if (!leverageMatch) {
    leverageMatch = content.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[Xx]\s*leverage/i);
  }
  
  if (!leverageMatch) return null;
  
  const leverage1 = parseFloat(leverageMatch[1]);
  const leverage2 = leverageMatch[2] ? parseFloat(leverageMatch[2]) : null;
  // Use lowest value if range provided, otherwise use single value
  const leverage = leverage2 !== null ? Math.min(leverage1, leverage2) : leverage1;
  if (leverage < 1) return null;

  const parsedOrder: ParsedOrder = {
    tradingPair,
    entryPrice,
    stopLoss,
    takeProfits,
    leverage,
    signalType,
  };

  // Validate parsed order (only if entryPrice is provided)
  // If validation fails, return null to indicate parsing failure
  if (!validateParsedOrder(parsedOrder, { message: content })) {
    return null;
  }

  return parsedOrder;
};
