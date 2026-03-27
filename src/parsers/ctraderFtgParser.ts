import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';
import { ctraderGoldParser } from './ctraderGoldParser.js';

/**
 * Fusion Trade – Gold (FTG), Telegram channel 2986529706 (FusionMarketsInsights).
 *
 * Format 1:
 * #GOLD/XAUUSD SELL NOW 4549
 * TP 4544 …
 * SL 4561
 *
 * Format 2:
 * $XAUUSD BUY 4555 / 4553
 * SL: 4545
 * TP 1:4560 …
 *
 * Format 3:
 * $GOLD SELL NOW
 * 📉4597/4600📉
 * TP¹✔️4594 …
 * ♨️ SL 4605
 *
 * Format 4:
 * XAUUSD sell 4413//4416
 * TP …
 * SL*4423
 *
 * Format 5:
 * XAUUSD sell now 4375//4377
 * TP …
 * SL*4384 👍
 *
 * Format 6 (single-line, space-separated entry zone):
 * #XAUUSD BUY 4450 4445 SL 4440 TP 4455 …
 *
 * Format 7 (single-line):
 * $GOLD BUYING NOW ENTRIES:4416__4410 STOPLOSS 4404 TP 4420 …
 *
 * Entry from two prices: long → min, short → max. Falls back to ctraderGoldParser
 * when FTG patterns do not match.
 */

const entryZone = (signalType: 'long' | 'short', a: number, b: number): number =>
  signalType === 'long' ? Math.min(a, b) : Math.max(a, b);

const resolveFtgTradingPair = (content: string): string | null => {
  const combined = content.match(/#?\$?\s*(GOLD\/XAUUSD)\b/i);
  if (combined) return normalizeAssetAliasToCTraderPair(combined[1]);
  const tag = content.match(/#?\$?\s*(GOLD|XAUUSD|XAU|XAUT)\b/i);
  if (tag) return normalizeAssetAliasToCTraderPair(tag[1]);
  if (/\bXAUUSD\b/i.test(content)) return 'XAUUSD';
  return null;
};

const extractEntryAndSide = (
  content: string,
): { signalType: 'long' | 'short'; entryPrice: number } | null => {
  const t = content.trim();

  let m = t.match(/#GOLD\/XAUUSD\s+(buy|sell)\s+now\s+([\d.]+)/i);
  if (m) {
    const entryPrice = parseFloat(m[2]);
    if (isNaN(entryPrice) || entryPrice <= 0) return null;
    return {
      signalType: m[1].toLowerCase() === 'buy' ? 'long' : 'short',
      entryPrice,
    };
  }

  m = t.match(/\$?XAUUSD\s+(buy|sell)\s+([\d.]+)\s*\/\s*([\d.]+)/i);
  if (m) {
    const a = parseFloat(m[2]);
    const b = parseFloat(m[3]);
    if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;
    const signalType = m[1].toLowerCase() === 'buy' ? 'long' : 'short';
    return { signalType, entryPrice: entryZone(signalType, a, b) };
  }

  m = t.match(/#?\$?\s*XAUUSD\s+(buy|sell)\s+([\d.]+)\s+([\d.]+)/i);
  if (m) {
    const a = parseFloat(m[2]);
    const b = parseFloat(m[3]);
    if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;
    const signalType = m[1].toLowerCase() === 'buy' ? 'long' : 'short';
    return { signalType, entryPrice: entryZone(signalType, a, b) };
  }

  m = t.match(/\$?GOLD\s+(buying|selling)\s+now\b/i);
  if (m) {
    const signalType = m[1].toLowerCase() === 'buying' ? 'long' : 'short';
    const entries = t.match(/ENTRIES:\s*([\d.]+)__([\d.]+)/i);
    if (entries) {
      const a = parseFloat(entries[1]);
      const b = parseFloat(entries[2]);
      if (!isNaN(a) && !isNaN(b) && a > 0 && b > 0) {
        return { signalType, entryPrice: entryZone(signalType, a, b) };
      }
    }
  }

  if (/\$?GOLD\s+(buy|sell)\s+now\b/im.test(t)) {
    const sideMatch = t.match(/\$?GOLD\s+(buy|sell)\s+now/im);
    if (!sideMatch) return null;
    const signalType = sideMatch[1].toLowerCase() === 'buy' ? 'long' : 'short';
    const lines = t.split(/\r?\n/);
    for (const line of lines) {
      const s = line.trim();
      if (!s || /^\s*TP/i.test(line)) continue;
      if (/\bSL\b/i.test(s) && /\bSL\s*\*?\s*:?\s*[\d.]+/i.test(s)) continue;
      const pair = s.match(/([\d.]+)\s*\/\s*([\d.]+)/);
      if (!pair) continue;
      const a = parseFloat(pair[1]);
      const b = parseFloat(pair[2]);
      if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) continue;
      return { signalType, entryPrice: entryZone(signalType, a, b) };
    }
  }

  m = t.match(/\bXAUUSD\s+(buy|sell)\s+(?:now\s+)?([\d.]+)\/{2}([\d.]+)/i);
  if (m) {
    const a = parseFloat(m[2]);
    const b = parseFloat(m[3]);
    if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;
    const signalType = m[1].toLowerCase() === 'buy' ? 'long' : 'short';
    return { signalType, entryPrice: entryZone(signalType, a, b) };
  }

  return null;
};

const extractStopLoss = (content: string): number | undefined => {
  for (const line of content.split(/\r?\n/)) {
    let m = line.match(/\bSTOPLOSS\s+([\d.]+)/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0) return v;
    }
    m = line.match(/\bSL\s*\*?\s*:?\s*([\d.]+)/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0) return v;
    }
  }
  return undefined;
};

const extractTakeProfits = (content: string): number[] => {
  const tps: number[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^TP/i.test(trimmed)) continue;

    let m = trimmed.match(/^TP\s*\d+\s*:\s*([\d.]+)/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0) tps.push(v);
      continue;
    }

    m = trimmed.match(/^TP\s+([\d.]+)/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0) tps.push(v);
      continue;
    }

    m = trimmed.match(/^TP\s*\D+([\d.]+)/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0) tps.push(v);
    }
  }
  if (tps.length > 0) return tps;

  // Single-line compact: … SL … TP 4455 TP 4458 … (line does not start with TP)
  const inlineTpPattern = /\bTP\s*\d+\s*:\s*([\d.]+)|\bTP\s+([\d.]+)/gi;
  let im: RegExpExecArray | null;
  while ((im = inlineTpPattern.exec(content)) !== null) {
    const v = parseFloat(im[1] ?? im[2] ?? '');
    if (!isNaN(v) && v > 0) tps.push(v);
  }
  return tps;
};

export const ctraderFtgParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = content.trim();
    if (!normalizedContent) return ctraderGoldParser(content, options);

    const tradingPair = resolveFtgTradingPair(normalizedContent);
    if (!tradingPair) return ctraderGoldParser(content, options);

    const entrySide = extractEntryAndSide(normalizedContent);
    if (!entrySide) return ctraderGoldParser(content, options);

    const stopLoss = extractStopLoss(normalizedContent);
    if (stopLoss === undefined) return ctraderGoldParser(content, options);

    const takeProfitsRaw = extractTakeProfits(normalizedContent);
    if (takeProfitsRaw.length === 0) return ctraderGoldParser(content, options);

    const takeProfits = [...takeProfitsRaw];
    if (entrySide.signalType === 'long') {
      takeProfits.sort((a, b) => a - b);
    } else {
      takeProfits.sort((a, b) => b - a);
    }

    const deduplicatedTPs = deduplicateTakeProfits(takeProfits, entrySide.signalType);
    if (deduplicatedTPs.length === 0) return ctraderGoldParser(content, options);

    const leverage = 20;

    const parsedOrder: ParsedOrder = {
      tradingPair,
      entryPrice: entrySide.entryPrice,
      stopLoss,
      takeProfits: deduplicatedTPs,
      leverage,
      signalType: entrySide.signalType,
    };

    if (!validateParsedOrder(parsedOrder, { message: content })) {
      return ctraderGoldParser(content, options);
    }

    return parsedOrder;
  } catch {
    return ctraderGoldParser(content, options);
  }
};
