/**
 * Normalize trading pair for Bybit REST API (linear / category calls).
 * "FLUX", "FLUX/USDT" → "FLUXUSDT". USDC pairs are left as-is.
 */
export function normalizeBybitSymbol(tradingPair: string): string {
  let normalized = tradingPair.replace('/', '').toUpperCase();
  if (!normalized.endsWith('USDT') && !normalized.endsWith('USDC')) {
    normalized = `${normalized}USDT`;
  }
  return normalized;
}
