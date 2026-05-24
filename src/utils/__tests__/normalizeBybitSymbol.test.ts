import { describe, expect, it } from 'vitest';
import { normalizeBybitSymbol } from '../normalizeBybitSymbol.js';

describe('normalizeBybitSymbol', () => {
  it('appends USDT when quote is missing', () => {
    expect(normalizeBybitSymbol('FLUX')).toBe('FLUXUSDT');
    expect(normalizeBybitSymbol('flux')).toBe('FLUXUSDT');
  });

  it('strips slash and uppercases', () => {
    expect(normalizeBybitSymbol('btc/usdt')).toBe('BTCUSDT');
  });

  it('leaves USDC pairs unchanged', () => {
    expect(normalizeBybitSymbol('ETHUSDC')).toBe('ETHUSDC');
    expect(normalizeBybitSymbol('eth/usdc')).toBe('ETHUSDC');
  });

  it('does not double-append when already USDT', () => {
    expect(normalizeBybitSymbol('BTCUSDT')).toBe('BTCUSDT');
  });
});
