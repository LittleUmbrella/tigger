import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';
import { normalizeAssetAliasToCTraderPair } from '../utils/ctraderSymbolUtils.js';

/**
 * Kashif Liquidity Hunter (KLH), Telegram channel 2498976211.
 *
 * Format 1:
 * (optional title line, e.g. channel branding)
 * #XAUUSD SELL NOW 4520/4522
 * TP: 4515
 * TP: 4510
 * SL : 4530
 *
 * Symbol: optional # or $ prefix; GOLD / XAU / XAUT / XAUUSD (normalized to XAUUSD).
 * Side: BUY NOW or SELL NOW followed by entry range low/high separated by /.
 * Entry range on the signal line is informational only; ParsedOrder omits entryPrice (market execution).
 * Take profits: lines starting with TP optional colon/spaces before the price.
 * Stop loss: line starting with SL, flexible spaces/colon before the price (e.g. "SL : 4530").
 *
 * Format 2 (single line): same tokens on one line, e.g.
 * #XAUUSD BUY NOW 4788/4786 TP: 4793 TP: 4798 SL : 4778
 */
const collectTakeProfitsLineAnchored = (lines: string[]): number[] => {
  const takeProfits: number[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*T[Pp]\s*:?\s*([\d.]+)/);
    if (m) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0) takeProfits.push(v);
    }
  }
  return takeProfits;
};

/** TP segments after whitespace or line start (single-line and inline tails). */
const collectTakeProfitsFromFullText = (text: string): number[] => {
  const takeProfits: number[] = [];
  const re = /(?:^|\s)T[Pp]\s*:?\s*([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1]);
    if (!isNaN(v) && v > 0) takeProfits.push(v);
  }
  return takeProfits;
};

const findStopLossLineAnchored = (lines: string[]): number | undefined => {
  for (const line of lines) {
    const m = line.match(/^\s*S[Ll]\s*[\s:]*([\d.]+)/i);
    if (m) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v > 0) return v;
    }
  }
  return undefined;
};

/** SL after line start or whitespace (same line as signal when not line-leading). */
const findStopLossInFullText = (text: string): number | undefined => {
  const m = text.match(/(?:^|\s)S[Ll]\s*[\s:]*([\d.]+)/i);
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  if (isNaN(v) || v <= 0) return undefined;
  return v;
};

export const ctraderKlhParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = content.trim();
    const lines = normalizedContent.split(/\r?\n/);

    let tradingPair: string | undefined;
    let signalType: 'long' | 'short' | undefined;

    const signalLineRe =
      /#?\$?\s*(GOLD|XAUUSD|XAU|XAUT)\s+(BUY|SELL)\s+NOW\s+([\d.]+)\s*\/\s*([\d.]+)/i;

    for (const line of lines) {
      const m = line.match(signalLineRe);
      if (!m) continue;
      tradingPair = normalizeAssetAliasToCTraderPair(m[1]);
      signalType = m[2].toLowerCase() === 'buy' ? 'long' : 'short';
      const a = parseFloat(m[3]);
      const b = parseFloat(m[4]);
      if (isNaN(a) || isNaN(b) || a <= 0 || b <= 0) return null;
      break;
    }

    if (!tradingPair || !signalType) return null;

    let stopLoss = findStopLossLineAnchored(lines);
    if (stopLoss === undefined) {
      stopLoss = findStopLossInFullText(normalizedContent);
    }
    if (stopLoss === undefined) return null;

    let takeProfits = collectTakeProfitsLineAnchored(lines);
    if (takeProfits.length === 0) {
      takeProfits = collectTakeProfitsFromFullText(normalizedContent);
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
