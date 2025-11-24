import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';

/**
 * Parser for emoji-heavy signal format like:
 * "⚡ #SYMBOL/USDT 📥 Short 💹 Buy: 1.0 - 1.1 🧿 Target: 0.9 - 0.8 🧨 StopLoss: 1.2 🔘 Leverage: 20x"
 * 
 * This format uses:
 * - ⚡ at start
 * - #SYMBOL/USDT for trading pair
 * - 📥 for Short, 📤 for Long
 * - 💹 Buy: entry range
 * - 🧿 Target: take profit targets
 * - 🧨 StopLoss: stop loss
 * - 🔘 Leverage: leverage
 */
export const emojiHeavyParser = (content: string): ParsedOrder | null => {
  try {
    // Must start with ⚡
    if (!content.includes('⚡')) return null;

    // Extract trading pair: #SYMBOL/USDT
    const symbolMatch = content.match(/#(\w+)\/USDT/i);
    if (!symbolMatch) return null;
    const tradingPair = symbolMatch[1].toUpperCase();

    // Determine signal type: 📥 = Short, 📤 = Long
    const isShort = content.includes('📥') || /short/i.test(content);
    const isLong = content.includes('📤') || /long/i.test(content);
    const signalType: 'long' | 'short' = isShort ? 'short' : (isLong ? 'long' : 'long');

    // Extract Buy prices (entry range): "💹 Buy: 0.08710 - 0.08457"
    const buyMatch = content.match(/💹\s*Buy:\s*([0-9.]+)\s*-\s*([0-9.]+)/i);
    if (!buyMatch) return null;
    const entryPrices = [parseFloat(buyMatch[1]), parseFloat(buyMatch[2])].sort((a, b) => a - b);
    const entryPrice = entryPrices[0]; // Use lower entry price

    // Extract Targets: "🧿 Target: 0.08797 - 0.08884 - 0.08973..."
    const targetMatch = content.match(/🧿\s*Target:\s*([0-9.\s-+]+)/i);
    if (!targetMatch) return null;
    const targetNumbers = targetMatch[1].match(/[0-9.]+/g);
    if (!targetNumbers || targetNumbers.length === 0) return null;
    const takeProfits = targetNumbers.map(parseFloat).filter(n => !isNaN(n));

    // Extract StopLoss: "🧨 StopLoss: 0.08220"
    const stopLossMatch = content.match(/🧨\s*StopLoss:\s*([0-9.]+)/i);
    if (!stopLossMatch) return null;
    const stopLoss = parseFloat(stopLossMatch[1]);

    // Extract Leverage: "🔘 Leverage: 20x"
    const leverageMatch = content.match(/🔘\s*Leverage:\s*(\d+)x/i);
    const leverage = leverageMatch ? parseInt(leverageMatch[1], 10) : 1;

    // Sort take profits based on signal type
    if (signalType === 'long') {
      takeProfits.sort((a, b) => a - b); // Ascending for long
    } else {
      takeProfits.sort((a, b) => b - a); // Descending for short
    }

    return {
      tradingPair,
      leverage,
      entryPrice,
      stopLoss,
      takeProfits,
      signalType,
      entryTargets: entryPrices.length > 1 ? entryPrices : undefined
    };
  } catch (error) {
    logger.error('Error in emojiHeavyParser', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
};

