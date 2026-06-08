import { ParsedOrder } from '../types/order.js';
import { validateCmpSignalPrices, validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parses CMP-style crypto signals (Discord). Two entry modes:
 *
 * **CMP** — omit `entryPrice`; initiator places limit at ticker last price (pseudo-market).
 * **Limit** — `Limit Entry: low - high` sets `entryPrice` + `entryTargets` for a real limit at the zone.
 *
 * DCA lines in messages are ignored. CMP formats:
 *
 * Long: ID/USDT
 * Entry at CMP: 0.03155
 * Entry: 0.02 - 0.03 (CMP)
 * Entry: 0.03670 (CMP)
 * Entry: 0.09810 cmp
 * Entry: 0.02 - 0.03 CMP DCA: …
 *
 * Limit format:
 * Short: EPIC/USDT — 20x/50x Lev Limit Entry: 0.3144 - 0.3272
 */

const parseLeverage = (content: string): number => {
  let leverage = 20;
  const levRange = content.match(
    /\(\s*(\d+)\s*[x×]\s*-\s*(\d+)\s*[x×]\s*(?:[Ll]everage|[Ll]ev)\s*\)/i
  );
  const levSlash = content.match(
    /\b(\d+)\s*[x×]\s*\/\s*(\d+)\s*[x×]\s*(?:[Ll]everage|[Ll]ev)\b/i
  );
  const levSingle = content.match(/\b(\d+)\s*[x×]\s*(?:[Ll]everage|[Ll]ev)\b/i);

  if (levRange) {
    const lo = parseInt(levRange[1], 10);
    const hi = parseInt(levRange[2], 10);
    leverage = Number.isFinite(lo) && Number.isFinite(hi) ? Math.min(lo, hi) : leverage;
    if (!Number.isFinite(lo) || lo < 1) leverage = 20;
  } else if (levSlash) {
    const lo = parseInt(levSlash[1], 10);
    const hi = parseInt(levSlash[2], 10);
    leverage = Number.isFinite(lo) && Number.isFinite(hi) ? Math.min(lo, hi) : leverage;
    if (!Number.isFinite(lo) || lo < 1) leverage = 20;
  } else if (levSingle) {
    const lx = parseInt(levSingle[1], 10);
    if (Number.isFinite(lx) && lx >= 1) leverage = lx;
  }
  return leverage;
};

type EntryParseResult =
  | { mode: 'cmp'; cmpRef: number }
  | { mode: 'limit'; entryPrice: number; entryTargets: number[]; validationRef: number };

const parseEntry = (
  content: string,
  signalType: 'long' | 'short',
  entryPriceStrategy: 'worst' | 'average'
): EntryParseResult | null => {
  const limitRange = content.match(/Limit\s+Entry\s*:\s*([\d.]+)\s*-\s*([\d.]+)/i);
  const limitSingle = content.match(/Limit\s+Entry\s*:\s*([\d.]+)(?!\s*-\s*[\d.])/i);

  if (limitRange) {
    const price1 = parseFloat(limitRange[1]);
    const price2 = parseFloat(limitRange[2]);
    if (!Number.isFinite(price1) || !Number.isFinite(price2) || price1 <= 0 || price2 <= 0) {
      return null;
    }
    const lo = Math.min(price1, price2);
    const hi = Math.max(price1, price2);
    const entryPrice = calculateEntryPrice(price1, price2, signalType, entryPriceStrategy);
    return {
      mode: 'limit',
      entryPrice,
      entryTargets: [lo, hi],
      validationRef: entryPrice
    };
  }

  if (limitSingle) {
    const entryPrice = parseFloat(limitSingle[1]);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
    return {
      mode: 'limit',
      entryPrice,
      entryTargets: [entryPrice],
      validationRef: entryPrice
    };
  }

  const entryAtCmp = content.match(/Entry\s+at\s+CMP\s*:\s*([\d.]+)/i);
  const cmpColon = content.match(/\bCMP\s*:\s*([\d.]+)/i);
  const entryRangeCmp = content.match(/Entry\s*:\s*([\d.]+)\s*-\s*([\d.]+)\s*\(\s*CMP\s*\)/i);
  const entryRangeBareCmp = content.match(/Entry\s*:\s*([\d.]+)\s*-\s*([\d.]+)\s+CMP\b/i);
  const entrySingleCmp = content.match(/Entry\s*:\s*([\d.]+)\s*\(\s*CMP\s*\)/i);
  const entrySingleBareCmp = content.match(/Entry\s*:\s*([\d.]+)\s+CMP\b/i);

  let cmpRef: number;
  if (entryAtCmp) {
    cmpRef = parseFloat(entryAtCmp[1]);
  } else if (cmpColon) {
    cmpRef = parseFloat(cmpColon[1]);
  } else if (entryRangeCmp) {
    const lo = parseFloat(entryRangeCmp[1]);
    const hi = parseFloat(entryRangeCmp[2]);
    cmpRef = (lo + hi) / 2;
  } else if (entryRangeBareCmp) {
    const lo = parseFloat(entryRangeBareCmp[1]);
    const hi = parseFloat(entryRangeBareCmp[2]);
    cmpRef = (lo + hi) / 2;
  } else if (entrySingleCmp) {
    cmpRef = parseFloat(entrySingleCmp[1]);
  } else if (entrySingleBareCmp) {
    cmpRef = parseFloat(entrySingleBareCmp[1]);
  } else {
    return null;
  }

  if (!Number.isFinite(cmpRef) || cmpRef <= 0) return null;
  return { mode: 'cmp', cmpRef };
};

export const cmpDcaSignalParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  const sideMatch = content.match(/^\s*(Long|Short)\s*:\s*([\w.-]+)\s*\/\s*(USDT|USDC|USD)\b/im);
  if (!sideMatch) return null;

  const signalType = sideMatch[1].toLowerCase() === 'long' ? 'long' : 'short';
  let base = sideMatch[2].toUpperCase();
  let quote = sideMatch[3].toUpperCase();
  if (quote === 'USD') quote = 'USDT';
  const tradingPair = `${base}${quote}`;

  const entryPriceStrategy = options?.entryPriceStrategy || 'worst';
  const entry = parseEntry(content, signalType, entryPriceStrategy);
  if (!entry) return null;

  const takeProfits: number[] = [];
  /** Word-boundary TP (not line-start): Discord/harvest often collapses to a single line. */
  const tpLine = /\bTP\s*[^:]+:\s*([\d.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = tpLine.exec(content)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v > 0) takeProfits.push(v);
  }
  if (takeProfits.length === 0) return null;

  if (signalType === 'long') {
    takeProfits.sort((a, b) => a - b);
  } else {
    takeProfits.sort((a, b) => b - a);
  }
  const dedup = deduplicateTakeProfits(takeProfits, signalType);
  takeProfits.length = 0;
  takeProfits.push(...dedup);
  if (takeProfits.length === 0) return null;

  const leverage = parseLeverage(content);

  let stopLoss = NaN;
  const belowSl = content.match(/\bSL\s*:\s*[^\n\r]*below\s+([\d.]+)/i);
  const aboveSl = content.match(/\bSL\s*:\s*[^\n\r]*above\s+([\d.]+)/i);
  const numericSl = content.match(/\bSL\s*:\s*([\d.]+)/i);

  if (signalType === 'long' && belowSl) stopLoss = parseFloat(belowSl[1]);
  else if (signalType === 'short' && aboveSl) stopLoss = parseFloat(aboveSl[1]);
  else if (numericSl) stopLoss = parseFloat(numericSl[1]);

  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    if (numericSl) stopLoss = parseFloat(numericSl[1]);
  }

  if (!Number.isFinite(stopLoss) || stopLoss <= 0) return null;

  const parsed: ParsedOrder = {
    tradingPair,
    leverage,
    stopLoss,
    takeProfits,
    signalType
  };

  if (entry.mode === 'limit') {
    parsed.entryPrice = entry.entryPrice;
    parsed.entryTargets = entry.entryTargets.length > 1 ? entry.entryTargets : undefined;
    if (!validateParsedOrder(parsed, { message: content })) {
      return null;
    }
  } else {
    if (!validateCmpSignalPrices(signalType, entry.cmpRef, stopLoss, takeProfits, { message: content })) {
      return null;
    }
  }

  return parsed;
};
