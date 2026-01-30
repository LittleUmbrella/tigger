import dayjs from 'dayjs';
import { logger } from './logger.js';
import { RestClientV5 } from 'bybit-api';
import { RateLimiter, createBybitPublicRateLimiter } from './rateLimiter.js';
import { getCachedResponse, setCachedResponse } from './bybitCache.js';

interface PriceDataPoint {
  timestamp: number;
  price: number; // Close price (for backward compatibility and general price tracking)
  high?: number; // High price of the candle (for TP/SL checks)
  low?: number; // Low price of the candle (for TP/SL checks)
}

interface HistoricalPriceProviderState {
  priceCache: Map<string, PriceDataPoint[]>;
  inFlightRequests: Map<string, Promise<PriceDataPoint[]>>; // Track in-flight requests to prevent duplicate API calls
  currentTime: dayjs.Dayjs;
  speedMultiplier: number;
  startTime: dayjs.Dayjs;
  bybitClient: RestClientV5;
  hasAuth: boolean;
  rateLimiter: RateLimiter;
}

export interface HistoricalPriceProvider {
  advanceTime: (ms: number) => void;
  getCurrentTime: () => dayjs.Dayjs;
  setCurrentTime: (time: dayjs.Dayjs) => void;
  getCurrentPrice: (symbol: string) => Promise<number | null>;
  getPriceAtTime: (symbol: string, time: dayjs.Dayjs) => Promise<number | null>;
  prefetchPriceData: (symbol: string, messageTime: dayjs.Dayjs, maxDurationDays?: number) => Promise<void>;
  getPriceHistory: (symbol: string, startTime: dayjs.Dayjs, endTime: dayjs.Dayjs) => Promise<PriceDataPoint[]>;
  hasData: (symbol: string) => boolean;
  getAvailableSymbols: () => string[];
  getBybitClient: () => RestClientV5 | null;
}

/**
 * Serialize an error object for logging
 * Handles Error instances, API response objects, and plain objects
 * Always returns a structured object for consistent logging
 */
function serializeError(error: any): Record<string, any> {
  // If it's an Error instance, extract message and optionally stack
  if (error instanceof Error) {
    const result: Record<string, any> = {
      message: error.message,
      name: error.name
    };
    if (error.stack) {
      result.stack = error.stack;
    }
    // Include any additional properties that might be on the error
    if (error.cause) {
      result.cause = serializeError(error.cause);
    }
    // Include any custom properties on the error object
    Object.keys(error).forEach(key => {
      if (!['message', 'name', 'stack', 'cause'].includes(key)) {
        try {
          result[key] = (error as Record<string, any>)[key];
        } catch (e) {
          // Skip non-serializable properties
        }
      }
    });
    return result;
  }
  
  // If it's an object with retCode/retMsg (API response format)
  if (error && typeof error === 'object') {
    const result: Record<string, any> = {};
    
    // Extract common API response fields
    if (error.retCode !== undefined) result.retCode = error.retCode;
    if (error.retMsg !== undefined) result.retMsg = error.retMsg;
    if (error.code !== undefined) result.code = error.code;
    if (error.status !== undefined) result.status = error.status;
    if (error.statusText !== undefined) result.statusText = error.statusText;
    if (error.message !== undefined) result.message = error.message;
    
    // Try to include other enumerable properties (but limit depth to avoid huge objects)
    try {
      Object.keys(error).forEach(key => {
        if (!result.hasOwnProperty(key)) {
          const value = error[key];
          // Skip functions and circular references
          if (typeof value === 'function') {
            result[key] = '[Function]';
          } else if (value instanceof Error) {
            result[key] = { message: value.message, name: value.name };
          } else if (typeof value === 'object' && value !== null) {
            // Limit depth - just include a summary for nested objects
            try {
              const str = JSON.stringify(value);
              if (str.length < 200) {
                result[key] = value;
              } else {
                result[key] = `[Object: ${str.substring(0, 100)}...]`;
              }
            } catch (e) {
              result[key] = '[Circular or non-serializable]';
            }
          } else {
            result[key] = value;
          }
        }
      });
    } catch (e) {
      // If we can't enumerate keys, that's okay - we already have the important fields
    }
    
    // Ensure we always have at least a message
    if (!result.message && Object.keys(result).length === 0) {
      try {
        result.message = String(error);
      } catch (e) {
        result.message = '[Unable to serialize error]';
      }
    }
    
    return result;
  }
  
  // Primitive types - wrap in an object
  return {
    message: String(error),
    value: error
  };
}

/**
 * Try fetching data with a specific category, return null if it fails
 */
async function tryFetchWithCategory(
  state: HistoricalPriceProviderState,
  normalizedSymbol: string,
  startTimestamp: number,
  endTimestamp: number,
  category: 'spot' | 'linear'
): Promise<PriceDataPoint[] | null> {
  const pricePoints: PriceDataPoint[] = [];
  
  try {
    if (state.hasAuth) {
      // Try authenticated execution history first (most granular)
      const windowSize = 24 * 60 * 60 * 1000; // 24 hours
      let execStart = startTimestamp;
      const now = Date.now();
      const cappedEndTimestamp = Math.min(endTimestamp, now);
      
      while (execStart < cappedEndTimestamp) {
        const execEnd = Math.min(execStart + windowSize, cappedEndTimestamp);
        
        if (execStart > now || execEnd > now) {
          execStart = execEnd + 1;
          continue;
        }
        
        await state.rateLimiter.waitIfNeeded();
        
        try {
          // Check cache first
          const cacheParams = {
            category,
            symbol: normalizedSymbol,
            startTime: execStart,
            endTime: execEnd,
            limit: 1000
          };
          let executionResponse = await getCachedResponse('getExecutionList', cacheParams);
          
          if (!executionResponse) {
            // Not in cache, make API call
            executionResponse = await state.bybitClient.getExecutionList(cacheParams);
            // Cache successful responses
            if (executionResponse.retCode === 0) {
              await setCachedResponse('getExecutionList', cacheParams, executionResponse);
            }
          }
          
          if (executionResponse.retCode === 0 && executionResponse.result?.list) {
            const validTrades = executionResponse.result.list.filter((execution: any) => {
              const execTime = parseFloat((execution.execTime || execution.exec_time || '0') as string);
              const execPrice = parseFloat((execution.execPrice || execution.exec_price || '0') as string);
              return execPrice > 0 && execTime >= startTimestamp && execTime <= endTimestamp;
            });
            
            for (const execution of validTrades) {
              const execTime = parseFloat((execution.execTime || execution.exec_time || '0') as string);
              const execPrice = parseFloat((execution.execPrice || execution.exec_price || '0') as string);
              pricePoints.push({
                timestamp: execTime,
                price: execPrice
              });
            }
          }
        } catch (error) {
          // Continue to klines if execution history fails
        }
        
        execStart = execEnd + 1;
      }
    }
    
    // If we got execution history data, use it; otherwise try public trade endpoints
    if (pricePoints.length > 0) {
      return pricePoints;
    }
    
    // Try public trade endpoints (more accurate than klines)
    // Note: Public trade endpoints typically only return recent trades (last 1000 trades),
    // not historical data for specific time ranges. For historical backtesting,
    // execution history (if authenticated) is the most accurate source, followed by klines.
    // Public trades are useful for real-time or very recent data.
    let tradeSuccess = false;
    try {
      const now = Date.now();
      const cappedEndTimestamp = Math.min(endTimestamp, now);
      
      // Only try public trades if we're looking for very recent data
      // Public trade endpoints don't support time range queries - they only return recent trades
      const oneDayAgo = now - (24 * 60 * 60 * 1000);
      const isRecentData = startTimestamp >= oneDayAgo && endTimestamp <= now;
      
      if (isRecentData) {
        await state.rateLimiter.waitIfNeeded();
        
        // Note: Public trade endpoints return the most recent trades, not historical data.
        // For historical backtesting, we typically simulate past times, so public trades
        // won't be useful. For real-time/recent data, we could cache, but since the data
        // changes over time, caching without a time component could serve stale data.
        // For now, we don't cache public trades to avoid stale data issues.
        // If needed in the future, we could add a time-based cache key or TTL.
        
        let tradeResponse: any = null;
        
        // Try common method names for public trade endpoints
        const client = state.bybitClient as any;
        if (client.getPublicTradeHistory) {
          tradeResponse = await client.getPublicTradeHistory({
            category,
            symbol: normalizedSymbol,
            limit: 1000
          });
        } else if (client.getMarketTrades) {
          tradeResponse = await client.getMarketTrades({
            category,
            symbol: normalizedSymbol,
            limit: 1000
          });
        } else if (client.getRecentTrades) {
          tradeResponse = await client.getRecentTrades({
            category,
            symbol: normalizedSymbol,
            limit: 1000
          });
        }
        
        if (tradeResponse && tradeResponse.retCode === 0 && tradeResponse.result?.list) {
          const trades = tradeResponse.result.list;
          logger.debug('Public trade API response', {
            symbol: normalizedSymbol,
            category,
            retCode: tradeResponse.retCode,
            retMsg: tradeResponse.retMsg,
            listLength: trades.length
          });
          
          for (const trade of trades) {
            // Trade format: [time, symbol, side, size, price, ...] or {time, price, ...}
            let tradeTime: number;
            let tradePrice: number;
            
            if (Array.isArray(trade)) {
              // Array format: [time, symbol, side, size, price, ...]
              tradeTime = parseFloat(trade[0] || '0');
              tradePrice = parseFloat(trade[4] || trade[3] || '0'); // price might be at index 3 or 4
            } else {
              // Object format: {time, price, ...}
              tradeTime = parseFloat((trade.time || trade.execTime || trade.exec_time || '0') as string);
              tradePrice = parseFloat((trade.price || trade.execPrice || trade.exec_price || '0') as string);
            }
            
            // Filter trades within our time range
            if (tradePrice > 0 && tradeTime >= startTimestamp && tradeTime <= cappedEndTimestamp) {
              pricePoints.push({
                timestamp: tradeTime,
                price: tradePrice
              });
            }
          }
          
          if (pricePoints.length > 0) {
            tradeSuccess = true;
            logger.info('Using public trade data (more accurate than klines)', {
              symbol: normalizedSymbol,
              category,
              dataPoints: pricePoints.length,
              startTime: new Date(startTimestamp).toISOString(),
              endTime: new Date(cappedEndTimestamp).toISOString()
            });
          }
        } else if (tradeResponse && tradeResponse.retCode !== 10001) {
          logger.debug('Public trade API failed, will try klines', {
            symbol: normalizedSymbol,
            category,
            retCode: tradeResponse.retCode,
            retMsg: tradeResponse.retMsg
          });
        }
      }
    } catch (error) {
      logger.debug('Public trade endpoint not available or failed, will try klines', {
        symbol: normalizedSymbol,
        category,
        error: serializeError(error)
      });
    }
    
    // If we got trade data, use it; otherwise fall back to klines
    if (tradeSuccess && pricePoints.length > 0) {
      // Sort by timestamp to ensure chronological order
      pricePoints.sort((a, b) => a.timestamp - b.timestamp);
      return pricePoints;
    }
    
    // Fetch klines as fallback or primary method
    const chunkSize = 200 * 60 * 1000; // 200 minutes (max kline limit)
    let currentStart = startTimestamp;
    let triedTicker = false; // Track if we've tried ticker fallback
    
    while (currentStart < endTimestamp) {
      const currentEnd = Math.min(currentStart + chunkSize, endTimestamp);
      
      await state.rateLimiter.waitIfNeeded();
      
      let klineSuccess = false;
      
      if (category === 'spot') {
        // For spot, use regular kline
        try {
          // Check cache first
          const cacheParams = {
            category: category as 'spot',
            symbol: normalizedSymbol,
            interval: '1' as const,
            start: currentStart,
            end: currentEnd,
            limit: 200
          };
          let klineResponse = await getCachedResponse('getKline', cacheParams);
          
          if (!klineResponse) {
            // Not in cache, make API call
            klineResponse = await state.bybitClient.getKline(cacheParams);
            // Cache successful responses
            if (klineResponse.retCode === 0) {
              await setCachedResponse('getKline', cacheParams, klineResponse);
            }
          }
          
          logger.debug('Spot kline API response', {
            symbol: normalizedSymbol,
            retCode: klineResponse.retCode,
            retMsg: klineResponse.retMsg,
            listLength: klineResponse.result?.list?.length || 0,
            start: new Date(currentStart).toISOString(),
            end: new Date(currentEnd).toISOString()
          });
          
          if (klineResponse.retCode === 0 && klineResponse.result?.list) {
            for (const kline of klineResponse.result.list) {
              const klineTime = parseFloat(kline[0] || '0');
              const klineOpen = parseFloat(kline[1] || '0');
              const klineHigh = parseFloat(kline[2] || '0');
              const klineLow = parseFloat(kline[3] || '0');
              const klineClose = parseFloat(kline[4] || '0');
              
              if (klineTime >= startTimestamp && klineTime <= endTimestamp) {
                const price = klineClose > 0 ? klineClose : klineOpen;
                if (price > 0) {
                  pricePoints.push({
                    timestamp: klineTime,
                    price,
                    high: klineHigh > 0 ? klineHigh : undefined,
                    low: klineLow > 0 ? klineLow : undefined
                  });
                }
              }
            }
            klineSuccess = pricePoints.length > 0;
          } else if (klineResponse.retCode !== 10001) {
            // If it's not a "not found" error, this category doesn't work
            logger.debug('Spot kline failed with non-10001 error', {
              symbol: normalizedSymbol,
              retCode: klineResponse.retCode,
              retMsg: klineResponse.retMsg
            });
            return null;
          }
        } catch (error) {
          logger.debug('Spot kline request threw error', {
            symbol: normalizedSymbol,
            error: serializeError(error)
          });
          const errorCode = (error as any)?.retCode;
          if (errorCode !== undefined && errorCode !== 10001) {
            return null;
          }
        }
      } else {
        // For linear, try multiple methods in order:
        // 1. Regular kline (most accurate for trading)
        // 2. Mark price kline (if available)
        // 3. Index price kline (fallback)
        
        const klineMethods = [
          // Method 1: Regular kline
          {
            name: 'regular kline',
            endpoint: 'getKline',
            call: () => state.bybitClient.getKline({
              category: 'linear',
              symbol: normalizedSymbol,
              interval: '1',
              start: currentStart,
              end: currentEnd,
              limit: 200
            }),
            params: {
              category: 'linear',
              symbol: normalizedSymbol,
              interval: '1',
              start: currentStart,
              end: currentEnd,
              limit: 200
            }
          },
          // Method 2: Mark price kline (if available)
          ...((state.bybitClient as any).getMarkPriceKline ? [{
            name: 'mark price kline',
            endpoint: 'getMarkPriceKline',
            call: () => (state.bybitClient as any).getMarkPriceKline({
              category: 'linear',
              symbol: normalizedSymbol,
              interval: '1',
              start: currentStart,
              end: currentEnd,
              limit: 200
            }),
            params: {
              category: 'linear',
              symbol: normalizedSymbol,
              interval: '1',
              start: currentStart,
              end: currentEnd,
              limit: 200
            }
          }] : []),
          // Method 3: Index price kline (fallback)
          {
            name: 'index price kline',
            endpoint: 'getIndexPriceKline',
            call: () => state.bybitClient.getIndexPriceKline({
              category: 'linear',
              symbol: normalizedSymbol,
              interval: '1',
              start: currentStart,
              end: currentEnd,
              limit: 200
            }),
            params: {
              category: 'linear',
              symbol: normalizedSymbol,
              interval: '1',
              start: currentStart,
              end: currentEnd,
              limit: 200
            }
          }
        ];
        
        for (let methodIndex = 0; methodIndex < klineMethods.length; methodIndex++) {
          const method = klineMethods[methodIndex];
          const methodName = method.name;
          try {
            // Check cache first
            let klineResponse = await getCachedResponse(method.endpoint, method.params);
            
            if (!klineResponse) {
              // Not in cache, make API call
              klineResponse = await method.call();
              // Cache successful responses
              if (klineResponse.retCode === 0) {
                await setCachedResponse(method.endpoint, method.params, klineResponse);
              }
            }
            
            logger.debug('Linear kline API response', {
              symbol: normalizedSymbol,
              method: methodName,
              retCode: klineResponse.retCode,
              retMsg: klineResponse.retMsg,
              listLength: klineResponse.result?.list?.length || 0,
              start: new Date(currentStart).toISOString(),
              end: new Date(currentEnd).toISOString()
            });
            
            if (klineResponse.retCode === 0 && klineResponse.result?.list) {
              for (const kline of klineResponse.result.list) {
                const klineTime = parseFloat(kline[0] || '0');
                const klineOpen = parseFloat(kline[1] || '0');
                const klineHigh = parseFloat(kline[2] || '0');
                const klineLow = parseFloat(kline[3] || '0');
                const klineClose = parseFloat(kline[4] || '0');
                
                if (klineTime >= startTimestamp && klineTime <= endTimestamp) {
                  const price = klineClose > 0 ? klineClose : klineOpen;
                  if (price > 0) {
                    pricePoints.push({
                      timestamp: klineTime,
                      price,
                      high: klineHigh > 0 ? klineHigh : undefined,
                      low: klineLow > 0 ? klineLow : undefined
                    });
                  }
                }
              }
              klineSuccess = pricePoints.length > 0;
              if (klineSuccess) {
                logger.debug('Linear kline method succeeded', {
                  symbol: normalizedSymbol,
                  method: methodName,
                  dataPoints: pricePoints.length
                });
                break; // Success, stop trying other methods
              }
            } else if (klineResponse.retCode !== 10001) {
              // If it's not a "not found" error, try next method
              logger.debug('Linear kline method failed, trying next', {
                symbol: normalizedSymbol,
                method: methodName,
                retCode: klineResponse.retCode,
                retMsg: klineResponse.retMsg
              });
              continue;
            }
          } catch (error) {
            logger.debug('Linear kline method threw error, trying next', {
              symbol: normalizedSymbol,
              method: methodName,
              error: serializeError(error)
            });
            // Try next method on error
            continue;
          }
        }
      }
      
      // If all kline methods failed and we have no data, try ticker for last price (only once)
      if (!klineSuccess && pricePoints.length === 0 && !triedTicker && currentStart === startTimestamp) {
        triedTicker = true;
        try {
          await state.rateLimiter.waitIfNeeded();
          
          // Check cache first
          const tickerParams = {
            category,
            symbol: normalizedSymbol
          };
          let tickerResponse = await getCachedResponse('getTickers', tickerParams);
          
          if (!tickerResponse) {
            // Not in cache, make API call
            // Handle different ticker API signatures for spot vs linear
            tickerResponse = category === 'spot'
              ? await state.bybitClient.getTickers({
                  category: 'spot',
                  symbol: normalizedSymbol
                } as any)
              : await state.bybitClient.getTickers({
                  category: 'linear',
                  symbol: normalizedSymbol
                } as any);
            // Cache successful responses
            if (tickerResponse.retCode === 0) {
              await setCachedResponse('getTickers', tickerParams, tickerResponse);
            }
          }
          
          const resultList = (tickerResponse.result as any)?.list;
          
          logger.debug('Ticker API response', {
            symbol: normalizedSymbol,
            category,
            retCode: tickerResponse.retCode,
            retMsg: tickerResponse.retMsg,
            listLength: resultList?.length || 0
          });
          
          if (tickerResponse.retCode === 0 && resultList && resultList.length > 0) {
            const ticker = resultList[0];
            const lastPrice = parseFloat(ticker.lastPrice || '0');
            // For spot tickers, updateTime might not be present, so use the requested start time
            const tickerUpdateTime = parseFloat(ticker.updateTime || '0');
            const useTimestamp = tickerUpdateTime > 0 ? tickerUpdateTime : startTimestamp;
            
            logger.debug('Ticker data', {
              symbol: normalizedSymbol,
              category,
              lastPrice,
              tickerUpdateTime: tickerUpdateTime > 0 ? new Date(tickerUpdateTime).toISOString() : 'not provided',
              useTimestamp: new Date(useTimestamp).toISOString(),
              ticker: JSON.stringify(ticker)
            });
            
            if (lastPrice > 0) {
              // Use ticker price as a single data point with the requested start time
              // (or ticker's updateTime if available)
              pricePoints.push({
                timestamp: useTimestamp,
                price: lastPrice
              });
              logger.info('Using ticker last price as fallback', {
                symbol: normalizedSymbol,
                category,
                price: lastPrice,
                timestamp: new Date(useTimestamp).toISOString(),
                source: tickerUpdateTime > 0 ? 'ticker updateTime' : 'requested startTime'
              });
            } else {
              logger.warn('Ticker returned invalid price', {
                symbol: normalizedSymbol,
                category,
                lastPrice,
                ticker: JSON.stringify(ticker)
              });
            }
          } else {
            logger.warn('Ticker API returned no data', {
              symbol: normalizedSymbol,
              category,
              retCode: tickerResponse.retCode,
              retMsg: tickerResponse.retMsg
            });
          }
        } catch (error) {
          logger.warn('Ticker API request failed', {
            symbol: normalizedSymbol,
            category,
            error: serializeError(error)
          });
        }
      }
      
      currentStart = currentEnd + 1;
    }
    
    return pricePoints.length > 0 ? pricePoints : null;
  } catch (error) {
    return null;
  }
}

// Fetch historical price data for a symbol starting from a specific time
async function fetchPriceData(
  state: HistoricalPriceProviderState,
  symbol: string,
  startTime: dayjs.Dayjs,
  endTime: dayjs.Dayjs
): Promise<PriceDataPoint[]> {
  const normalizedSymbol = symbol.replace('/', '').toUpperCase();
  const cacheKey = `${normalizedSymbol}_${startTime.valueOf()}_${endTime.valueOf()}`;
  
  // Check cache first
  if (state.priceCache.has(cacheKey)) {
    return state.priceCache.get(cacheKey)!;
  }
  
  // Check if there's already an in-flight request for this data
  // This prevents duplicate API calls when multiple parallel requests come in
  if (state.inFlightRequests.has(cacheKey)) {
    logger.debug('Waiting for in-flight request', {
      symbol: normalizedSymbol,
      cacheKey: cacheKey.substring(0, 50)
    });
    return await state.inFlightRequests.get(cacheKey)!;
  }
  
  // Create the fetch promise and store it
  const fetchPromise = (async () => {
    try {
      // Try both spot and linear categories
      const categories: Array<'spot' | 'linear'> = ['spot', 'linear'];
      let pricePoints: PriceDataPoint[] = [];
      const categoryResults: Record<string, { success: boolean; dataPoints: number; error?: any }> = {};
      
      for (const category of categories) {
        const result = await tryFetchWithCategory(
          state,
          normalizedSymbol,
          startTime.valueOf(),
          endTime.valueOf(),
          category
        );
        
        if (result && result.length > 0) {
          pricePoints = result;
          categoryResults[category] = { success: true, dataPoints: pricePoints.length };
          logger.info('Fetched price data using category', {
            symbol: normalizedSymbol,
            category,
            dataPoints: pricePoints.length,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString()
          });
          break;
        } else {
          categoryResults[category] = { 
            success: false, 
            dataPoints: result?.length || 0,
            error: result === null ? 'API returned null' : 'Empty result list'
          };
          logger.debug('Category attempt returned no data, will try next category', {
            symbol: normalizedSymbol,
            category,
            result: result === null ? 'null' : `empty list (${result?.length || 0} items)`,
            nextCategory: category === 'spot' ? 'linear' : 'none'
          });
        }
      }
      
      if (pricePoints.length === 0) {
        // Log detailed information about what was tried
        const triedCategories = Object.keys(categoryResults);
        logger.warn('No price data found for symbol in any category', {
          symbol: normalizedSymbol,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          triedCategories,
          categoryResults,
          note: triedCategories.length < 2 ? 'Not all categories were attempted - this may indicate an early return' : 'All categories attempted'
        });
        state.priceCache.set(cacheKey, []);
        return [];
      }
      
      // Sort by timestamp
      pricePoints.sort((a, b) => a.timestamp - b.timestamp);
      
      // Cache the results
      state.priceCache.set(cacheKey, pricePoints);
      
      logger.info('Fetched historical price data', {
        symbol: normalizedSymbol,
        dataPoints: pricePoints.length,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString()
      });
      
      return pricePoints;
    } finally {
      // Remove from in-flight requests when done (success or failure)
      state.inFlightRequests.delete(cacheKey);
    }
  })();
  
  // Store the promise so other concurrent requests can wait for it
  state.inFlightRequests.set(cacheKey, fetchPromise);
  
  return await fetchPromise;
}

export function createHistoricalPriceProvider(
  startDate: string,
  speedMultiplier: number = 1.0,
  bybitApiKey?: string,
  bybitApiSecret?: string,
  sharedRateLimiter?: RateLimiter
): HistoricalPriceProvider {
  const hasAuth = !!(bybitApiKey && bybitApiSecret);
  const bybitClient = new RestClientV5({ key: bybitApiKey || '', secret: bybitApiSecret || '', testnet: false });
  
  // Use shared rate limiter if provided (for parallel requests), otherwise create new one
  const rateLimiter = sharedRateLimiter || createBybitPublicRateLimiter();
  
  const state: HistoricalPriceProviderState = {
    priceCache: new Map(),
    inFlightRequests: new Map(),
    currentTime: dayjs(startDate),
    speedMultiplier,
    startTime: dayjs(startDate),
    bybitClient,
    hasAuth,
    rateLimiter,
  };

  logger.info('Historical price provider initialized', {
    startDate,
    speedMultiplier,
    authenticated: hasAuth
  });

  return {
    advanceTime: (ms: number) => {
      state.currentTime = state.currentTime.add(ms * state.speedMultiplier, 'millisecond');
    },
    
    getCurrentTime: () => state.currentTime,
    
    setCurrentTime: (time: dayjs.Dayjs) => {
      state.currentTime = time;
    },
    
    getCurrentPrice: async (symbol: string): Promise<number | null> => {
      const normalizedSymbol = symbol.replace('/', '').toUpperCase();
      
      // Check if we have cached data for this symbol around this time
      let cachedData: PriceDataPoint[] | undefined;
      for (const [key, data] of state.priceCache.entries()) {
        if (key.startsWith(normalizedSymbol + '_')) {
          // Check if this cache entry covers our time
          const firstPoint = data[0];
          const lastPoint = data[data.length - 1];
          if (firstPoint && lastPoint) {
            const timeMs = state.currentTime.valueOf();
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
        const fetchStart = state.currentTime.subtract(1, 'hour');
        const fetchEnd = state.currentTime.add(1, 'hour');
        cachedData = await fetchPriceData(state, normalizedSymbol, fetchStart, fetchEnd);
      }

      if (!cachedData || cachedData.length === 0) {
        logger.warn('No price data available', { symbol: normalizedSymbol, time: state.currentTime.toISOString() });
        return null;
      }

      const targetTimestamp = state.currentTime.valueOf();
      
      // Find the closest price point to target time
      // Prefer points <= targetTimestamp (before or at target time)
      // If no points before target, use the closest point after
      let closestBefore: PriceDataPoint | null = null;
      let closestAfter: PriceDataPoint | null = null;
      let minDiffBefore = Infinity;
      let minDiffAfter = Infinity;
      
      for (const point of cachedData) {
        const diff = targetTimestamp - point.timestamp;
        if (diff >= 0) {
          // Point is before or at target time
          if (diff < minDiffBefore) {
            closestBefore = point;
            minDiffBefore = diff;
          }
        } else {
          // Point is after target time
          const absDiff = Math.abs(diff);
          if (absDiff < minDiffAfter) {
            closestAfter = point;
            minDiffAfter = absDiff;
          }
        }
      }
      
      // Prefer closest point before target time, fallback to closest after
      const closest = closestBefore || closestAfter || cachedData[0];
      const selectedTimeDiff = closest ? Math.abs(closest.timestamp - targetTimestamp) : Infinity;
      
      // Log warning if selected price is far from target time (more than 1 minute)
      if (selectedTimeDiff > 60000) {
        logger.warn('Selected price point is far from target time', {
          symbol: normalizedSymbol,
          targetTime: state.currentTime.toISOString(),
          selectedTime: closest ? new Date(closest.timestamp).toISOString() : 'none',
          timeDiffSeconds: Math.round(selectedTimeDiff / 1000),
          selectedPrice: closest?.price,
          usedBeforeTarget: closestBefore !== null,
          usedAfterTarget: closestAfter !== null && closestBefore === null,
          dataPointsAvailable: cachedData.length,
          firstDataPoint: cachedData[0] ? new Date(cachedData[0].timestamp).toISOString() : 'none',
          lastDataPoint: cachedData[cachedData.length - 1] ? new Date(cachedData[cachedData.length - 1].timestamp).toISOString() : 'none'
        });
      }
      
      return closest?.price || null;
    },
    
    getPriceAtTime: async (symbol: string, time: dayjs.Dayjs): Promise<number | null> => {
      const normalizedSymbol = symbol.replace('/', '').toUpperCase();
      
      // Check if we have cached data for this symbol around this time
      let cachedData: PriceDataPoint[] | undefined;
      for (const [key, data] of state.priceCache.entries()) {
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
        cachedData = await fetchPriceData(state, normalizedSymbol, fetchStart, fetchEnd);
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
    },
    
    prefetchPriceData: async (symbol: string, messageTime: dayjs.Dayjs, maxDurationDays: number = 7): Promise<void> => {
      const normalizedSymbol = symbol.replace('/', '').toUpperCase();
      const endTime = messageTime.add(maxDurationDays, 'day');
      
      logger.info('Pre-fetching price data', {
        symbol: normalizedSymbol,
        startTime: messageTime.toISOString(),
        endTime: endTime.toISOString()
      });

      await fetchPriceData(state, normalizedSymbol, messageTime, endTime);
    },
    
    getPriceHistory: async (symbol: string, startTime: dayjs.Dayjs, endTime: dayjs.Dayjs): Promise<PriceDataPoint[]> => {
      return fetchPriceData(state, symbol, startTime, endTime);
    },
    
    hasData: (symbol: string): boolean => {
      const normalizedSymbol = symbol.replace('/', '').toUpperCase();
      for (const key of state.priceCache.keys()) {
        if (key.startsWith(normalizedSymbol + '_')) {
          return true;
        }
      }
      return false;
    },
    
    getAvailableSymbols: (): string[] => {
      const symbols = new Set<string>();
      for (const key of state.priceCache.keys()) {
        const symbol = key.split('_')[0];
        if (symbol) {
          symbols.add(symbol);
        }
      }
      return Array.from(symbols);
    },
    
    getBybitClient: (): RestClientV5 | null => {
      return state.bybitClient || null;
    },
  };
}
