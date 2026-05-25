import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  validateParsedOrder,
  validateTradePrices,
  validateCmpSignalPrices,
  priceRatioExceedsSanity,
  CMP_REFERENCE_MAX_PRICE_RATIO,
} from '../tradeValidation.js';
import type { ParsedOrder } from '../../types/order.js';

describe('validateTradePrices', () => {
  it('accepts valid long prices', () => {
    expect(validateTradePrices('long', 100, 95, [105, 110])).toBe(true);
  });

  it('rejects long with SL above entry', () => {
    expect(validateTradePrices('long', 100, 101, [105])).toBe(false);
  });

  it('rejects short with TP above entry', () => {
    expect(validateTradePrices('short', 100, 105, [101])).toBe(false);
  });
});

describe('priceRatioExceedsSanity', () => {
  it('flags ~10x typo between CMP ref and TP', () => {
    expect(priceRatioExceedsSanity(0.0367, 0.00351)).toBe(true);
    expect(priceRatioExceedsSanity(0.0367, 0.0351)).toBe(false);
  });

  it('uses configured max ratio', () => {
    expect(priceRatioExceedsSanity(100, 5, 10)).toBe(true);
    expect(priceRatioExceedsSanity(100, 5, 25)).toBe(false);
    expect(CMP_REFERENCE_MAX_PRICE_RATIO).toBe(10);
  });
});

describe('validateCmpSignalPrices', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts plausible short CMP levels', () => {
    expect(
      validateCmpSignalPrices('short', 0.0367, 0.04044, [0.0351, 0.0329, 0.03044])
    ).toBe(true);
  });

  it('rejects short with typo TPs far below CMP ref', () => {
    expect(validateCmpSignalPrices('short', 0.0367, 0.04044, [0.00351, 0.00329])).toBe(false);
  });

  it('rejects wrong-side TP even when ratio is sane', () => {
    expect(validateCmpSignalPrices('short', 0.0367, 0.04044, [0.037])).toBe(false);
  });
});

describe('validateParsedOrder', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const order: ParsedOrder = {
    tradingPair: 'BTC/USDT',
    entryPrice: 100,
    stopLoss: 95,
    takeProfits: [105],
    leverage: 10,
    signalType: 'long',
  };

  it('skips validation when entry price missing', () => {
    expect(validateParsedOrder({ ...order, entryPrice: undefined })).toBe(true);
  });

  it('validates when entry present', () => {
    expect(validateParsedOrder(order)).toBe(true);
    expect(validateParsedOrder({ ...order, stopLoss: 101 })).toBe(false);
  });
});
