/**
 * Decision-time pricing for evaluation — aligns sizing quote with mock market fill.
 *
 * SIGNAL_EVAL_DELAY approximates live latency (harvest cycle, initiator, network, API).
 * Market-entry quotes and position sizing use this time, not raw signal time.
 */

import dayjs from 'dayjs';
import type { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { SIGNAL_EVAL_DELAY_MS } from '../utils/ctraderHybridEvalTiming.js';

export const getEvalDecisionTime = (signalTime: dayjs.Dayjs): dayjs.Dayjs =>
  signalTime.add(SIGNAL_EVAL_DELAY_MS, 'millisecond');

/**
 * Quote at decision time (signal + eval delay). For cTrader hybrid eval, uses the
 * first tick at evalStart only (no M1) — same tick mock exchange uses for market fill.
 */
export const getEvalDecisionQuotePrice = async (
  priceProvider: HistoricalPriceProvider,
  symbol: string,
  signalTime: dayjs.Dayjs
): Promise<number | null> => {
  const decisionTime = getEvalDecisionTime(signalTime);

  if (priceProvider.getEvalStartTickPrice) {
    const tickPrice = await priceProvider.getEvalStartTickPrice(symbol, signalTime);
    if (tickPrice != null && tickPrice > 0) {
      return tickPrice;
    }
  }

  return priceProvider.getPriceAtTime(symbol, decisionTime);
};
