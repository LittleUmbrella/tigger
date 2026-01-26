import { ParsedOrder } from '../../../types/order';
import { validateParsedOrder } from '../../../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../../../utils/deduplication.js';
import { calculateEntryPrice } from '../../../utils/entryPriceStrategy.js';
import { ParserOptions } from '../../parserRegistry.js';

export const connect = (content: string, options?: ParserOptions): ParsedOrder | null => {
  // Signal type - check first to determine if we should continue
  // Handle format: "Signal type: LONG🟢" or "Signal type: SHORT🔴"
  const signalTypeMatch = content.match(/Signal type:\s*(Long|Short|LONG|SHORT)/i);
  if (!signalTypeMatch) return null;
  const signalTypeText = signalTypeMatch[1].toUpperCase();
  const signalType: 'long' | 'short' = signalTypeText === 'SHORT' ? 'short' : 'long';

  // Trading pair - handle format: "#2Z/USDT" (with # prefix)
  let pairMatch = content.match(/#(\w+)\s*\/\s*USDT/i);
  if (!pairMatch) {
    // Try format without # prefix: "2Z/USDT"
    pairMatch = content.match(/(\w+)\s*\/\s*USDT/i);
    if (!pairMatch) return null;
  }
  const tradingPair = pairMatch[1].toUpperCase();

  // Leverage - extract number from "Leverage: 50x"
  const leverageMatch = content.match(/Leverage:\s*(\d+(?:\.\d+)?)\s*[Xx]/i);
  if (!leverageMatch) return null;
  const leverage = parseFloat(leverageMatch[1]);
  if (leverage < 1 || isNaN(leverage)) return null;

  // Entry price - handle format: "Entry : 0.12446" (single value, optional space before colon)
  const entryPriceStrategy = options?.entryPriceStrategy || 'worst';
  let entryPrice: number | undefined;
  
  // Try single entry price: "Entry : 0.12446" or "Entry: 0.12446"
  const entryPriceMatch = content.match(/Entry\s*:\s*([\d,]+\.?\d*)/i);
  if (entryPriceMatch) {
    // Remove commas from number before parsing
    const priceStr = entryPriceMatch[1].replace(/,/g, '');
    entryPrice = parseFloat(priceStr);
    if (isNaN(entryPrice) || entryPrice <= 0) {
      return null;
    }
  } else {
    // No entry price found - allow undefined for market orders
    entryPrice = undefined;
  }

  // Stop loss - handle format: "⚠️SL: 0.11889" or "SL: 0.11889"
  let stopLossMatch = content.match(/(?:⚠️|❌)?\s*SL\s*:\s*([\d,]+\.?\d*)/i);
  if (!stopLossMatch) {
    // Try without emoji prefix
    stopLossMatch = content.match(/SL\s*:\s*([\d,]+\.?\d*)/i);
  }
  if (!stopLossMatch) return null;
  
  // Validate stop loss - must be a valid number
  let stopLossStr = stopLossMatch[1];
  // Remove commas from number
  stopLossStr = stopLossStr.replace(/,/g, '');
  if (stopLossStr.includes(' ') || isNaN(parseFloat(stopLossStr))) {
    return null; // Malformed stop loss
  }
  const stopLoss = parseFloat(stopLossStr);
  if (stopLoss <= 0) return null;

  // Take profits - extract from "Take Profit Targets: ➖ 0.12800 ➖ 0.13200 ➖ 0.13600 ➖ 0.14000 ➖ 0.14491"
  const takeProfits: number[] = [];
  
  // Find the "Take Profit Targets:" section
  const targetsMatch = content.match(/Take Profit Targets:\s*([\d.\s➖]+)/i);
  if (!targetsMatch) {
    // Try alternative format without "Take Profit"
    const altTargetsMatch = content.match(/Targets?:\s*([\d.\s➖]+)/i);
    if (!altTargetsMatch) return null;
    
    // Extract all numbers from the targets section
    const targetNumbers = altTargetsMatch[1].match(/[\d,]+\.?\d*/g);
    if (targetNumbers) {
      const parsedNumbers = targetNumbers
        .map(t => parseFloat(t.replace(/,/g, '')))
        .filter(t => !isNaN(t) && t > 0);
      takeProfits.push(...parsedNumbers);
    }
  } else {
    // Extract all numbers from the targets section (separated by ➖ or spaces)
    const targetNumbers = targetsMatch[1].match(/[\d,]+\.?\d*/g);
    if (targetNumbers) {
      const parsedNumbers = targetNumbers
        .map(t => parseFloat(t.replace(/,/g, '')))
        .filter(t => !isNaN(t) && t > 0);
      takeProfits.push(...parsedNumbers);
    }
  }
  
  if (takeProfits.length === 0) return null;

  // Deduplicate take profits
  const deduplicatedTPs = deduplicateTakeProfits(takeProfits, signalType);
  
  // Replace takeProfits with deduplicated version
  takeProfits.length = 0;
  takeProfits.push(...deduplicatedTPs);
  
  if (takeProfits.length === 0) return null;

  const parsedOrder: ParsedOrder = {
    tradingPair: `${tradingPair}/USDT`,
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

