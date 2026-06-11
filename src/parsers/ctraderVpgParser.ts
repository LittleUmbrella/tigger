import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';
import { ctraderDgfVipParser } from './ctraderDgfVipParser.js';
import { ctraderFtgParser } from './ctraderFtgParser.js';

/**
 * VIP GOLD CLUB (VPG), Telegram channel 3245475213.
 *
 * Format 1 (slash entry, numbered TPs — delegated to ctraderFtgParser):
 * $XAUUSD SELL 4107/ 4109 SL: 4116 TP 1:4100 TP 2:4095 TP 3:4090
 *
 * Format 2 (emoji header, Entry range, arrow TPs — delegated to ctraderDgfVipParser):
 * 📢 XAUUSD | BUY SIGNAL 🟢 Entry: 4089-4094 🛑 SL: 4080 🎯 TP Levels: TP1 ➝ 4098 …
 *
 * Format 3 (underscore entry range, STOP LOSS, superscript TPs):
 * #XAUUSD BUYING 4072_4068 STOP LOSS 4063 TP¹: 4075 TP²: 4078 …
 *
 * Format 4 (dot-prefixed slash entry, bullet superscript TPs):
 * 🎓 GOLD BUY .4147/4144 TP ¹• 4150 TP ²• 4153 … ♦️ SL ° 4137
 */

const SUPERSCRIPT_TP =
  /TP[\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079]*\s*:?\s*([\d.]+)/gi;

const collectSuperscriptTakeProfits = (content: string): number[] => {
  const takeProfits: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = SUPERSCRIPT_TP.exec(content)) !== null) {
    const value = parseFloat(match[1]);
    if (!isNaN(value) && value > 0) takeProfits.push(value);
  }
  return takeProfits;
};

const collectBulletSuperscriptTakeProfits = (content: string): number[] => {
  const takeProfits: number[] = [];
  const pattern =
    /TP\s*[\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079]*\s*[•·]\s*([\d.]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const value = parseFloat(match[1]);
    if (!isNaN(value) && value > 0) takeProfits.push(value);
  }
  return takeProfits;
};

const buildParsedOrder = (
  content: string,
  tradingPair: string,
  signalType: 'long' | 'short',
  stopLoss: number,
  takeProfits: number[],
  entryPrice?: number,
  entryTargets?: [number, number],
): ParsedOrder | null => {
  const sortedTps = [...takeProfits];
  if (signalType === 'long') sortedTps.sort((a, b) => a - b);
  else sortedTps.sort((a, b) => b - a);

  const deduplicatedTPs = deduplicateTakeProfits(sortedTps, signalType);
  if (deduplicatedTPs.length === 0) return null;

  const parsedOrder: ParsedOrder = {
    tradingPair,
    entryPrice,
    entryTargets,
    stopLoss,
    takeProfits: deduplicatedTPs,
    leverage: 20,
    signalType,
  };

  if (!validateParsedOrder(parsedOrder, { message: content })) return null;
  return parsedOrder;
};

/** Format 3: #XAUUSD BUYING 4072_4068 STOP LOSS 4063 TP¹: … */
const parseVpgUnderscoreBuying = (
  content: string,
  options?: ParserOptions,
): ParsedOrder | null => {
  const header = content.match(
    /#?\$?\s*(?:GOLD|XAUUSD|XAU|XAUT)\s+(BUYING|SELLING)\s+([\d.]+)_([\d.]+)/i,
  );
  if (!header) return null;

  const signalType = header[1].toUpperCase() === 'BUYING' ? 'long' : 'short';
  const a = parseFloat(header[2]);
  const b = parseFloat(header[3]);
  if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;

  const slMatch = content.match(/\bSTOP\s+LOSS\s+([\d.]+)/i);
  if (!slMatch) return null;
  const stopLoss = parseFloat(slMatch[1]);
  if (isNaN(stopLoss) || stopLoss <= 0) return null;

  const takeProfits = collectSuperscriptTakeProfits(content);
  if (takeProfits.length === 0) return null;

  const tradingPair = normalizeAssetAliasToCTraderPair(header[0].match(/GOLD|XAUUSD|XAU|XAUT/i)?.[0] ?? 'XAUUSD');
  const strategy = options?.entryPriceStrategy || 'worst';
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const entryPrice = calculateEntryPrice(lo, hi, signalType, strategy);

  return buildParsedOrder(
    content,
    tradingPair,
    signalType,
    stopLoss,
    takeProfits,
    entryPrice,
    [lo, hi],
  );
};

/** Format 4: GOLD BUY .4147/4144 TP ¹• 4150 … SL ° 4137 */
const parseVpgGoldDotSlash = (
  content: string,
  options?: ParserOptions,
): ParsedOrder | null => {
  const header = content.match(/\bGOLD\s+(BUY|SELL)\s+\.?([\d.]+)\s*\/\s*([\d.]+)/i);
  if (!header) return null;

  const signalType = header[1].toUpperCase() === 'BUY' ? 'long' : 'short';
  const a = parseFloat(header[2]);
  const b = parseFloat(header[3]);
  if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;

  const slMatch = content.match(/\bSL\s*[^\d\n]*([\d.]+)/i);
  if (!slMatch) return null;
  const stopLoss = parseFloat(slMatch[1]);
  if (isNaN(stopLoss) || stopLoss <= 0) return null;

  const takeProfits = collectBulletSuperscriptTakeProfits(content);
  if (takeProfits.length === 0) return null;

  const tradingPair = normalizeAssetAliasToCTraderPair('GOLD');
  const strategy = options?.entryPriceStrategy || 'worst';
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const entryPrice = calculateEntryPrice(lo, hi, signalType, strategy);

  return buildParsedOrder(
    content,
    tradingPair,
    signalType,
    stopLoss,
    takeProfits,
    entryPrice,
    [lo, hi],
  );
};

export const ctraderVpgParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  const vpgUnderscore = parseVpgUnderscoreBuying(content, options);
  if (vpgUnderscore) return vpgUnderscore;

  const vpgDotSlash = parseVpgGoldDotSlash(content, options);
  if (vpgDotSlash) return vpgDotSlash;

  const dgfVip = ctraderDgfVipParser(content, options);
  if (dgfVip) return dgfVip;

  return ctraderFtgParser(content, options);
};
