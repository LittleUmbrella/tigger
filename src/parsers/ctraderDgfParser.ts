import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';
import { logger } from '../utils/logger.js';

type TpToken = { kind: 'number'; value: number } | { kind: 'open' };

/** Ordered TP lines: numeric price or the word "open" (case-insensitive). */
const parseTpTokens = (content: string): TpToken[] => {
  const re = /T[Pp]\d*[\s:]*@?\s*([\d.]+|open)\b/gi;
  const out: TpToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1].trim().toLowerCase();
    if (raw === 'open') {
      out.push({ kind: 'open' });
      continue;
    }
    const n = parseFloat(raw);
    if (!isNaN(n) && n > 0) {
      out.push({ kind: 'number', value: n });
    }
  }
  return out;
};

/** Mean gap between consecutive numeric TPs in message order. */
const meanNumericGap = (nums: number[]): number => {
  if (nums.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    sum += nums[i + 1] - nums[i];
  }
  return sum / (nums.length - 1);
};

/**
 * Fills "open" slots: between two numerics uses even steps; trailing uses avgStep from numeric gaps.
 * Leading opens are skipped until the first number exists.
 */
const resolveTpTokensWithOpen = (tokens: TpToken[], avgStep: number): number[] => {
  let i = 0;
  while (i < tokens.length && tokens[i].kind === 'open') {
    i++;
  }

  const result: number[] = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'number') {
      result.push(t.value);
      i++;
      continue;
    }

    let j = i;
    while (j < tokens.length && tokens[j].kind === 'open') {
      j++;
    }
    const openCount = j - i;
    const prev = result[result.length - 1];
    if (prev === undefined) {
      i = j;
      continue;
    }

    const nextTok = j < tokens.length ? tokens[j] : undefined;
    if (nextTok?.kind === 'number') {
      const next = nextTok.value;
      const step = (next - prev) / (openCount + 1);
      for (let k = 1; k <= openCount; k++) {
        result.push(prev + step * k);
      }
      i = j;
    } else {
      let last = prev;
      for (let k = 1; k <= openCount; k++) {
        last += avgStep;
        result.push(last);
      }
      i = j;
    }
  }
  return result;
};

/**
 * Parser for DGF-style cTrader signals (channel ctrader_dgf): gold/XAU and
 * forex pairs written as Buy/Sell NOW #SYMBOL @ entry. "gold" / XAU family maps to XAUUSD;
 * other #symbols (e.g. EURNZD) are left unchanged.
 *
 * Format 1:
 * XAUUSD BUY NOW @ 4450
 *
 * SL: Solid break @ 4442
 *
 * TP: 4458
 * TP: 4466
 *
 * Format 2:
 * SELL XAUUSD 4455.7
 *
 * TP1: 4453.7
 * TP2: 4450.7
 * TP3: 4440.7
 *
 * SL: 4470.7
 *
 * Format 3:
 * Gold buy now 4561 - 4557
 *
 * SL: 4552
 *
 * TP: 4563
 * TP: 4565
 * …
 * TP: open
 *
 * Entry: price after the last "-" on the first line (same idea as ctrader gold " - 5054"), or a single price after "now" if there is no dash range.
 * "TP: open" is extrapolated from the mean gap between numeric TPs (or between adjacent numerics when open is between them). With only one numeric TP, open lines are ignored.
 *
 * Format 4:
 * XAUUSD SELL NOW 4345+4350
 *
 * SL 4364
 *
 * TP 4340
 * …
 *
 * Entry range A+B: use the price after "+" (here 4350), analogous to the price after "-" in Format 3.
 *
 * Format 5 (forex / any #symbol):
 * Buy NOW #EURNZD @ 1.99376
 *
 * SL @ 1.98373
 *
 * TP @ 2.01364
 */
export const ctraderDgfParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = content.trim();
    const lines = normalizedContent.split(/\r?\n/);
    const firstLine = lines[0] ?? '';

    const hashNowPair = firstLine.match(
      /^\s*(buy|sell)\s+now\s+#([A-Za-z0-9]+)\s+@\s*([\d.]+)/i,
    );

    const sideFirst = firstLine.match(
      /^\s*(buy|sell)\s+(gold|XAU|XAUT|XAUUSD)\s+([\d.]+)/i,
    );

    let tradingPair: string;
    let signalType: 'long' | 'short';
    let entryPrice: number | undefined;

    if (hashNowPair) {
      signalType = hashNowPair[1].toLowerCase() === 'buy' ? 'long' : 'short';
      tradingPair = normalizeAssetAliasToCTraderPair(hashNowPair[2]);
      entryPrice = parseFloat(hashNowPair[3]);
      if (isNaN(entryPrice) || entryPrice <= 0) return null;
    } else if (sideFirst) {
      signalType = sideFirst[1].toLowerCase() === 'buy' ? 'long' : 'short';
      tradingPair = normalizeAssetAliasToCTraderPair(sideFirst[2]);
      entryPrice = parseFloat(sideFirst[3]);
      if (isNaN(entryPrice) || entryPrice <= 0) return null;
    } else {
      const tradingPairMatch = normalizedContent.match(/^(gold|XAU|XAUT|XAUUSD)\s+/i);
      if (!tradingPairMatch) return null;

      tradingPair = normalizeAssetAliasToCTraderPair(tradingPairMatch[1]);

      const buyMatch = normalizedContent.match(/buy/i);
      const sellMatch = normalizedContent.match(/sell/i);
      if (!buyMatch && !sellMatch) return null;
      signalType = buyMatch ? 'long' : 'short';

      const entryAtFirst = firstLine.match(/@\s*([\d.]+)/i);
      if (entryAtFirst) {
        entryPrice = parseFloat(entryAtFirst[1]);
        if (isNaN(entryPrice) || entryPrice <= 0) return null;
      } else {
        const dashEntry = firstLine.match(/-\s*([\d.]+)/);
        if (dashEntry) {
          entryPrice = parseFloat(dashEntry[1]);
          if (isNaN(entryPrice) || entryPrice <= 0) return null;
        } else {
          const plusRange = firstLine.match(/([\d.]+)\s*\+\s*([\d.]+)/);
          if (plusRange) {
            entryPrice = parseFloat(plusRange[2]);
            if (isNaN(entryPrice) || entryPrice <= 0) return null;
          } else {
            const nowSingle = firstLine.match(/\bnow\s+([\d.]+)/i);
            if (nowSingle) {
              entryPrice = parseFloat(nowSingle[1]);
              if (isNaN(entryPrice) || entryPrice <= 0) return null;
            }
          }
        }
      }
    }

    let stopLoss: number | undefined;
    const slLine = lines.find((line) => /^\s*SL[\s:]/i.test(line));
    if (slLine) {
      const slAfterAt = slLine.match(/@\s*([\d.]+)/);
      if (slAfterAt) {
        stopLoss = parseFloat(slAfterAt[1]);
      } else {
        const slPlain = slLine.match(/SL[\s:]+([\d.]+)/i);
        if (slPlain) stopLoss = parseFloat(slPlain[1]);
      }
    }
    if (stopLoss === undefined || isNaN(stopLoss) || stopLoss <= 0) return null;

    const tpTokens = parseTpTokens(normalizedContent);
    const numericTps = tpTokens
      .filter((t): t is { kind: 'number'; value: number } => t.kind === 'number')
      .map((t) => t.value);

    if (numericTps.length === 0) {
      logger.warn('ctrader_dgf: no numeric take profits; skipping message', {
        preview: normalizedContent.slice(0, 200),
      });
      return null;
    }

    const hasOpen = tpTokens.some((t) => t.kind === 'open');
    let takeProfits: number[];
    if (numericTps.length === 1) {
      takeProfits = [numericTps[0]];
    } else if (hasOpen) {
      const avgStep = meanNumericGap(numericTps);
      takeProfits = resolveTpTokensWithOpen(tpTokens, avgStep);
    } else {
      takeProfits = [...numericTps];
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
    };

    if (!validateParsedOrder(parsedOrder, { message: content })) {
      return null;
    }

    return parsedOrder;
  } catch {
    return null;
  }
};
