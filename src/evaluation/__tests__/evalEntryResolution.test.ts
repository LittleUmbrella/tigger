import { describe, expect, it } from 'vitest';
import {
  clampMarketRangeFillPrice,
  filterTakeProfitsAtMarketQuote,
  resolveEvalEntryMode,
  validateMarketRangeEntry,
} from '../evalEntryResolution.js';

describe('filterTakeProfitsAtMarketQuote', () => {
  it('keeps TPs beyond quote for a short', () => {
    const { activeTPs, skippedTPs } = filterTakeProfitsAtMarketQuote(
      'short',
      [4538, 4533, 4527, 4512],
      4540,
      0
    );
    expect(activeTPs).toEqual([4538, 4533, 4527, 4512]);
    expect(skippedTPs).toEqual([]);
  });

  it('rejects when too many TPs are past quote', () => {
    expect(() =>
      filterTakeProfitsAtMarketQuote('short', [4550, 4560], 4540, 0)
    ).toThrow(/already past current price/);
  });

  it('allows skipped TPs within maxSkippablePastTPs', () => {
    const { activeTPs, skippedTPs } = filterTakeProfitsAtMarketQuote(
      'short',
      [4545, 4530, 4520],
      4540,
      1
    );
    expect(skippedTPs).toEqual([4545]);
    expect(activeTPs).toEqual([4530, 4520]);
  });
});

describe('validateMarketRangeEntry', () => {
  it('returns boundary TP when quote has room', () => {
    expect(
      validateMarketRangeEntry({
        signalType: 'short',
        currentPrice: 4540,
        takeProfits: [4538, 4533],
        maxSkippablePastTPs: 0,
        pipSize: 0.01,
      })
    ).toBe(4538);
  });

  it('rejects when quote is past boundary TP', () => {
    expect(() =>
      validateMarketRangeEntry({
        signalType: 'short',
        currentPrice: 4530,
        takeProfits: [4538, 4533],
        maxSkippablePastTPs: 0,
        pipSize: 0.01,
      })
    ).toThrow(/already at or past boundary TP/);
  });
});

describe('clampMarketRangeFillPrice', () => {
  it('caps long fill at boundary TP', () => {
    expect(clampMarketRangeFillPrice('long', 4512, 4510)).toBe(4510);
    expect(clampMarketRangeFillPrice('long', 4505, 4510)).toBe(4505);
  });

  it('floors short fill at boundary TP', () => {
    expect(clampMarketRangeFillPrice('short', 4530, 4538)).toBe(4538);
    expect(clampMarketRangeFillPrice('short', 4545, 4538)).toBe(4545);
  });
});

describe('resolveEvalEntryMode', () => {
  it('uses limit when parser supplies entry and not market execution', () => {
    expect(
      resolveEvalEntryMode({
        order: {
          tradingPair: 'XAUUSD',
          leverage: 20,
          entryPrice: 4540,
          stopLoss: 4559,
          takeProfits: [4538],
          signalType: 'short',
        },
        useLimitOrderForEntry: true,
      })
    ).toEqual({ entryOrderType: 'limit', useMarketRange: false });
  });

  it('uses MARKET_RANGE when configured and quote is valid', () => {
    expect(
      resolveEvalEntryMode({
        order: {
          tradingPair: 'XAUUSD',
          leverage: 20,
          stopLoss: 4559,
          takeProfits: [4538, 4533],
          signalType: 'short',
          marketExecution: true,
        },
        useMarketRangeForEntry: true,
        currentPrice: 4540,
        pipSize: 0.01,
      })
    ).toMatchObject({
      entryOrderType: 'market',
      useMarketRange: true,
      quotePrice: 4540,
      boundaryTp: 4538,
    });
  });
});
