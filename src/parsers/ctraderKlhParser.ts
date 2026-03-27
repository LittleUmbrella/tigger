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
 * Entry: long → min(low, high), short → max(low, high) (same convention as ctraderFtgParser).
 * Take profits: lines starting with TP optional colon/spaces before the price.
 * Stop loss: line starting with SL, flexible spaces/colon before the price (e.g. "SL : 4530").
 */
const entryZone = (signalType: 'long' | 'short', a: number, b: number): number =>
  signalType === 'long' ? Math.min(a, b) : Math.max(a, b);

export const ctraderKlhParser = (content: string, options?: ParserOptions): ParsedOrder | null => {
  try {
    const normalizedContent = content.trim();
    const lines = normalizedContent.split(/\r?\n/);

    let tradingPair: string | undefined;
    let signalType: 'long' | 'short' | undefined;
    let entryPrice: number | undefined;

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
      entryPrice = entryZone(signalType, a, b);
      break;
    }

    if (!tradingPair || !signalType || entryPrice === undefined) return null;

    let stopLoss: number | undefined;
    for (const line of lines) {
      const m = line.match(/^\s*S[Ll]\s*[\s:]*([\d.]+)/i);
      if (m) {
        const v = parseFloat(m[1]);
        if (!isNaN(v) && v > 0) {
          stopLoss = v;
          break;
        }
      }
    }
    if (stopLoss === undefined) return null;

    const takeProfits: number[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*T[Pp]\s*:?\s*([\d.]+)/);
      if (m) {
        const v = parseFloat(m[1]);
        if (!isNaN(v) && v > 0) takeProfits.push(v);
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
