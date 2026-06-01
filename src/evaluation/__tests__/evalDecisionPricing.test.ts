import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import type { HistoricalPriceProvider } from '../../utils/historicalPriceProvider.js';
import {
  getEvalDecisionQuotePrice,
  getEvalDecisionTime,
} from '../evalDecisionPricing.js';
import { SIGNAL_EVAL_DELAY_MS } from '../../utils/ctraderHybridEvalTiming.js';

const signalTime = dayjs('2026-01-08T12:36:03.000Z');

const stubProvider = (
  overrides: Partial<HistoricalPriceProvider>
): HistoricalPriceProvider => ({
  advanceTime: () => {},
  getCurrentTime: () => signalTime,
  setCurrentTime: () => {},
  getCurrentPrice: async () => null,
  getPriceAtTime: async () => null,
  prefetchPriceData: async () => {},
  getPriceHistory: async () => [],
  hasData: () => false,
  getAvailableSymbols: () => [],
  getBybitClient: () => null,
  ...overrides,
});

describe('getEvalDecisionTime', () => {
  it('adds SIGNAL_EVAL_DELAY to signal time', () => {
    expect(getEvalDecisionTime(signalTime).valueOf()).toBe(
      signalTime.valueOf() + SIGNAL_EVAL_DELAY_MS
    );
  });
});

describe('getEvalDecisionQuotePrice', () => {
  it('uses getEvalStartTickPrice when available (no hybrid M1 fetch)', async () => {
    const getEvalStartTickPrice = vi.fn(async () => 4421.98);
    const getHybridEvalPriceHistory = vi.fn(async () => []);

    await expect(
      getEvalDecisionQuotePrice(
        stubProvider({ getEvalStartTickPrice, getHybridEvalPriceHistory }),
        'XAU/USD',
        signalTime
      )
    ).resolves.toBe(4421.98);

    expect(getEvalStartTickPrice).toHaveBeenCalledOnce();
    expect(getHybridEvalPriceHistory).not.toHaveBeenCalled();
  });

  it('falls back to getPriceAtTime at decision time without eval start tick', async () => {
    let priceAtTime: dayjs.Dayjs | null = null;

    await expect(
      getEvalDecisionQuotePrice(
        stubProvider({
          getPriceAtTime: async (_symbol, time) => {
            priceAtTime = time;
            return 5044.29;
          },
        }),
        'BTC/USDT',
        signalTime
      )
    ).resolves.toBe(5044.29);

    expect(priceAtTime).toEqual(getEvalDecisionTime(signalTime));
  });
});
