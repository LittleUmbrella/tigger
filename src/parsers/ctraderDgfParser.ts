import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';
import { logger } from '../utils/logger.js';

type TpToken = { kind: 'number'; value: number } | { kind: 'open' };

/**
 * Unicode superscript ordinals after "TP" (e.g. TP¹ TP² …) are not matched by `\d*`.
 * Normalize to ASCII digits so the existing TP regex applies.
 */
const SUPERSCRIPT_DIGIT_MAP: Record<string, string> = {
  '\u00B9': '1',
  '\u00B2': '2',
  '\u00B3': '3',
  '\u2070': '0',
  '\u2074': '4',
  '\u2075': '5',
  '\u2076': '6',
  '\u2077': '7',
  '\u2078': '8',
  '\u2079': '9',
};

const normalizeTpSuperscriptLabels = (content: string): string =>
  content.replace(/(T[Pp])([\u00B9\u00B2\u00B3\u2070\u2074-\u2079]+)/gi, (_full, tp: string, subs: string) => {
    const digits = [...subs].map((ch) => SUPERSCRIPT_DIGIT_MAP[ch] ?? '').join('');
    return digits ? `${tp}${digits}` : _full;
  });

/** Tp 4 — 4738; TP1 ➝ 4723 → TPn: price for the main TP regex. */
const normalizeTpArrowAndEmDashLabels = (content: string): string => {
  let s = content;
  s = s.replace(/T[Pp]\s+(\d+)\s*[\u2014\u2013\-]\s*([\d.]+)/gi, 'TP$1: $2');
  s = s.replace(/T[Pp](\d*)\s+[^\d.\r\n:]{1,40}?\s+([\d.]+)/gi, (_full, idx: string, price: string) =>
    `TP${idx}: ${price}`,
  );
  return s;
};

/** Ordered TP lines: numeric price or the word "open" (case-insensitive). */
const parseTpTokens = (content: string): TpToken[] => {
  const normalized = normalizeTpArrowAndEmDashLabels(normalizeTpSuperscriptLabels(content));
  const re = /T[Pp]\d*[\s:]*@?\s*([\d.]+|open)\b/gi;
  const out: TpToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
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

/** Parse SL from text starting at `SL` through end of line (avoids conflating entry `@` with SL `@`). */
const parseStopLossFromSlClause = (slClause: string): number | undefined => {
  const slAfterAt = slClause.match(/@\s*([\d.]+)/);
  if (slAfterAt) {
    const v = parseFloat(slAfterAt[1]);
    if (!isNaN(v) && v > 0) return v;
  }
  const solidBreak = slClause.match(/\bsolid\s+break\s+([\d.]+)/i);
  if (solidBreak) {
    const v = parseFloat(solidBreak[1]);
    if (!isNaN(v) && v > 0) return v;
  }
  const slPlain = slClause.match(/SL[\s:]+([\d.]+)/i);
  if (slPlain) {
    const v = parseFloat(slPlain[1]);
    if (!isNaN(v) && v > 0) return v;
  }
  return undefined;
};

/**
 * Parser for DGF-style cTrader signals (channel ctrader_dgf): gold/XAU and
 * forex pairs written as Buy/Sell NOW [#]SYMBOL @ entry (# optional). "gold" / XAU family maps to XAUUSD;
 * other symbols (e.g. EURNZD) are left unchanged. Most formats omit entryPrice (market); Format 8 sets entryPrice (limit).
 *
 * Format 1:
 * XAUUSD BUY NOW @ 4450
 *
 * SL: Solid break @ 4442
 * SL: Solid break 4442
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
 * Format 5 (forex / any symbol; # before pair optional):
 * Buy NOW #EURNZD @ 1.99376
 * Buy NOW EURNZD @ 2.00467 SL @ 1.99465 TP @ 2.02456
 *
 * SL @ 1.98373
 *
 * TP @ 2.01364
 *
 * Entry prices in the message are used only to validate structure; ParsedOrder omits
 * entryPrice so execution is always market (cTrader initiator).
 *
 * Format 6 (symbol before side; optional emoji prefix; slash or dash entry range):
 * 🛡XAUUSD SELL 4782/4785
 * 🛡XAUUSD BUY 4718-4714
 *
 * TP¹ 4779 … / Tp1: 4728 …
 * 💣 SL 4791 / 💣Sl: 4710
 *
 * Format 7:
 * 🛡XAUUSD | BUY  4713-4718
 * TP1 ➝ 4723 / Tp 4 — 4738
 *
 * Format 8 (limit — $ prefix, long/short, RR header; Entry/SL/TP lines):
 * $XAUUSD long | +8RR
 * Entry : 4720.00 / SL : 4702.20 / TP : 4800.00
 *
 * Format 9 (limit — BUY/SELL SIGNAL + Entry line; optional emoji on first line):
 * 📢 XAUUSD | SELL SIGNAL 🟢 Entry: 4705-4700 …
 * Entry range: limit price is the second bound (after `-`), same as Format 3 dash convention.
 */
export const ctraderDgfParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = content.trim();
    const lines = normalizedContent.split(/\r?\n/);
    const firstLine = lines[0] ?? '';

    /** Format 8: limit order from explicit Entry line; header uses long|short and optional leading $. */
    const format8Header = firstLine.match(
      /^\s*\$?\s*(gold|XAU|XAUT|XAUUSD)\s+(long|short)\s*\|/i,
    );
    if (format8Header) {
      const entryMatch = normalizedContent.match(/\bEntry\s*:\s*([\d.]+)/i);
      if (!entryMatch) return null;
      const entryPrice = parseFloat(entryMatch[1]);
      if (isNaN(entryPrice) || entryPrice <= 0) return null;

      const slClauseMatch = normalizedContent.match(/\bSL[\s:][^\n]*/i);
      const slClause = slClauseMatch?.[0] ?? '';
      const stopLoss = slClause ? parseStopLossFromSlClause(slClause) : undefined;
      if (stopLoss === undefined || isNaN(stopLoss) || stopLoss <= 0) return null;

      const tpTokens = parseTpTokens(normalizedContent);
      const numericTps = tpTokens
        .filter((t): t is { kind: 'number'; value: number } => t.kind === 'number')
        .map((t) => t.value);
      if (numericTps.length === 0) {
        logger.warn('ctrader_dgf: Format 8 — no numeric take profits; skipping message', {
          preview: normalizedContent.slice(0, 200),
        });
        return null;
      }

      const signalType = format8Header[2].toLowerCase() === 'long' ? 'long' : 'short';
      const tradingPair = normalizeAssetAliasToCTraderPair(format8Header[1]);
      let takeProfits: number[];
      if (numericTps.length === 1) {
        takeProfits = [numericTps[0]];
      } else {
        const hasOpen = tpTokens.some((t) => t.kind === 'open');
        if (hasOpen) {
          const avgStep = meanNumericGap(numericTps);
          takeProfits = resolveTpTokensWithOpen(tpTokens, avgStep);
        } else {
          takeProfits = [...numericTps];
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

      const parsedOrder: ParsedOrder = {
        tradingPair,
        entryPrice,
        marketExecution: false,
        stopLoss,
        takeProfits: deduplicatedTPs,
        leverage: 20,
        signalType,
      };
      if (!validateParsedOrder(parsedOrder, { message: content })) {
        return null;
      }
      return parsedOrder;
    }

    /**
     * Format 9: pipe + BUY/SELL SIGNAL + Entry line (limit). Optional emoji on first line.
     * Entry: 4705-4700 → limit at second bound (same as Format 3 dash convention: price after last `-`).
     */
    const format9Header = firstLine.match(
      /(gold|XAU|XAUT|XAUUSD)\s*\|\s*(buy|sell)\s+signal\b/i,
    );
    if (format9Header) {
      const entryMatch = normalizedContent.match(/\bEntry\s*:\s*([\d.]+)(?:\s*-\s*([\d.]+))?/i);
      if (!entryMatch) return null;
      const entryRaw = entryMatch[2] ?? entryMatch[1];
      const entryPrice = parseFloat(entryRaw);
      if (isNaN(entryPrice) || entryPrice <= 0) return null;

      const slClauseMatch = normalizedContent.match(/\bSL[\s:][^\n]*/i);
      const slClause = slClauseMatch?.[0] ?? '';
      const stopLoss = slClause ? parseStopLossFromSlClause(slClause) : undefined;
      if (stopLoss === undefined || isNaN(stopLoss) || stopLoss <= 0) return null;

      const tpTokens = parseTpTokens(normalizedContent);
      const numericTps = tpTokens
        .filter((t): t is { kind: 'number'; value: number } => t.kind === 'number')
        .map((t) => t.value);
      if (numericTps.length === 0) {
        logger.warn('ctrader_dgf: Format 9 — no numeric take profits; skipping message', {
          preview: normalizedContent.slice(0, 200),
        });
        return null;
      }

      const signalType = format9Header[2].toLowerCase() === 'buy' ? 'long' : 'short';
      const tradingPair = normalizeAssetAliasToCTraderPair(format9Header[1]);
      let takeProfits: number[];
      if (numericTps.length === 1) {
        takeProfits = [numericTps[0]];
      } else {
        const hasOpen = tpTokens.some((t) => t.kind === 'open');
        if (hasOpen) {
          const avgStep = meanNumericGap(numericTps);
          takeProfits = resolveTpTokensWithOpen(tpTokens, avgStep);
        } else {
          takeProfits = [...numericTps];
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

      const parsedOrder: ParsedOrder = {
        tradingPair,
        entryPrice,
        marketExecution: false,
        stopLoss,
        takeProfits: deduplicatedTPs,
        leverage: 20,
        signalType,
      };
      if (!validateParsedOrder(parsedOrder, { message: content })) {
        return null;
      }
      return parsedOrder;
    }

    const hashNowPair = firstLine.match(
      /^\s*(buy|sell)\s+now\s+#?([A-Za-z0-9]+)\s+@\s*([\d.]+)/i,
    );

    const sideFirst = firstLine.match(
      /^\s*(buy|sell)\s+(gold|XAU|XAUT|XAUUSD)\s+([\d.]+)/i,
    );

    /** XAUUSD SELL 4782, XAUUSD | BUY 4713-4718, etc. — symbol before buy/sell (optional |; leading emoji ok). */
    const symbolSideEntry = firstLine.match(
      /(gold|XAU|XAUT|XAUUSD)(?:\s+\|\s+|\s+)(buy|sell)\s+([\d.]+)(?:\/([\d.]+)|-([\d.]+))?/i,
    );

    let tradingPair: string;
    let signalType: 'long' | 'short';

    const validatePositivePrice = (raw: string): boolean => {
      const n = parseFloat(raw);
      return !isNaN(n) && n > 0;
    };

    if (hashNowPair) {
      signalType = hashNowPair[1].toLowerCase() === 'buy' ? 'long' : 'short';
      tradingPair = normalizeAssetAliasToCTraderPair(hashNowPair[2]);
      if (!validatePositivePrice(hashNowPair[3])) return null;
    } else if (sideFirst) {
      signalType = sideFirst[1].toLowerCase() === 'buy' ? 'long' : 'short';
      tradingPair = normalizeAssetAliasToCTraderPair(sideFirst[2]);
      if (!validatePositivePrice(sideFirst[3])) return null;
    } else if (symbolSideEntry) {
      signalType = symbolSideEntry[2].toLowerCase() === 'buy' ? 'long' : 'short';
      tradingPair = normalizeAssetAliasToCTraderPair(symbolSideEntry[1]);
      if (!validatePositivePrice(symbolSideEntry[3])) return null;
      const secondEntry = symbolSideEntry[4] ?? symbolSideEntry[5];
      if (secondEntry !== undefined && !validatePositivePrice(secondEntry)) return null;
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
        if (!validatePositivePrice(entryAtFirst[1])) return null;
      } else {
        const dashEntry = firstLine.match(/-\s*([\d.]+)/);
        if (dashEntry) {
          if (!validatePositivePrice(dashEntry[1])) return null;
        } else {
          const plusRange = firstLine.match(/([\d.]+)\s*\+\s*([\d.]+)/);
          if (plusRange) {
            if (!validatePositivePrice(plusRange[2])) return null;
          } else {
            const nowSingle = firstLine.match(/\bnow\s+([\d.]+)/i);
            if (nowSingle && !validatePositivePrice(nowSingle[1])) return null;
          }
        }
      }
    }

    const slClauseMatch = normalizedContent.match(/\bSL[\s:][^\n]*/i);
    const slClause = slClauseMatch?.[0] ?? '';
    const stopLoss = slClause ? parseStopLossFromSlClause(slClause) : undefined;
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
      entryPrice: undefined,
      marketExecution: true,
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
