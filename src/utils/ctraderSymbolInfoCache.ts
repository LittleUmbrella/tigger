import type { CTraderClient } from '../clients/ctraderClient.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

type CacheEntry = {
  info: unknown;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

const cacheKey = (accountKey: string, symbol: string): string => `${accountKey}:${symbol.toUpperCase()}`;

export const getCachedCTraderSymbolInfo = async (
  client: CTraderClient,
  accountKey: string,
  symbol: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<unknown> => {
  const key = cacheKey(accountKey, symbol);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.info;
  }

  const info = await client.getSymbolInfo(symbol);
  cache.set(key, { info, expiresAt: now + ttlMs });
  return info;
};

/** Visible for tests */
export const clearCTraderSymbolInfoCache = (): void => {
  cache.clear();
};
