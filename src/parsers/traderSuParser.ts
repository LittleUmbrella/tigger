import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';

/**
 * Parser for Trader Su gold signals (clone of ctrader_gold with entry parsing restored).
 *
 * Asset: gold, XAU, XAUT, or XAUUSD (case-insensitive)
 * SL/TP: space or colon separator (e.g. "SL 5184" or "SL:5184", "TP 5203" or "TP:5203")
 *
 * When "now" precedes the entry range on the first line, the signal is market execution
 * (entryPrice omitted, marketExecution true) — channel useMarketRangeForEntry applies.
 * Otherwise entry is parsed from @price or "- price" and placed as a limit at that level.
 *
 * Format 1 (limit — no NOW on first line):
 * gold buy - 5054
 * SL 5052
 * TP 5066
 *
 * Format 2 (limit):
 * gold buy @5055 - 5051
 * SL 5049
 * TP 5066
 *
 * Format 3 (market — NOW on first line):
 * gold buy Now!! - 5054
 * SL 5052
 * TP 5066
 *
 * Format 4 (market):
 * gold buy Now!!@5055 - 5051
 * SL 5049
 * TP 5066
 *
 * Format 5 (compact market):
 * XAUUSD BUY NOW @5193 - 5187 SL:5184 TP:5203 TP:5210 TP:5218
 *
 * Optional leading # or $ (e.g. #XAUUSD …) is ignored for matching.
 */
export const traderSuParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = content.trim();

    const tradingPairMatch = normalizedContent.match(/^#?\$?\s*(gold|XAU|XAUT|XAUUSD)\s+/i);
    if (!tradingPairMatch) return null;

    const tradingPair = normalizeAssetAliasToCTraderPair(tradingPairMatch[1]);

    const buyMatch = normalizedContent.match(/buy/i);
    const sellMatch = normalizedContent.match(/sell/i);

    if (!buyMatch && !sellMatch) return null;
    const signalType: 'long' | 'short' = buyMatch ? 'long' : 'short';

    const firstLine = normalizedContent.split(/\r?\n/)[0] ?? '';
    const nowPrecedesEntry = /\bnow\b/i.test(firstLine);

    let entryPrice: number | undefined;
    let marketExecution = false;

    if (nowPrecedesEntry) {
      marketExecution = true;
    } else {
      const format2Match = normalizedContent.match(/@\s*([\d.]+)/i);
      if (format2Match) {
        entryPrice = parseFloat(format2Match[1]);
        if (isNaN(entryPrice) || entryPrice <= 0) return null;
      } else {
        const format1Match = normalizedContent.match(/-\s*([\d.]+)/);
        if (format1Match) {
          entryPrice = parseFloat(format1Match[1]);
          if (isNaN(entryPrice) || entryPrice <= 0) return null;
        } else {
          return null;
        }
      }
    }

    const stopLossMatch = normalizedContent.match(/S[Ll][\s:]+([\d.]+)/i);
    if (!stopLossMatch) return null;

    const stopLoss = parseFloat(stopLossMatch[1]);
    if (isNaN(stopLoss) || stopLoss <= 0) return null;

    const takeProfits: number[] = [];
    const tpPattern = /T[Pp][\s:]+([\d.]+)/gi;
    let tpMatch;

    while ((tpMatch = tpPattern.exec(normalizedContent)) !== null) {
      const tpValue = parseFloat(tpMatch[1]);
      if (!isNaN(tpValue) && tpValue > 0) {
        takeProfits.push(tpValue);
      }
    }

    if (takeProfits.length === 0) return null;

    if (signalType === 'long') {
      takeProfits.sort((a, b) => a - b);
    } else {
      takeProfits.sort((a, b) => b - a);
    }

    const deduplicatedTPs = deduplicateTakeProfits(takeProfits, signalType);
    if (deduplicatedTPs.length === 0) return null;

    const leverage = 20;

    const parsedOrder: ParsedOrder = {
      tradingPair,
      entryPrice,
      stopLoss,
      takeProfits: deduplicatedTPs,
      leverage,
      signalType,
      ...(marketExecution ? { marketExecution: true } : { marketExecution: false }),
    };

    if (!validateParsedOrder(parsedOrder, { message: content })) {
      return null;
    }

    return parsedOrder;
  } catch {
    return null;
  }
};
