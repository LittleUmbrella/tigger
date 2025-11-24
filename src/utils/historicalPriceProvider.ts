import dayjs from 'dayjs';
import { logger } from './logger.js';
// @ts-ignore - bybit-api types may not be complete
import { RESTClient } from 'bybit-api';

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

export class HistoricalPriceProvider {
  private priceCache: Map<string, PriceDataPoint[]> = new Map();
  private currentTime: dayjs.Dayjs;
  private speedMultiplier: number;
  private startTime: dayjs.Dayjs;
  private bybitClient: RESTClient;
  private fetchInterval: number = 60000; // Fetch prices every minute in simulation time

  private hasAuth: boolean;

  constructor(
    startDate: string,
    speedMultiplier: number = 1.0,
    bybitApiKey?: string,
    bybitApiSecret?: string
  ) {
    this.currentTime = dayjs(startDate);
    this.startTime = dayjs(startDate);
    this.speedMultiplier = speedMultiplier;
    this.hasAuth = !!(bybitApiKey && bybitApiSecret);
    
    // Initialize Bybit client (with auth if available for more granular data)
    this.bybitClient = new RESTClient({
      key: bybitApiKey || '',
      secret: bybitApiSecret || '',
      testnet: false,
    });
    
    logger.info('Historical price provider initialized', {
      startDate,
      speedMultiplier,
      authenticated: this.hasAuth
    });
  }

  // Advance simulation time
  advanceTime(ms: number): void {
    this.currentTime = this.currentTime.add(ms * this.speedMultiplier, 'millisecond');
  }

  // Get current simulation time
  getCurrentTime(): dayjs.Dayjs {
    return this.currentTime;
  }

  // Set current time (used when processing messages in chronological order)
  setCurrentTime(time: dayjs.Dayjs): void {
    this.currentTime = time;
  }

  // Fetch historical price data for a symbol starting from a specific time
  private async fetchPriceData(
    symbol: string,
    startTime: dayjs.Dayjs,
    endTime: dayjs.Dayjs
  ): Promise<PriceDataPoint[]> {
    const normalizedSymbol = symbol.replace('/', '').toUpperCase();
    const cacheKey = `${normalizedSymbol}_${startTime.valueOf()}_${endTime.valueOf()}`;
    
    // Check cache first
    if (this.priceCache.has(cacheKey)) {
      return this.priceCache.get(cacheKey)!;
    }

    try {
      logger.debug('Fetching historical price data', {
        symbol: normalizedSymbol,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString()
      });

      const pricePoints: PriceDataPoint[] = [];
      
      const startTimestamp = startTime.valueOf();
      const endTimestamp = endTime.valueOf();
      
      if (this.hasAuth) {
        // With API key: Use execution history for individual trades (most granular)
        // This provides tick-by-tick price data from actual trade executions
        // Note: Execution history may be limited to recent trades, so we'll try to fetch
        // what's available and supplement with klines for older data
        logger.debug('Using authenticated API for granular trade data', {
          symbol: normalizedSymbol,
          timeRange: `${startTime.toISOString()} to ${endTime.toISOString()}`
        });
        
        try {
          // Fetch execution history (individual trades) - most granular data available
          // Execution history typically returns recent trades, so we fetch in time windows
          const windowSize = 24 * 60 * 60 * 1000; // 24 hours
          let execStart = startTimestamp;
          
          while (execStart < endTimestamp) {
            const execEnd = Math.min(execStart + windowSize, endTimestamp);
            
            try {
              const executionResponse = await this.bybitClient.getExecutionList({
                category: 'linear',
                symbol: normalizedSymbol,
                startTime: execStart,
                endTime: execEnd,
                limit: 1000 // Maximum per request
              });

              if (executionResponse.retCode === 0 && executionResponse.result?.list) {
                for (const execution of executionResponse.result.list) {
                  const execTime = parseFloat(execution.execTime || '0');
                  const execPrice = parseFloat(execution.execPrice || '0');
                  
                  if (execPrice > 0 && execTime >= startTimestamp && execTime <= endTimestamp) {
                    pricePoints.push({
                      timestamp: execTime,
                      price: execPrice
                    });
                  }
                }
                
                logger.debug('Fetched execution history chunk', {
                  symbol: normalizedSymbol,
                  trades: executionResponse.result.list.length,
                  window: `${new Date(execStart).toISOString()} to ${new Date(execEnd).toISOString()}`
                });
              }
            } catch (error) {
              // If execution history fails for this window, continue with klines
              logger.debug('Execution history not available for this time window, using klines', {
                symbol: normalizedSymbol,
                window: `${new Date(execStart).toISOString()} to ${new Date(execEnd).toISOString()}`
              });
            }
            
            execStart = execEnd + 1;
            await new Promise(resolve => setTimeout(resolve, 100)); // Rate limiting
          }
        } catch (error) {
          logger.warn('Error fetching execution history, falling back to klines', {
            symbol: normalizedSymbol,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      // Supplement with kline data for better coverage
      // Use index price kline with 1-minute intervals as base/fallback
      const startTimestampSec = Math.floor(startTime.valueOf() / 1000);
      const endTimestampSec = Math.floor(endTime.valueOf() / 1000);
      
      // Fetch in chunks (Bybit limits to 200 candles per request)
      let currentStart = startTimestampSec;
      const chunkSize = 200 * 60; // 200 minutes in seconds
      
      while (currentStart < endTimestampSec) {
        const currentEnd = Math.min(currentStart + chunkSize, endTimestampSec);
        
        try {
          // Use index price kline with 1-minute interval
          // This fills gaps and provides baseline price data
          const klineResponse = await this.bybitClient.getIndexPriceKline({
            category: 'linear',
            symbol: normalizedSymbol,
            interval: '1', // 1 minute intervals
            start: currentStart * 1000,
            end: currentEnd * 1000,
            limit: 200
          });

          if (klineResponse.retCode === 0 && klineResponse.result?.list) {
            for (const candle of klineResponse.result.list) {
              const timestamp = parseInt(candle[0] || '0');
              const closePrice = parseFloat(candle[4] || '0');
              
              if (closePrice > 0) {
                // Only add if we don't already have a price point very close to this timestamp
                // (within 5 seconds) to avoid duplicates from execution history
                const hasNearbyPrice = pricePoints.some(p => 
                  Math.abs(p.timestamp - timestamp) < 5000
                );
                
                if (!hasNearbyPrice) {
                  pricePoints.push({
                    timestamp: timestamp,
                    price: closePrice
                  });
                }
              }
            }
          }
        } catch (error) {
          logger.warn('Error fetching kline chunk', {
            symbol: normalizedSymbol,
            start: new Date(currentStart * 1000).toISOString(),
            end: new Date(currentEnd * 1000).toISOString(),
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        currentStart = currentEnd + 1;
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      // Sort by timestamp
      pricePoints.sort((a, b) => a.timestamp - b.timestamp);
      
      // Cache the results
      this.priceCache.set(cacheKey, pricePoints);
      
      logger.info('Fetched historical price data', {
        symbol: normalizedSymbol,
        dataPoints: pricePoints.length,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString()
      });

      return pricePoints;
    } catch (error) {
      logger.error('Failed to fetch historical price data', {
        symbol: normalizedSymbol,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  // Get price for a symbol at current simulation time
  async getCurrentPrice(symbol: string): Promise<number | null> {
    return this.getPriceAtTime(symbol, this.currentTime);
  }

  // Get price for a symbol at a specific time
  async getPriceAtTime(symbol: string, time: dayjs.Dayjs): Promise<number | null> {
    const normalizedSymbol = symbol.replace('/', '').toUpperCase();
    
    // Check if we have cached data for this symbol around this time
    let cachedData: PriceDataPoint[] | undefined;
    for (const [key, data] of this.priceCache.entries()) {
      if (key.startsWith(normalizedSymbol + '_')) {
        // Check if this cache entry covers our time
        const firstPoint = data[0];
        const lastPoint = data[data.length - 1];
        if (firstPoint && lastPoint) {
          const timeMs = time.valueOf();
          if (timeMs >= firstPoint.timestamp && timeMs <= lastPoint.timestamp) {
            cachedData = data;
            break;
          }
        }
      }
    }

    // If no cached data or time is outside cache, fetch new data
    if (!cachedData || cachedData.length === 0) {
      // Fetch data from 1 hour before to 1 hour after the requested time
      const fetchStart = time.subtract(1, 'hour');
      const fetchEnd = time.add(1, 'hour');
      cachedData = await this.fetchPriceData(normalizedSymbol, fetchStart, fetchEnd);
    }

    if (!cachedData || cachedData.length === 0) {
      logger.warn('No price data available', { symbol: normalizedSymbol, time: time.toISOString() });
      return null;
    }

    const targetTimestamp = time.valueOf();
    
    // Find the closest price point to target time
    let closest = cachedData[0];
    for (const point of cachedData) {
      if (point.timestamp <= targetTimestamp) {
        closest = point;
      } else {
        break;
      }
    }

    return closest.price;
  }

  // Pre-fetch price data for a symbol from message time until trade closes (or max duration)
  async prefetchPriceData(
    symbol: string,
    messageTime: dayjs.Dayjs,
    maxDurationDays: number = 7
  ): Promise<void> {
    const normalizedSymbol = symbol.replace('/', '').toUpperCase();
    const endTime = messageTime.add(maxDurationDays, 'day');
    
    logger.info('Pre-fetching price data', {
      symbol: normalizedSymbol,
      startTime: messageTime.toISOString(),
      endTime: endTime.toISOString()
    });

    await this.fetchPriceData(normalizedSymbol, messageTime, endTime);
  }

  // Get price history for a symbol between two times (for analysis)
  async getPriceHistory(
    symbol: string,
    startTime: dayjs.Dayjs,
    endTime: dayjs.Dayjs
  ): Promise<PriceDataPoint[]> {
    return this.fetchPriceData(symbol, startTime, endTime);
  }

  // Check if we have data for a symbol
  hasData(symbol: string): boolean {
    const normalizedSymbol = symbol.replace('/', '').toUpperCase();
    for (const key of this.priceCache.keys()) {
      if (key.startsWith(normalizedSymbol + '_')) {
        return true;
      }
    }
    return false;
  }

  // Get all available symbols from cache
  getAvailableSymbols(): string[] {
    const symbols = new Set<string>();
    for (const key of this.priceCache.keys()) {
      const symbol = key.split('_')[0];
      if (symbol) {
        symbols.add(symbol);
      }
    }
    return Array.from(symbols);
  }
}
