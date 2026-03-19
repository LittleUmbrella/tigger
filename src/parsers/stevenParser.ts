import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parser for Steven-format gold trading signals. Similar to ctrader_gold but with different syntax:
 *
 * Format example:
 * 🔴Gold buy now  3956 :3953
 * 🔖take Profit  3961
 * 🔖take Profit  3966
 * 🔖take profit  3990
 * ❌Stop loss .  3946
 *
 * - Asset: gold, XAU, or XAUUSD (case-insensitive, optional leading emoji)
 * - Entry: "Gold buy now 3956 :3953" - "now" indicates market order (entryPrice undefined)
 * - Take profits: "take Profit 3961" or "take profit 3990"
 * - Stop loss: "Stop loss . 3946"
 */
export const stevenParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = content.trim();

    // Extract trading pair - look for gold/XAU/XAUUSD (case-insensitive, allow leading emoji)
    const tradingPairMatch = normalizedContent.match(/\b(gold|XAU|XAUT|XAUUSD)\b/i);
    if (!tradingPairMatch) return null;

    const assetName = tradingPairMatch[1].toUpperCase();
    const tradingPair =
      assetName === 'GOLD' || assetName === 'XAU' || assetName === 'XAUT' || assetName === 'XAUUSD'
        ? 'XAUUSD'
        : `${assetName}USD`;

    // Extract signal type - buy = long, sell = short
    const buyMatch = normalizedContent.match(/\bbuy\b/i);
    const sellMatch = normalizedContent.match(/\bsell\b/i);
    if (!buyMatch && !sellMatch) return null;
    const signalType: 'long' | 'short' = buyMatch ? 'long' : 'short';

    // "now" indicates market order - entry price left undefined
    const nowMatch = normalizedContent.match(/\bnow\b/i);
    let entryPrice: number | undefined;
    if (!nowMatch) {
      // Optional: extract entry from "3956 :3953" style if present
      const firstLine = normalizedContent.split(/\r?\n/)[0] ?? '';
      const entryMatch = firstLine.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/);
      if (entryMatch) {
        entryPrice = parseFloat(entryMatch[1]);
        if (isNaN(entryPrice) || entryPrice <= 0) entryPrice = undefined;
      }
    }

    // Extract stop loss - "Stop loss . 3946" or "Stop loss 3946"
    const stopLossMatch = normalizedContent.match(/Stop\s*loss[\s:.]*([\d.]+)/i);
    if (!stopLossMatch) return null;
    const stopLoss = parseFloat(stopLossMatch[1]);
    if (isNaN(stopLoss) || stopLoss <= 0) return null;

    // Extract take profits - "take Profit 3961" or "take profit 3990"
    const takeProfits: number[] = [];
    const tpPattern = /take\s*[Pp]rofit[\s:.]*([\d.]+)/gi;
    let tpMatch;
    while ((tpMatch = tpPattern.exec(normalizedContent)) !== null) {
      const tpValue = parseFloat(tpMatch[1]);
      if (!isNaN(tpValue) && tpValue > 0) takeProfits.push(tpValue);
    }
    if (takeProfits.length === 0) return null;

    // Sort and deduplicate take profits
    const deduplicatedTPs = deduplicateTakeProfits(takeProfits, signalType);
    if (deduplicatedTPs.length === 0) return null;

    const parsedOrder: ParsedOrder = {
      tradingPair,
      entryPrice,
      stopLoss,
      takeProfits: deduplicatedTPs,
      leverage: 20,
      signalType,
    };

    if (!validateParsedOrder(parsedOrder, { message: content })) {
      return null;
    }

    return parsedOrder;
  } catch {
    return null;
  }
};
