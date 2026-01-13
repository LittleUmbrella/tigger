import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Default parser - handles common signal formats
 * This is a fallback parser that tries to extract order data from various formats
 */
export const defaultParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    // Example message format:
    // "⚡️© PERP/USDT ©⚡️ Exchanges: Pionex, Binance, Bybit Signal Type: Regular (Short) Leverage: 5x-10х Use 3-5% Of Portfolio Entry Targets: 0.7034 🖖🏽 0.717605 Take-Profit Targets: 1) 0.68919 2) 0.67498 3) 0.65366 4) 0.63945 5) 0.61814 6) 0.59682 8) 0.56840 7) 🚀🚀🚀 Stop Targets: 0.76024"
    
    // Also handle format like:
    // "⚡ #1000FLOKI/USDT 📤 Long 💹 Buy: 0.08710 - 0.08457 🧿 Target: 0.08797 - 0.08884 - 0.08973 - 0.09062 - 0.09153 - 0.09256 🧨 StopLoss: 0.08220 🔘 Leverage: 20x"

    // Extract trading pair
    const pairMatch = content.match(/([A-Z0-9]+\/?[A-Z0-9]+)/i);
    if (!pairMatch) return null;
    const tradingPair = pairMatch[1].replace('/', '').toUpperCase();

    // Determine signal type (Long or Short)
    const isLong = /long|📤/i.test(content);
    const isShort = /short|📥/i.test(content);
    const signalType: 'long' | 'short' = isShort ? 'short' : (isLong ? 'long' : 'long'); // Default to long

    // Extract leverage
    const leverageMatch = content.match(/leverage[:\s]*(\d+)[xх]/i) || content.match(/(\d+)[xх]/);
    const leverage = leverageMatch ? parseInt(leverageMatch[1], 10) : 1;

    // Extract entry price(s)
    const entryPatterns = [
      /entry[:\s]*(?:targets?[:\s]*)?([0-9.]+(?:\s*[🖖🏽-]\s*[0-9.]+)*)/i,
      /buy[:\s]*([0-9.]+(?:\s*-\s*[0-9.]+)*)/i
    ];
    let entryPrices: number[] = [];
    for (const pattern of entryPatterns) {
      const match = content.match(pattern);
      if (match) {
        const prices = match[1].match(/[0-9.]+/g);
        if (prices) {
          entryPrices = prices.map(p => parseFloat(p));
          break;
        }
      }
    }
    if (entryPrices.length === 0) return null;
    const entryPrice = entryPrices[0]; // Use first entry price

    // Extract stop loss
    const stopLossPatterns = [
      /stop[:\s]*(?:targets?[:\s]*)?([0-9.]+)/i,
      /stoploss[:\s]*([0-9.]+)/i
    ];
    let stopLoss: number | null = null;
    for (const pattern of stopLossPatterns) {
      const match = content.match(pattern);
      if (match) {
        stopLoss = parseFloat(match[1]);
        break;
      }
    }
    if (!stopLoss) return null;

    // Extract take profit targets
    const tpPatterns = [
      /take[- ]?profit[:\s]*(?:targets?[:\s]*)?(?:1\)[:\s]*)?([0-9.\s\)]+)/i,
      /target[:\s]*([0-9.\s-]+)/i
    ];
    let takeProfits: number[] = [];
    for (const pattern of tpPatterns) {
      const match = content.match(pattern);
      if (match) {
        // Extract all numbers from the match
        const numbers = match[1].match(/[0-9.]+/g);
        if (numbers) {
          takeProfits = numbers.map(n => parseFloat(n)).filter(n => !isNaN(n));
          break;
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

    const parsedOrder: ParsedOrder = {
      tradingPair,
      leverage,
      entryPrice,
      stopLoss,
      takeProfits,
      signalType,
      entryTargets: entryPrices.length > 1 ? entryPrices : undefined
    };

    // Validate parsed order (only if entryPrice is provided)
    // If validation fails, return null to indicate parsing failure
    if (!validateParsedOrder(parsedOrder, { message: content })) {
      return null;
    }

    return parsedOrder;
  } catch (error) {
    logger.error('Error in defaultParser', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

