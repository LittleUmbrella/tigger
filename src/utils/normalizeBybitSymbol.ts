/**
 * Canonical Bybit symbol normalization for REST API calls (linear / spot).
 *
 * Examples:
 * - "FLUX", "FLUX/USDT" → "FLUXUSDT"
 * - "BTCUSD" (cTrader-style) → "BTCUSDT"
 * - USDC pairs are left as-is
 */
export function normalizeBybitSymbol(tradingPair: string): string {
  let normalized = tradingPair.replace('/', '').toUpperCase();
  if (
    normalized.endsWith('USD') &&
    !normalized.endsWith('USDT') &&
    !normalized.endsWith('USDC')
  ) {
    return normalized.replace(/USD$/, 'USDT');
  }
  if (!normalized.endsWith('USDT') && !normalized.endsWith('USDC')) {
    normalized = `${normalized}USDT`;
  }
  return normalized;
}
