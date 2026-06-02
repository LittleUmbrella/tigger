import { normalizeCTraderSymbol } from './ctraderSymbolUtils.js';

/** cTrader symbols where symbol validation / getSymbolInfo can be skipped (known gold/XAU). */
export const isCtraderGoldSymbol = (tradingPair: string): boolean => {
  const normalized = normalizeCTraderSymbol(tradingPair);
  if (normalized === 'XAUUSD') {
    return true;
  }
  const compact = tradingPair.replace(/\s+/g, '').replace('/', '').toUpperCase();
  return compact.includes('GOLD') || compact.startsWith('XAU');
};
