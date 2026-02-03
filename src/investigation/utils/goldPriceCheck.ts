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
    paxgPrice: paxgPrice || null,
    xautPrice: null,
    goldPrice: null
  };

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
        // Fallback to klines if execution history fails
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
            // Find the candle that contains the timestamp
            for (const kline of klines.result.list) {
              const candleTime = parseInt(kline[0]);
              const candleEndTime = candleTime + 60000;
              if (messageTimeMs >= candleTime && messageTimeMs < candleEndTime) {
                result.xautPrice = parseFloat(kline[4]); // Close price
                break;
              }
            }

            // If exact candle not found, use closest one
            if (result.xautPrice === null && klines.result.list.length > 0) {
              const lastCandle = klines.result.list[klines.result.list.length - 1];
              result.xautPrice = parseFloat(lastCandle[4]);
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

