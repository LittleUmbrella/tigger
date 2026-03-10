import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parser for FXCM-style trading chart setups (e.g. Gold Spot / U.S. Dollar).
 *
 * Accepts text extracted from chart images or structured descriptions:
 * - "XAUUSD Long Entry: 5216.72 SL: 5203.40 TP: 5245.38"
 * - "Gold Spot Long 5216.72 SL 5203.40 TP 5245.38"
 * - JSON: {"asset":"XAUUSD","direction":"long","entry":5216.72,"sl":5203.40,"tp":[5245.38]}
 * - Vision model output describing chart with entry, stop loss, take profit zones
 *
 * Supported assets: XAUUSD, Gold Spot, Gold
 * Supports Long and Short positions.
 */
export const fxcmChartParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalized = content.trim();
    if (!normalized) return null;

    // Try JSON format first (e.g. from vision model structured output)
    const jsonMatch = normalized.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = parseJsonFormat(jsonMatch[0]);
      if (parsed) return parsed;
    }

    // Try structured text formats
    const textParsed = parseStructuredText(normalized);
    if (textParsed) return textParsed;

    return null;
  } catch {
    return null;
  }
};

function parseJsonFormat(jsonStr: string): ParsedOrder | null {
  try {
    const obj = JSON.parse(jsonStr) as Record<string, unknown>;
    const asset = String(obj.asset || obj.symbol || obj.tradingPair || '').toUpperCase().replace(/\/.*$/, '');
    if (!asset || !/^XAU(USD)?$/i.test(asset) && !/^GOLD/i.test(asset)) return null;

    const tradingPair = normalizeAssetToXAUUSD(asset);
    const direction = String(obj.direction || obj.side || obj.signalType || obj.type || 'long').toLowerCase();
    const signalType: 'long' | 'short' = /short|sell/i.test(direction) ? 'short' : 'long';

    const entry = parseNum(obj.entry || obj.entryPrice || obj.price);
    const sl = parseNum(obj.sl || obj.stopLoss || obj.stop_loss);
    const tpRaw = obj.tp || obj.takeProfit || obj.take_profit || obj.tps || obj.targets;
    const takeProfits = Array.isArray(tpRaw)
      ? tpRaw.map(parseNum).filter((n): n is number => typeof n === 'number' && n > 0)
      : typeof tpRaw === 'number' && tpRaw > 0
        ? [tpRaw]
        : [];

    if (!sl || sl <= 0 || takeProfits.length === 0) return null;

    const deduplicatedTPs = deduplicateTakeProfits(takeProfits, signalType);
    if (deduplicatedTPs.length === 0) return null;

    const order: ParsedOrder = {
      tradingPair,
      entryPrice: entry && entry > 0 ? entry : undefined,
      stopLoss: sl,
      takeProfits: deduplicatedTPs,
      leverage: 20,
      signalType,
    };

    return validateParsedOrder(order, { message: jsonStr }) ? order : null;
  } catch {
    return null;
  }
}

function parseStructuredText(text: string): ParsedOrder | null {
  // Must mention XAUUSD, Gold, or Gold Spot
  const assetMatch = text.match(/\b(XAUUSD|XAU\s*\/?\s*USD|Gold\s*Spot|Gold)\b/i);
  if (!assetMatch) return null;

  const tradingPair = normalizeAssetToXAUUSD(assetMatch[1]);

  const signalType: 'long' | 'short' =
    /\b(short|sell)\b/i.test(text) ? 'short' : (/\b(long|buy)\b/i.test(text) ? 'long' : 'long');

  // Entry: various formats
  const entryMatch =
    text.match(/(?:Entry|entry)[:\s]*([\d,]+\.?\d*)/i) ||
    text.match(/(?:@|at)\s*([\d,]+\.?\d*)/i) ||
    text.match(/\b([\d,]+\.?\d+)\s*(?:SL|stop|entry)/i);
  const entryPrice = entryMatch ? parseNum(entryMatch[1]) : undefined;

  // Stop Loss
  const slMatch =
    text.match(/\b(?:SL|Stop\s*Loss|stop_loss)[:\s]*([\d,]+\.?\d*)/i) ||
    text.match(/(?:stop\s*loss|sl)\s*[:\s=]\s*([\d,]+\.?\d*)/i);
  const stopLoss = slMatch ? parseNum(slMatch[1]) : undefined;
  if (!stopLoss || stopLoss <= 0) return null;

  // Take Profits - collect all numbers that look like TP levels
  const tpMatches = text.matchAll(/(?:TP|Take\s*Profit|take_profit|target)[:\s]*([\d,]+\.?\d*)/gi);
  const takeProfits: number[] = [];
  for (const m of tpMatches) {
    const v = parseNum(m[1]);
    if (v && v > 0) takeProfits.push(v);
  }

  // Fallback: look for prominent price numbers near "5245" style (4-5 digit gold prices)
  if (takeProfits.length === 0) {
    const goldPriceMatches = text.match(/\b([4-5]\d{3}\.\d{2})\b/g);
    if (goldPriceMatches) {
      const nums = goldPriceMatches.map(parseNum).filter((n): n is number => typeof n === 'number' && n > 0);
      for (const n of nums) {
        if (signalType === 'long' && n > (entryPrice ?? 0) && n > stopLoss) takeProfits.push(n);
        if (signalType === 'short' && n < (entryPrice ?? Infinity) && n < stopLoss) takeProfits.push(n);
      }
    }
  }

  if (takeProfits.length === 0) return null;

  const deduplicatedTPs = deduplicateTakeProfits(takeProfits, signalType);
  if (deduplicatedTPs.length === 0) return null;

  const order: ParsedOrder = {
    tradingPair,
    entryPrice: entryPrice && entryPrice > 0 ? entryPrice : undefined,
    stopLoss,
    takeProfits: deduplicatedTPs,
    leverage: 20,
    signalType,
  };

  return validateParsedOrder(order, { message: text }) ? order : null;
}

function normalizeAssetToXAUUSD(asset: string): string {
  const a = asset.toUpperCase().replace(/\s+/g, '');
  if (/^XAU(USD)?$/.test(a) || /^GOLD/.test(a)) return 'XAUUSD';
  return a.endsWith('USD') ? a : `${a}USD`;
}

function parseNum(value: unknown): number | undefined {
  if (typeof value === 'number' && !isNaN(value)) return value;
  if (typeof value === 'string') {
    const n = parseFloat(value.replace(/,/g, ''));
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}
