/**
 * Persistent Bybit API response cache (evaluation re-runs).
 */

import { createDiskResponseCache } from './diskResponseCache.js';

const bybitCache = createDiskResponseCache('bybit-cache');

export const getCachedResponse = bybitCache.getCachedResponse;
export const setCachedResponse = bybitCache.setCachedResponse;
export const clearCache = bybitCache.clearCache;
export const getCacheStats = bybitCache.getCacheStats;

/** cTrader M1/tick trendbar cache for evaluation backtests */
const ctraderCache = createDiskResponseCache('ctrader-cache');

export const getCtraderCachedResponse = ctraderCache.getCachedResponse;
export const setCtraderCachedResponse = ctraderCache.setCachedResponse;
export const clearCtraderCache = ctraderCache.clearCache;
export const getCtraderCacheStats = ctraderCache.getCacheStats;
