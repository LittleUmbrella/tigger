import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { logger } from '../utils/logger.js';
import { meanNumericGap, parseTpTokens, resolveTpTokensWithOpen } from './tpOpenResolve.js';

type DgfVipLimitEntry = {
  entryPrice: number;
  entryTargets?: [number, number];
};

const parsePositivePrice = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = parseFloat(raw);
  return !isNaN(n) && n > 0 ? n : undefined;
};

const limitEntryFromRange = (
  a: number,
  b: number,
  signalType: 'long' | 'short',
  options?: ParserOptions,
): DgfVipLimitEntry => {
  const strategy = options?.entryPriceStrategy || 'worst';
  return {
    entryPrice: calculateEntryPrice(a, b, signalType, strategy),
    entryTargets: [Math.min(a, b), Math.max(a, b)],
  };
};

/** Explicit entry price or range on the signal header → limit order (not market / MARKET_RANGE). */
const resolveDgfVipLimitEntryFromLine = (
  line: string,
  signalType: 'long' | 'short',
  options?: ParserOptions,
): DgfVipLimitEntry | undefined => {
  const slash = line.match(/([\d.]+)\s*\/\s*([\d.]+)/);
  if (slash) {
    const a = parsePositivePrice(slash[1]);
    const b = parsePositivePrice(slash[2]);
    if (a != null && b != null) return limitEntryFromRange(a, b, signalType, options);
  }

  const plus = line.match(/([\d.]+)\s*\+\s*([\d.]+)/);
  if (plus) {
    const a = parsePositivePrice(plus[1]);
    const b = parsePositivePrice(plus[2]);
    if (a != null && b != null) return limitEntryFromRange(a, b, signalType, options);
  }

  const tilde = line.match(/([\d.]+)\s*~\s*([\d.]+)/);
  if (tilde) {
    const a = parsePositivePrice(tilde[1]);
    const b = parsePositivePrice(tilde[2]);
    if (a != null && b != null) return limitEntryFromRange(a, b, signalType, options);
  }

  const dashRange = line.match(/([\d.]+)\s*-\s*([\d.]+)/);
  if (dashRange) {
    const a = parsePositivePrice(dashRange[1]);
    const b = parsePositivePrice(dashRange[2]);
    if (a != null && b != null) return limitEntryFromRange(a, b, signalType, options);
  }

  const atEntry = line.match(/@\s*([\d.]+)/);
  const atPrice = parsePositivePrice(atEntry?.[1]);
  if (atPrice != null) return { entryPrice: atPrice };

  const nowSingle = line.match(/\bnow\s+([\d.]+)/i);
  const nowPrice = parsePositivePrice(nowSingle?.[1]);
  if (nowPrice != null) return { entryPrice: nowPrice };

  return undefined;
};

/** Parse SL from text starting at SL label through end of line (avoids conflating entry `@` with SL `@`). */
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
  const slPlain = slClause.match(/(?:SL|Stop\s*Loss)\s*[=:]?\s*([\d.]+)/i);
  if (slPlain) {
    const v = parseFloat(slPlain[1]);
    if (!isNaN(v) && v > 0) return v;
  }
  return undefined;
};

/** Prefer first SL label clause on a line; if parsing fails, scan full message (single-line layouts). */
const resolveStopLossFromDgfContent = (normalizedContent: string): number | undefined => {
  const slClauseMatch = normalizedContent.match(/\b(?:SL|Stop\s*Loss)\b\s*[=:]?\s*[^\n]*/i);
  const slClause = slClauseMatch?.[0] ?? '';
  let stopLoss = slClause ? parseStopLossFromSlClause(slClause) : undefined;
  if (stopLoss === undefined || isNaN(stopLoss) || stopLoss <= 0) {
    stopLoss = parseStopLossFromSlClause(normalizedContent);
  }
  if (stopLoss === undefined || isNaN(stopLoss) || stopLoss <= 0) return undefined;
  return stopLoss;
};

/** Gold aliases and generic cTrader symbols (e.g. BTCUSD, EURNZD) — same permissiveness as Format 5 hashNowPair. */
const DGF_GOLD_TOKEN = 'gold|XAU|XAUT|XAUUSD';
const DGF_PAIR_TOKEN = `${DGF_GOLD_TOKEN}|[A-Z][A-Z0-9]{2,11}`;

/** En-dash / em-dash entry ranges (e.g. 4572– 4577) → ASCII hyphen for range regexes. */
const normalizeUnicodeEntryRangeDashes = (content: string): string =>
  content.replace(/([\d.]+)\s*[\u2013\u2014\u2012\u2212]\s*([\d.]+)/g, '$1-$2');

/** Skip leading emoji / junk so symbol-first lines match (e.g. 🛡XAUUSD …, 🛡 BTCUSD BUY …). */
const stripToFirstDgfSymbol = (s: string): string => {
  const goldM = new RegExp(`\\b(${DGF_GOLD_TOKEN})\\b`, 'i').exec(s);
  if (goldM?.index !== undefined) return s.slice(goldM.index);
  const pairM = new RegExp(
    `\\b([A-Z][A-Z0-9]{2,11})\\b(?=\\s*[|:]?\\s*(?:buy|sell)\\b)`,
    'i',
  ).exec(s);
  if (pairM?.index !== undefined) return s.slice(pairM.index);
  return s;
};

/**
 * Parser for DGF-style cTrader signals (channel dgfvip): same formats as ctrader_dgf — gold/XAU and
 * forex pairs written as Buy/Sell NOW [#]SYMBOL @ entry (# optional). "gold" / XAU family maps to XAUUSD;
 * other symbols (e.g. EURNZD) are left unchanged. Explicit entry prices or ranges → limit at zone
 * (calculateEntryPrice worst by default); messages with no entry price remain market.
 *
 * Format 6 (symbol before side; optional emoji prefix; slash entry range): see ctraderDgfParser.
 */
export const ctraderDgfVipParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = normalizeUnicodeEntryRangeDashes(content.trim());
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

    /** SYMBOL SELL 4782, BTCUSD BUY 76300- 76000, XAUUSD | BUY … — symbol before buy/sell (optional | or : ; optional NOW; leading emoji ok). */
    const symbolSideEntry = firstLineForDgf.match(
      new RegExp(
        `(${DGF_PAIR_TOKEN})(?:\\s+\\|\\s+|\\s*:?\\s*)(buy|sell)\\s+(?:now\\s+)?([\\d.]+)(?:\\/([\\d.]+)|-\\s*([\\d.]+))?`,
        'i',
      ),
    );

    let tradingPair: string;
    let signalType: 'long' | 'short';
    let entryLimit: DgfVipLimitEntry | undefined;

    const validatePositivePrice = (raw: string): boolean => {
      const n = parseFloat(raw);
      return !isNaN(n) && n > 0;
    };

    if (hashNowPair) {
      signalType = hashNowPair[1].toLowerCase() === 'buy' ? 'long' : 'short';
      tradingPair = normalizeAssetAliasToCTraderPair(hashNowPair[2]);
      if (!validatePositivePrice(hashNowPair[3])) return null;
      const entryPrice = parsePositivePrice(hashNowPair[3]);
      if (entryPrice != null) entryLimit = { entryPrice };
    } else if (sideFirst) {
      signalType = sideFirst[1].toLowerCase() === 'buy' ? 'long' : 'short';
      tradingPair = normalizeAssetAliasToCTraderPair(sideFirst[2]);
      if (!validatePositivePrice(sideFirst[3])) return null;
      const entryPrice = parsePositivePrice(sideFirst[3]);
      if (entryPrice != null) entryLimit = { entryPrice };
    } else if (symbolSideEntry) {
      signalType = symbolSideEntry[2].toLowerCase() === 'buy' ? 'long' : 'short';
      tradingPair = normalizeAssetAliasToCTraderPair(symbolSideEntry[1]);
      if (!validatePositivePrice(symbolSideEntry[3])) return null;
      const firstEntry = parsePositivePrice(symbolSideEntry[3]);
      const secondEntry = parsePositivePrice(symbolSideEntry[4] ?? symbolSideEntry[5]);
      if (secondEntry != null && firstEntry != null) {
        entryLimit = limitEntryFromRange(firstEntry, secondEntry, signalType, options);
      }
    } else {
      const tradingPairMatch = contentFromAsset.match(
        new RegExp(`^(${DGF_PAIR_TOKEN})\\s+`, 'i'),
      );
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

      entryLimit = resolveDgfVipLimitEntryFromLine(firstLineForDgf, signalType, options);
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
      entryPrice: entryLimit?.entryPrice,
      entryTargets: entryLimit?.entryTargets,
      marketExecution: entryLimit == null,
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
