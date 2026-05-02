import { ParsedOrder } from '../types/order.js';
import { validateParsedOrder } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { ParserOptions } from './parserRegistry.js';

/**
 * Parses CMP-style crypto signals (Discord). CMP = current market price: we intentionally omit
 * `entryPrice` so Bybit places a Limit at ticker last price (pseudo-market path). DCA lines in
 * messages are ignored. Format still expects a CMP line so the signal is recognizable:
 *
 * Long: ID/USDT
 * Entry at CMP: 0.03155   (informative reference only — not used as limit price)
 * TP ➊: ...
 * SL: ...
 */
export const cmpDcaSignalParser = (content: string, _options?: ParserOptions): ParsedOrder | null => {
  const sideMatch = content.match(/^\s*(Long|Short)\s*:\s*([\w.-]+)\s*\/\s*(USDT|USDC|USD)\b/im);
  if (!sideMatch) return null;

  const signalType = sideMatch[1].toLowerCase() === 'long' ? 'long' : 'short';
  let base = sideMatch[2].toUpperCase();
  let quote = sideMatch[3].toUpperCase();
  if (quote === 'USD') quote = 'USDT';
  const tradingPair = `${base}${quote}`;

  const cmpMatch =
    content.match(/Entry\s+at\s+CMP\s*:\s*([\d.]+)/i) || content.match(/\bCMP\s*:\s*([\d.]+)/i);
  if (!cmpMatch) return null;
  const cmpRef = parseFloat(cmpMatch[1]);
  if (!Number.isFinite(cmpRef) || cmpRef <= 0) return null;

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

  let leverage = 20;
  const levRange = content.match(/\(\s*(\d+)\s*[x×]\s*-\s*(\d+)\s*[x×]\s*[Ll]everage\s*\)/);
  const levSingle = content.match(/\b(\d+)\s*[x×]\s*[Ll]everage\b/i);
  if (levRange) {
    const lo = parseInt(levRange[1], 10);
    const hi = parseInt(levRange[2], 10);
    leverage = Number.isFinite(lo) && Number.isFinite(hi) ? Math.min(lo, hi) : leverage;
    if (!Number.isFinite(lo) || lo < 1) leverage = 20;
  } else if (levSingle) {
    const lx = parseInt(levSingle[1], 10);
    if (Number.isFinite(lx) && lx >= 1) leverage = lx;
  }

  let stopLoss = NaN;
  const belowSl = content.match(/\bSL\s*:\s*[^\n\r]*below\s+([\d.]+)/i);
  const aboveSl = content.match(/\bSL\s*:\s*[^\n\r]*above\s+([\d.]+)/i);
  const numericSl = content.match(/\bSL\s*:\s*([\d.]+)/i);

  if (signalType === 'long' && belowSl) stopLoss = parseFloat(belowSl[1]);
  else if (signalType === 'short' && aboveSl) stopLoss = parseFloat(aboveSl[1]);
  else if (numericSl) stopLoss = parseFloat(numericSl[1]);

  // If only directional phrase matches the wrong side (e.g. "below" on a short hint), retry plain numeric SL.
  if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
    if (numericSl) stopLoss = parseFloat(numericSl[1]);
  }

  if (!Number.isFinite(stopLoss) || stopLoss <= 0) return null;

  const parsed: ParsedOrder = {
    tradingPair,
    leverage,
    stopLoss,
    takeProfits,
    signalType,
    // Omit entryPrice: initiator treats as market-at-touch (Bybit → limit @ last traded price).
  };

  if (!validateParsedOrder(parsed, { message: content })) return null;

  return parsed;
};
