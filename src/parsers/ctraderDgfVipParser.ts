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

/** Prefer first `SL …` clause on a line; if parsing fails, scan full message (single-line layouts). */
const resolveStopLossFromDgfContent = (normalizedContent: string): number | undefined => {
  const slClauseMatch = normalizedContent.match(/\bSL[\s:][^\n]*/i);
  const slClause = slClauseMatch?.[0] ?? '';
  let stopLoss = slClause ? parseStopLossFromSlClause(slClause) : undefined;
  if (stopLoss === undefined || isNaN(stopLoss) || stopLoss <= 0) {
    stopLoss = parseStopLossFromSlClause(normalizedContent);
  }
  if (stopLoss === undefined || isNaN(stopLoss) || stopLoss <= 0) return undefined;
  return stopLoss;
};

/** Skip leading emoji / junk so `^`-anchored patterns and symbol-first lines match (e.g. 🛡XAUUSD …). */
const stripToFirstDgfSymbol = (s: string): string => {
  const m = /\b(gold|XAU|XAUT|XAUUSD)\b/i.exec(s);
  return m?.index !== undefined ? s.slice(m.index) : s;
};

/**
 * Parser for DGF-style cTrader signals (channel dgfvip): same formats as ctrader_dgf — gold/XAU and
 * forex pairs written as Buy/Sell NOW [#]SYMBOL @ entry (# optional). "gold" / XAU family maps to XAUUSD;
 * other symbols (e.g. EURNZD) are left unchanged. Most formats omit entryPrice (market); Formats 8–9 set entryPrice (limit).
 *
 * Format 6 (symbol before side; optional emoji prefix; slash entry range): see ctraderDgfParser.
 */
export const ctraderDgfVipParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = content.trim();
    const lines = normalizedContent.split(/\r?\n/);
    const rawFirstLine = lines[0] ?? '';
    const firstLineForDgf = stripToFirstDgfSymbol(rawFirstLine);
    const contentFromAsset = stripToFirstDgfSymbol(normalizedContent);

    /** Format 8: limit order from explicit Entry line; header uses long|short and optional leading $. */
    const format8Header = firstLineForDgf.match(
      /^\s*\$?\s*(gold|XAU|XAUT|XAUUSD)\s+(long|short)\s*\|/i,
    );
    if (format8Header) {
      const entryMatch = normalizedContent.match(/\bEntry\s*:\s*([\d.]+)/i);
      if (!entryMatch) return null;
      const entryPrice = parseFloat(entryMatch[1]);
      if (isNaN(entryPrice) || entryPrice <= 0) return null;

      const stopLoss = resolveStopLossFromDgfContent(normalizedContent);
      if (stopLoss === undefined) return null;

      const tpTokens = parseTpTokens(normalizedContent);
      const numericTps = tpTokens
        .filter((t): t is { kind: 'number'; value: number } => t.kind === 'number')
        .map((t) => t.value);
      if (numericTps.length === 0) {
        logger.warn('dgfvip: Format 8 — no numeric take profits; skipping message', {
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
    const format9Header = firstLineForDgf.match(
      /(gold|XAU|XAUT|XAUUSD)\s*\|\s*(buy|sell)\s+signal\b/i,
    );
    if (format9Header) {
      const entryMatch = normalizedContent.match(/\bEntry\s*:\s*([\d.]+)(?:\s*-\s*([\d.]+))?/i);
      if (!entryMatch) return null;
      const entryRaw = entryMatch[2] ?? entryMatch[1];
      const entryPrice = parseFloat(entryRaw);
      if (isNaN(entryPrice) || entryPrice <= 0) return null;

      const stopLoss = resolveStopLossFromDgfContent(normalizedContent);
      if (stopLoss === undefined) return null;

      const tpTokens = parseTpTokens(normalizedContent);
      const numericTps = tpTokens
        .filter((t): t is { kind: 'number'; value: number } => t.kind === 'number')
        .map((t) => t.value);
      if (numericTps.length === 0) {
        logger.warn('dgfvip: Format 9 — no numeric take profits; skipping message', {
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

    const hashNowPair = rawFirstLine.match(
      /^\s*(buy|sell)\s+now\s+#?([A-Za-z0-9]+)\s+@\s*([\d.]+)/i,
    );

    const sideFirst = rawFirstLine.match(
      /^\s*(buy|sell)\s+(gold|XAU|XAUT|XAUUSD)\s+([\d.]+)/i,
    );

    /** XAUUSD SELL 4782, XAUUSD : BUY …, XAUUSD | BUY 4713-4718, XAUUSD BUY NOW 4650-4646, etc. — symbol before buy/sell (optional | or : ; optional NOW; leading emoji ok). */
    const symbolSideEntry = firstLineForDgf.match(
      /(gold|XAU|XAUT|XAUUSD)(?:\s+\|\s+|\s*:?\s*)(buy|sell)\s+(?:now\s+)?([\d.]+)(?:\/([\d.]+)|-([\d.]+))?/i,
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
      const tradingPairMatch = contentFromAsset.match(/^(gold|XAU|XAUT|XAUUSD)\s+/i);
      if (!tradingPairMatch) return null;

      tradingPair = normalizeAssetAliasToCTraderPair(tradingPairMatch[1]);

      const buyMatch = normalizedContent.match(/buy/i);
      const sellMatch = normalizedContent.match(/sell/i);
      if (!buyMatch && !sellMatch) return null;
      signalType = buyMatch ? 'long' : 'short';

      const entryAtFirst = firstLineForDgf.match(/@\s*([\d.]+)/i);
      if (entryAtFirst) {
        if (!validatePositivePrice(entryAtFirst[1])) return null;
      } else {
        const dashEntry = firstLineForDgf.match(/-\s*([\d.]+)/);
        if (dashEntry) {
          if (!validatePositivePrice(dashEntry[1])) return null;
        } else {
          const plusRange = firstLineForDgf.match(/([\d.]+)\s*\+\s*([\d.]+)/);
          if (plusRange) {
            if (!validatePositivePrice(plusRange[2])) return null;
          } else {
            const nowSingle = firstLineForDgf.match(/\bnow\s+([\d.]+)/i);
            if (nowSingle && !validatePositivePrice(nowSingle[1])) return null;
          }
        }
      }
    }

    const stopLoss = resolveStopLossFromDgfContent(normalizedContent);
    if (stopLoss === undefined) return null;

    const tpTokens = parseTpTokens(normalizedContent);
    const numericTps = tpTokens
      .filter((t): t is { kind: 'number'; value: number } => t.kind === 'number')
      .map((t) => t.value);

    if (numericTps.length === 0) {
      logger.warn('dgfvip: no numeric take profits; skipping message', {
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
