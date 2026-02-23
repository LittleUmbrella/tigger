/**
 * cTrader Historical Price Provider
 *
 * Fetches historical OHLC data from cTrader Open API (ProtoOAGetTrendbarsReq)
 * for evaluation/backtesting of Forex and CFD symbols.
 */

import dayjs from 'dayjs';
import { logger } from './logger.js';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import type { HistoricalPriceProvider, PriceDataPoint } from './historicalPriceProvider.js';
import { normalizeCTraderSymbol } from './ctraderSymbolUtils.js';

interface CTraderPriceProviderState {
  priceCache: Map<string, PriceDataPoint[]>;
  inFlightRequests: Map<string, Promise<PriceDataPoint[]>>;
  currentTime: dayjs.Dayjs;
  speedMultiplier: number;
  startTime: dayjs.Dayjs;
  ctraderClient: CTraderClient;
}

export interface CTraderHistoricalPriceProviderOptions {
  /** Use tick data instead of M1 candles for maximum precision (more API calls, 1-week chunks) */
  useTickData?: boolean;
}

/**
 * Create a historical price provider that fetches data from cTrader Open API
 */
export function createCTraderHistoricalPriceProvider(
  startDate: string,
  speedMultiplier: number,
  config: CTraderClientConfig,
  options?: CTraderHistoricalPriceProviderOptions
): HistoricalPriceProvider {
  const useTickData = options?.useTickData ?? false;
  const ctraderClient = new CTraderClient(config);

  const state: CTraderPriceProviderState = {
    priceCache: new Map(),
    inFlightRequests: new Map(),
    currentTime: dayjs(startDate),
    speedMultiplier,
    startTime: dayjs(startDate),
    ctraderClient,
  };

  const fetchPriceData = async (
    symbol: string,
    startTime: dayjs.Dayjs,
    endTime: dayjs.Dayjs
  ): Promise<PriceDataPoint[]> => {
    const normalizedSymbol = normalizeCTraderSymbol(symbol);
    const cacheKey = `${normalizedSymbol}_${startTime.valueOf()}_${endTime.valueOf()}_${useTickData ? 'tick' : 'm1'}`;

    if (state.priceCache.has(cacheKey)) {
      return state.priceCache.get(cacheKey)!;
    }

    if (state.inFlightRequests.has(cacheKey)) {
      return state.inFlightRequests.get(cacheKey)!;
    }

    const fetchPromise = (async () => {
      try {
        await ctraderClient.connect();
        await ctraderClient.authenticate();

        let pricePoints: PriceDataPoint[];

        if (useTickData) {
          const ticks = await ctraderClient.getTickData({
            symbol: normalizedSymbol,
            fromTimestamp: startTime.valueOf(),
            toTimestamp: endTime.valueOf(),
          });
          pricePoints = ticks.map((t) => ({
            timestamp: t.timestamp,
            price: t.price,
            high: t.price,
            low: t.price,
          }));
          logger.info('Fetched cTrader tick data', {
            symbol: normalizedSymbol,
            dataPoints: pricePoints.length,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
          });
        } else {
          const bars = await ctraderClient.getTrendbars({
            symbol: normalizedSymbol,
            fromTimestamp: startTime.valueOf(),
            toTimestamp: endTime.valueOf(),
            period: 'M1',
          });
          pricePoints = bars.map((b) => ({
            timestamp: b.timestamp,
            price: b.price,
            high: b.high,
            low: b.low,
          }));
          logger.info('Fetched cTrader historical price data', {
            symbol: normalizedSymbol,
            dataPoints: pricePoints.length,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
          });
        }

        pricePoints.sort((a, b) => a.timestamp - b.timestamp);
        state.priceCache.set(cacheKey, pricePoints);

        return pricePoints;
      } catch (error) {
        logger.warn('Failed to fetch cTrader price data', {
          symbol: normalizedSymbol,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      } finally {
        state.inFlightRequests.delete(cacheKey);
      }
    })();

    state.inFlightRequests.set(cacheKey, fetchPromise);
    return fetchPromise;
  };

  return {
    advanceTime: (ms: number) => {
      state.currentTime = state.currentTime.add(ms * state.speedMultiplier, 'millisecond');
    },

    getCurrentTime: () => state.currentTime,

    setCurrentTime: (time: dayjs.Dayjs) => {
      state.currentTime = time;
    },

    getCurrentPrice: async (symbol: string): Promise<number | null> => {
      const normalizedSymbol = normalizeCTraderSymbol(symbol);
      const fetchStart = state.currentTime.subtract(1, 'hour');
      const fetchEnd = state.currentTime.add(1, 'hour');
      const data = await fetchPriceData(normalizedSymbol, fetchStart, fetchEnd);

      if (!data || data.length === 0) return null;

      const targetTs = state.currentTime.valueOf();
      let closest = data[0];
      for (const p of data) {
        if (p.timestamp <= targetTs) closest = p;
        else break;
      }
      return closest.price;
    },

    getPriceAtTime: async (symbol: string, time: dayjs.Dayjs): Promise<number | null> => {
      const normalizedSymbol = normalizeCTraderSymbol(symbol);
      const fetchStart = time.subtract(1, 'hour');
      const fetchEnd = time.add(1, 'hour');
      const data = await fetchPriceData(normalizedSymbol, fetchStart, fetchEnd);

      if (!data || data.length === 0) return null;

      const targetTs = time.valueOf();
      let closest = data[0];
      for (const p of data) {
        if (p.timestamp <= targetTs) closest = p;
        else break;
      }
      return closest.price;
    },

    prefetchPriceData: async (
      symbol: string,
      messageTime: dayjs.Dayjs,
      maxDurationDays: number = 7
    ): Promise<void> => {
      const normalizedSymbol = normalizeCTraderSymbol(symbol);
      const endTime = messageTime.add(maxDurationDays, 'day');
      logger.info('Pre-fetching cTrader price data', {
        symbol: normalizedSymbol,
        startTime: messageTime.toISOString(),
        endTime: endTime.toISOString(),
      });
      await fetchPriceData(normalizedSymbol, messageTime, endTime);
    },

    getPriceHistory: async (
      symbol: string,
      startTime: dayjs.Dayjs,
      endTime: dayjs.Dayjs
    ): Promise<PriceDataPoint[]> => {
      return fetchPriceData(normalizeCTraderSymbol(symbol), startTime, endTime);
    },

    hasData: (symbol: string): boolean => {
      const normalizedSymbol = normalizeCTraderSymbol(symbol);
      for (const key of state.priceCache.keys()) {
        if (key.startsWith(normalizedSymbol + '_')) return true;
      }
      return false;
    },

    getAvailableSymbols: (): string[] => {
      const symbols = new Set<string>();
      for (const key of state.priceCache.keys()) {
        const symbol = key.split('_')[0];
        if (symbol) symbols.add(symbol);
      }
      return Array.from(symbols);
    },

    getBybitClient: () => null,

    getCTraderClient: () => ctraderClient,
  };
}
