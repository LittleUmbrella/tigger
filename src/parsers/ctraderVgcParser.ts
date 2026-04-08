import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { ctraderFtgParser } from './ctraderFtgParser.js';
import { meanNumericGap, resolveTpTokensWithOpen, TpToken } from './tpOpenResolve.js';

/**
 * VGC (Telegram channel 3750519389) — "Trading Strategy" layout:
 *   … 🔷 BUY ZONE XAUUSD: 4736 – 4738 🔺 SL: 4727 🔸 TP: 4743 – 4750 – 4760 – OPEN …
 * - Entry: limit from zone [low, high] via calculateEntryPrice (worst/average); not market / not market-range.
 * - TPs: dash-separated tokens after TP:; "open" is resolved like ctraderDgfVipParser (interpolate between numerics, extrapolate trailing using mean gap).
 */

const extractVgcZoneAndSide = (
  content: string,
): { signalType: 'long' | 'short'; lo: number; hi: number } | null => {
  const m = content.match(/(BUY|SELL)\s+ZONE\s+XAUUSD:\s*([\d.]+)\s*[–—−-]\s*([\d.]+)/i);
  if (!m) return null;
  const a = parseFloat(m[2]);
  const b = parseFloat(m[3]);
  if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;
  const signalType = m[1].toUpperCase() === 'BUY' ? 'long' : 'short';
  return { signalType, lo: Math.min(a, b), hi: Math.max(a, b) };
};

const extractSlAfterZone = (content: string): number | undefined => {
  const m = content.match(/\bSL:\s*([\d.]+)/i);
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  if (isNaN(v) || v <= 0) return undefined;
  return v;
};

/** TP: then dash-separated numeric or "open" tokens (same semantics as DGF VIP TP lines). */
const extractVgcTpTokens = (content: string): TpToken[] => {
  const tpLabel = /\bTP:\s*/i.exec(content);
  if (!tpLabel || tpLabel.index === undefined) return [];

  let rest = content.slice(tpLabel.index + tpLabel[0].length);
  const cut = rest.search(/\bBe careful\b/i);
  if (cut >= 0) rest = rest.slice(0, cut);
  rest = rest.trim();

  const parts = rest.split(/\s*[–—−-]\s*/);
  const out: TpToken[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (/^OPEN\b/i.test(p)) {
      out.push({ kind: 'open' });
      continue;
    }
    const v = parseFloat(p.replace(/^[^\d.]*/, ''));
    if (!isNaN(v) && v > 0) out.push({ kind: 'number', value: v });
  }
  return out;
};

const parseVgcTradingStrategyZone = (content: string, options?: ParserOptions): ParsedOrder | null => {
  const zone = extractVgcZoneAndSide(content);
  if (!zone) return null;

  const stopLoss = extractSlAfterZone(content);
  if (stopLoss === undefined) return null;

  const tpTokens = extractVgcTpTokens(content);
  const numericTps = tpTokens
    .filter((t): t is { kind: 'number'; value: number } => t.kind === 'number')
    .map((t) => t.value);
  if (numericTps.length === 0) return null;

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

  const strategy = options?.entryPriceStrategy || 'worst';
  const a = zone.lo;
  const b = zone.hi;
  const entryPrice = calculateEntryPrice(a, b, zone.signalType, strategy);

  if (zone.signalType === 'long') takeProfits.sort((x, y) => x - y);
  else takeProfits.sort((x, y) => y - x);

  const takeProfitsDeduped = deduplicateTakeProfits(takeProfits, zone.signalType);
  if (takeProfitsDeduped.length === 0) return null;

  const tradingPair = normalizeAssetAliasToCTraderPair('XAUUSD');

  const parsedOrder: ParsedOrder = {
    tradingPair,
    entryPrice,
    entryTargets: [zone.lo, zone.hi],
    stopLoss,
    takeProfits: takeProfitsDeduped,
    leverage: 20,
    signalType: zone.signalType,
  };

  if (!validateParsedOrder(parsedOrder, { message: content })) return null;
  return parsedOrder;
};

export const ctraderVgcParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  const vgc = parseVgcTradingStrategyZone(content, options);
  if (vgc) return vgc;
  return ctraderFtgParser(content, options);
};
