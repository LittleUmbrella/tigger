/**
 * Utility to check gold and XAUT prices for PAXG trades
 */

import { RestClientV5 } from 'bybit-api';
import { getGoldPriceAtTime } from '../../utils/goldPriceApi.js';
import { logger } from '../../utils/logger.js';

export interface GoldPriceComparison {
  timestamp: string;
  paxgPrice: number | null;
  xautPrice: number | null;
  goldPrice: number | null;
  goldSource?: string;
  comparison?: {
    paxgVsGold?: { difference: number; percent: number };
    xautVsGold?: { difference: number; percent: number };
    paxgVsXaut?: { difference: number; percent: number };
  };
  error?: string;
}

/**
 * Fetch gold and XAUT prices at a specific timestamp for comparison with PAXG
 */
export async function getGoldPriceComparison(
  bybitClient: RestClientV5 | undefined,
  timestamp: Date,
  paxgPrice?: number
): Promise<GoldPriceComparison> {
  const result: GoldPriceComparison = {
    timestamp: timestamp.toISOString(),
    paxgPrice: null, // Will fetch actual market price
    xautPrice: null,
    goldPrice: null
  };
  
  // Fetch actual PAXG market price at timestamp if client is available
  if (bybitClient) {
    try {
      const messageTimeMs = timestamp.getTime();
      const endTime = Math.floor(messageTimeMs / 1000);
      const startTime = endTime - 600; // 10 minutes before

      // Try to get PAXG execution history first (most accurate)
      try {
        const executionResponse = await bybitClient.getExecutionList({
          category: 'linear',
          symbol: 'PAXGUSDT',
          startTime: startTime * 1000,
          endTime: messageTimeMs + 60000,
          limit: 1000
        });

        if (executionResponse.retCode === 0 && executionResponse.result?.list && executionResponse.result.list.length > 0) {
          logger.debug('PAXG execution history fetched', {
            count: executionResponse.result.list.length,
            timestamp: timestamp.toISOString()
          });
          
          // Find the execution closest to the timestamp
          let closestExec: any = null;
          let minTimeDiff = Infinity;

          for (const exec of executionResponse.result.list) {
            const execTime = parseFloat((exec.execTime || '0') as string);
            const timeDiff = Math.abs(execTime - messageTimeMs);
            if (timeDiff < minTimeDiff) {
              minTimeDiff = timeDiff;
              closestExec = exec;
            }
          }

          if (closestExec) {
            result.paxgPrice = parseFloat((closestExec.execPrice || '0') as string);
            logger.debug('PAXG price from execution history', {
              price: result.paxgPrice,
              execTime: closestExec.execTime,
              timeDiff: minTimeDiff
            });
          }
        } else {
          logger.debug('PAXG execution history empty or failed, will try klines', {
            retCode: executionResponse.retCode,
            retMsg: executionResponse.retMsg,
            listLength: executionResponse.result?.list?.length || 0
          });
        }
      } catch (error) {
        logger.debug('PAXG execution history failed, will try klines', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      
      // Always try klines if execution history didn't provide a price
      if (result.paxgPrice === null) {
        try {
          const klines = await bybitClient.getKline({
            category: 'linear',
            symbol: 'PAXGUSDT',
            interval: '1',
            start: startTime * 1000,
            end: messageTimeMs + 60000,
            limit: 20
          });

          if (klines.retCode === 0 && klines.result?.list) {
            logger.debug('PAXG klines fetched', {
              count: klines.result.list.length,
              timestamp: timestamp.toISOString()
            });
            
            // Find the candle that contains the timestamp
            for (const kline of klines.result.list) {
              const candleTime = parseInt(kline[0]);
              const candleEndTime = candleTime + 60000;
              if (messageTimeMs >= candleTime && messageTimeMs < candleEndTime) {
                result.paxgPrice = parseFloat(kline[4]); // Close price
                logger.debug('PAXG price from kline', {
                  price: result.paxgPrice,
                  candleTime: new Date(candleTime).toISOString()
                });
                break;
              }
            }

            // If exact candle not found, use closest one
            if (result.paxgPrice === null && klines.result.list.length > 0) {
              const lastCandle = klines.result.list[klines.result.list.length - 1];
              result.paxgPrice = parseFloat(lastCandle[4]);
              logger.debug('PAXG price from closest kline', {
                price: result.paxgPrice,
                candleTime: new Date(parseInt(lastCandle[0])).toISOString()
              });
            }
          }
        } catch (klineError) {
          logger.warn('Failed to fetch PAXG price from klines', {
            timestamp: timestamp.toISOString(),
            error: klineError instanceof Error ? klineError.message : String(klineError)
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to fetch PAXG price', {
        timestamp: timestamp.toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  // Fallback to provided paxgPrice if we couldn't fetch market price
  if (result.paxgPrice === null && paxgPrice) {
    logger.debug('Using provided PAXG price as fallback', { paxgPrice });
    result.paxgPrice = paxgPrice;
  }

  try {
    // Fetch gold price from external APIs
    const goldPriceData = await getGoldPriceAtTime(timestamp);
    if (goldPriceData) {
      result.goldPrice = goldPriceData.price;
      result.goldSource = goldPriceData.source;
    }
  } catch (error) {
    logger.warn('Failed to fetch gold price', {
      timestamp: timestamp.toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
    result.error = `Gold price fetch failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Fetch XAUT price from Bybit if client is available
  if (bybitClient) {
    try {
      const messageTimeMs = timestamp.getTime();
      const endTime = Math.floor(messageTimeMs / 1000);
      const startTime = endTime - 600; // 10 minutes before

      // Try to get XAUT execution history first (most accurate)
      try {
        const executionResponse = await bybitClient.getExecutionList({
          category: 'linear',
          symbol: 'XAUTUSDT',
          startTime: startTime * 1000,
          endTime: messageTimeMs + 60000,
          limit: 1000
        });

        if (executionResponse.retCode === 0 && executionResponse.result?.list) {
          // Find the execution closest to the timestamp
          let closestExec: any = null;
          let minTimeDiff = Infinity;

          for (const exec of executionResponse.result.list) {
            const execTime = parseFloat((exec.execTime || '0') as string);
            const timeDiff = Math.abs(execTime - messageTimeMs);
            if (timeDiff < minTimeDiff) {
              minTimeDiff = timeDiff;
              closestExec = exec;
            }
          }

          if (closestExec) {
            result.xautPrice = parseFloat((closestExec.execPrice || '0') as string);
          }
        }
      } catch (error) {
        logger.debug('XAUT execution history failed, trying klines', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      
      // Always try klines as fallback (execution history might be empty for demo accounts)
      if (result.xautPrice === null) {
        try {
          const klines = await bybitClient.getKline({
            category: 'linear',
            symbol: 'XAUTUSDT',
            interval: '1',
            start: startTime * 1000,
            end: messageTimeMs + 60000,
            limit: 20
          });

          if (klines.retCode === 0 && klines.result?.list) {
            logger.debug('XAUT klines fetched', {
              count: klines.result.list.length,
              timestamp: timestamp.toISOString()
            });
            
            // Find the candle that contains the timestamp
            for (const kline of klines.result.list) {
              const candleTime = parseInt(kline[0]);
              const candleEndTime = candleTime + 60000;
              if (messageTimeMs >= candleTime && messageTimeMs < candleEndTime) {
                result.xautPrice = parseFloat(kline[4]); // Close price
                logger.debug('XAUT price from kline', {
                  price: result.xautPrice,
                  candleTime: new Date(candleTime).toISOString()
                });
                break;
              }
            }

            // If exact candle not found, use closest one
            if (result.xautPrice === null && klines.result.list.length > 0) {
              const lastCandle = klines.result.list[klines.result.list.length - 1];
              result.xautPrice = parseFloat(lastCandle[4]);
              logger.debug('XAUT price from closest kline', {
                price: result.xautPrice,
                candleTime: new Date(parseInt(lastCandle[0])).toISOString()
              });
            }
          }
        } catch (klineError) {
          logger.warn('Failed to fetch XAUT price from klines', {
            timestamp: timestamp.toISOString(),
            error: klineError instanceof Error ? klineError.message : String(klineError)
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to fetch XAUT price', {
        timestamp: timestamp.toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Calculate comparisons if we have the data
  result.comparison = {};
  
  if (result.paxgPrice && result.goldPrice) {
    const diff = result.paxgPrice - result.goldPrice;
    const percent = (diff / result.goldPrice) * 100;
    result.comparison.paxgVsGold = { difference: diff, percent };
  }

  if (result.xautPrice && result.goldPrice) {
    const diff = result.xautPrice - result.goldPrice;
    const percent = (diff / result.goldPrice) * 100;
    result.comparison.xautVsGold = { difference: diff, percent };
  }

  if (result.paxgPrice && result.xautPrice) {
    const diff = result.paxgPrice - result.xautPrice;
    const percent = (diff / result.xautPrice) * 100;
    result.comparison.paxgVsXaut = { difference: diff, percent };
  }

  return result;
}

