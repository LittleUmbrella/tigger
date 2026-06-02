import { describe, expect, it } from 'vitest';
import { isCtraderGoldSymbol } from '../ctraderGoldSymbol.js';

describe('isCtraderGoldSymbol', () => {
  it('detects XAUUSD and gold aliases', () => {
    expect(isCtraderGoldSymbol('XAUUSD')).toBe(true);
    expect(isCtraderGoldSymbol('XAU/USDT')).toBe(true);
    expect(isCtraderGoldSymbol('GOLD')).toBe(true);
    expect(isCtraderGoldSymbol('gold buy now')).toBe(true);
  });

  it('does not treat unrelated pairs as gold', () => {
    expect(isCtraderGoldSymbol('EURUSD')).toBe(false);
    expect(isCtraderGoldSymbol('BTCUSDT')).toBe(false);
  });
});
