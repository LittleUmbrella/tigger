import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { validateParsedOrder, validateTradePrices } from '../tradeValidation.js';
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
