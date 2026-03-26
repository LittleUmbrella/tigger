/**
 * cTrader Symbol Utilities
 *
 * Normalizes trading pair symbols for cTrader (forex/CFD) format.
 * cTrader uses symbols like EURUSD, XAUUSD - not crypto pairs like XAUTUSDT.
 */

/** Crypto gold tokens that map to forex XAU (physical gold spot) on cTrader */
const CRYPTO_GOLD_TO_XAU: Record<string, string> = {
  XAUT: 'XAU',  // Tether Gold (crypto token) -> XAU/USD (forex)
  PAXG: 'XAU',  // Paxos Gold (crypto token) -> XAU/USD (forex)
};

const GOLD_FAMILY_ALIASES = new Set(['GOLD', 'XAU', 'XAUT', 'XAUUSD']);

/**
 * Map parser-extracted asset or pair tokens to canonical cTrader symbols.
 * Gold-style aliases (gold, XAU, XAUT, XAUUSD) → XAUUSD.
 * Any other token (e.g. EURNZD, EURUSD) is trimmed and uppercased, unchanged.
 */
export function normalizeAssetAliasToCTraderPair(raw: string): string {
  const u = raw.trim().replace(/\s+/g, '').toUpperCase();
  if (GOLD_FAMILY_ALIASES.has(u)) {
    return 'XAUUSD';
  }
  return u;
}

/**
 * Normalize trading pair symbol for cTrader.
 * cTrader uses forex/CFD format: EURUSD, XAUUSD, BTCUSD (no USDT).
 *
 * - XAUTUSDT -> XAUUSD (crypto gold token -> forex gold)
 * - PAXGUSDT -> XAUUSD (crypto gold -> forex gold)
 * - BTCUSDT -> BTCUSD
 * - EURUSD -> EURUSD (unchanged)
 */
export function normalizeCTraderSymbol(tradingPair: string): string {
  let normalized = tradingPair.replace('/', '').toUpperCase();

  // Map crypto gold tokens to forex gold (cTrader has XAUUSD, not XAUTUSDT)
  if (normalized.endsWith('USDT') || normalized.endsWith('USDC')) {
    const base = normalized.replace(/USDT$|USDC$/, '');
    const mappedBase = CRYPTO_GOLD_TO_XAU[base] ?? base;
    return `${mappedBase}USD`;
  }

  // Already ends with USD (e.g. EURUSD, XAUUSD) - leave as-is
  if (normalized.endsWith('USD')) {
    return normalized;
  }

  // Other forex quotes (EUR, GBP, JPY) - leave as-is
  const forexQuotes = ['EUR', 'GBP', 'JPY'];
  if (forexQuotes.some((q) => normalized.endsWith(q))) {
    return normalized;
  }

  // No quote or unknown - append USD
  return normalized + 'USD';
}
