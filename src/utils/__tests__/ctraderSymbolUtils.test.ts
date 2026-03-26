import { describe, it, expect } from 'vitest';
import {
  normalizeAssetAliasToCTraderPair,
  normalizeCTraderSymbol,
} from '../ctraderSymbolUtils.js';

describe('normalizeAssetAliasToCTraderPair', () => {
  it('maps gold-family aliases to XAUUSD', () => {
    expect(normalizeAssetAliasToCTraderPair('gold')).toBe('XAUUSD');
    expect(normalizeAssetAliasToCTraderPair('XAU')).toBe('XAUUSD');
    expect(normalizeAssetAliasToCTraderPair('XAUT')).toBe('XAUUSD');
    expect(normalizeAssetAliasToCTraderPair('xauusd')).toBe('XAUUSD');
  });

  it('leaves other symbols unchanged (uppercased)', () => {
    expect(normalizeAssetAliasToCTraderPair('EURNZD')).toBe('EURNZD');
    expect(normalizeAssetAliasToCTraderPair('eurusd')).toBe('EURUSD');
  });
});

describe('normalizeCTraderSymbol', () => {
  it('maps XAUTUSDT to XAUUSD (crypto gold -> forex gold)', () => {
    expect(normalizeCTraderSymbol('XAUTUSDT')).toBe('XAUUSD');
    expect(normalizeCTraderSymbol('XAUT/USDT')).toBe('XAUUSD');
  });

  it('maps PAXGUSDT to XAUUSD (crypto gold -> forex gold)', () => {
    expect(normalizeCTraderSymbol('PAXGUSDT')).toBe('XAUUSD');
  });

  it('converts USDT to USD for other pairs', () => {
    expect(normalizeCTraderSymbol('BTCUSDT')).toBe('BTCUSD');
    expect(normalizeCTraderSymbol('ETH/USDT')).toBe('ETHUSD');
  });

  it('leaves forex pairs unchanged', () => {
    expect(normalizeCTraderSymbol('EURUSD')).toBe('EURUSD');
    expect(normalizeCTraderSymbol('XAUUSD')).toBe('XAUUSD');
    expect(normalizeCTraderSymbol('EUR/USD')).toBe('EURUSD');
  });

  it('appends USD for pairs with no quote', () => {
    expect(normalizeCTraderSymbol('BTC')).toBe('BTCUSD');
  });
});
