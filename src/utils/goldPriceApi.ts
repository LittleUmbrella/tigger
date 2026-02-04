/**
 * Gold Price API Utility
 * 
 * Fetches historical gold (XAU/USD) prices from free APIs
 * Uses multiple fallback sources for reliability
 */

import { logger } from './logger.js';

export interface GoldPriceData {
  price: number;
  timestamp: string;
  source: string;
  currency: string; // Usually 'USD'
  unit: string; // Usually 'per troy ounce'
}

// API Response Types
interface FixerIOResponse {
  rates?: {
    XAU?: string | number;
  };
}

interface FrankfurterResponse {
  rates?: {
    USD?: string | number;
  };
  date?: string;
}

interface GoldAPIResponse {
  price?: string | number;
  value?: string | number;
  rate?: string | number;
  date?: string;
  timestamp?: string;
  data?: {
    price?: string | number;
  };
}

interface GoldAPIIOResponse {
  price?: string | number;
  timestamp?: string;
  currency?: string;
}

interface AlphaVantageResponse {
  data?: Array<{
    date?: string;
    value?: string | number;
  }>;
}

interface ExchangeRateAPIResponse {
  rates?: {
    USD?: string | number;
  };
}

/**
 * Fetch gold price from Fixer.io (free tier available)
 * Or use a simple public endpoint
 */
async function fetchFromFixerIO(): Promise<GoldPriceData | null> {
  const apiKey = process.env.FIXER_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    // Fixer.io has gold prices in their API
    const url = `http://data.fixer.io/api/latest?access_key=${apiKey}&symbols=XAU`;
    const response = await fetch(url);
    
    if (response.ok) {
      const data = await response.json() as FixerIOResponse;
      if (data.rates && data.rates.XAU) {
        // XAU rate is typically per gram, convert to per ounce (31.1035 grams per troy ounce)
        const pricePerGram = parseFloat(String(data.rates.XAU));
        const pricePerOunce = pricePerGram * 31.1035;
        
        if (pricePerOunce > 0) {
          return {
            price: pricePerOunce,
            timestamp: new Date().toISOString(),
            source: 'fixer.io (current)',
            currency: 'USD',
            unit: 'per troy ounce'
          };
        }
      }
    }
  } catch (error) {
    logger.debug('Fixer.io request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return null;
}

/**
 * Fetch gold price from Frankfurter API (free, no key required)
 * Provides historical exchange rates including XAU (gold)
 */
async function fetchFromFrankfurter(timestamp: Date): Promise<GoldPriceData | null> {
  try {
    const dateStr = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
    const url = `https://api.frankfurter.app/${dateStr}?from=XAU&to=USD`;
    
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json() as FrankfurterResponse;
      // Frankfurter returns: { "rates": { "USD": 4710.50 }, "base": "XAU", "date": "2026-02-02" }
      if (data.rates && data.rates.USD) {
        const price = parseFloat(String(data.rates.USD));
        if (price > 0) {
          return {
            price,
            timestamp: data.date || timestamp.toISOString(),
            source: 'frankfurter.app',
            currency: 'USD',
            unit: 'per troy ounce'
          };
        }
      }
    } else if (response.status === 404) {
      // Date not found, try previous day
      const prevDay = new Date(timestamp);
      prevDay.setDate(prevDay.getDate() - 1);
      const prevDateStr = prevDay.toISOString().split('T')[0];
      const prevUrl = `https://api.frankfurter.app/${prevDateStr}?from=XAU&to=USD`;
      
      const prevResponse = await fetch(prevUrl);
      if (prevResponse.ok) {
        const data = await prevResponse.json() as FrankfurterResponse;
        if (data.rates && data.rates.USD) {
          const price = parseFloat(String(data.rates.USD));
          if (price > 0) {
            logger.warn('Using previous day gold price as exact date not available', {
              requestedDate: dateStr,
              usedDate: prevDateStr,
              price
            });
            return {
              price,
              timestamp: data.date || prevDateStr,
              source: 'frankfurter.app (previous day)',
              currency: 'USD',
              unit: 'per troy ounce'
            };
          }
        }
      }
    }
  } catch (error) {
    logger.debug('Frankfurter API request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return null;
}

/**
 * Fetch gold price from Gold API (gold-api.com) - free, no key required
 * This is different from GoldAPI.io
 */
async function fetchFromGoldAPI(timestamp: Date): Promise<GoldPriceData | null> {
  try {
    const dateStr = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
    // Gold API (gold-api.com) - free, no authentication
    const url = `https://api.gold-api.com/price/gold/${dateStr}`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json() as GoldAPIResponse;
      // Check various possible response formats
      let price: number | null = null;
      
      if (data.price) {
        price = parseFloat(String(data.price));
      } else if (data.value) {
        price = parseFloat(String(data.value));
      } else if (data.rate) {
        price = parseFloat(String(data.rate));
      } else if (data.data && data.data.price) {
        price = parseFloat(String(data.data.price));
      }
      
      if (price && price > 0) {
        return {
          price,
          timestamp: data.date || data.timestamp || timestamp.toISOString(),
          source: 'gold-api.com',
          currency: 'USD',
          unit: 'per troy ounce'
        };
      }
    }
  } catch (error) {
    logger.debug('Gold API (gold-api.com) request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return null;
}

/**
 * Fetch gold price from GoldAPI.io (goldapi.io) - requires API key
 * Note: Different service from gold-api.com
 */
async function fetchFromGoldAPIIO(timestamp: Date): Promise<GoldPriceData | null> {
  const apiKey = process.env.GOLDAPI_KEY;
  if (!apiKey) {
    return null; // Skip if no API key
  }

  try {
    const dateStr = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD
    const url = `https://www.goldapi.io/api/XAU/USD/${dateStr}`;
    
    const response = await fetch(url, {
      headers: {
        'x-access-token': apiKey,
        'Accept': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json() as GoldAPIIOResponse & { prev_close_price?: number | string };
      // GoldAPI.io returns: { "price": 4710.50, "currency": "USD", "unit": "per_ounce", ... }
      // Sometimes price is null but prev_close_price is available
      let priceValue = data.price;
      if (!priceValue && data.prev_close_price) {
        priceValue = data.prev_close_price;
      }
      
      if (priceValue) {
        const price = parseFloat(String(priceValue));
        if (price > 0) {
          return {
            price,
            timestamp: data.timestamp || timestamp.toISOString(),
            source: 'goldapi.io',
            currency: data.currency || 'USD',
            unit: 'per troy ounce'
          };
        }
      }
    }
  } catch (error) {
    logger.debug('GoldAPI.io request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return null;
}

/**
 * Fetch gold price from Alpha Vantage (free tier)
 * Requires API key but has free tier: 5 API calls per minute, 500 per day
 */
async function fetchFromAlphaVantage(timestamp: Date): Promise<GoldPriceData | null> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    return null; // Skip if no API key
  }

  try {
    // Alpha Vantage Commodities API
    // For gold: function=GOLD&interval=daily
    const dateStr = timestamp.toISOString().split('T')[0];
    const url = `https://www.alphavantage.co/query?function=GOLD&interval=daily&apikey=${apiKey}`;
    
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json() as AlphaVantageResponse;
      
      // Alpha Vantage returns data in format:
      // { "data": [{"date": "2026-02-02", "value": "4710.50"}, ...] }
      if (data.data && Array.isArray(data.data)) {
        // Find closest date to requested timestamp
        const requestedDate = dateStr;
        let closestEntry = data.data.find((entry) => entry.date === requestedDate);
        
        // If exact date not found, get most recent
        if (!closestEntry && data.data.length > 0) {
          closestEntry = data.data[0]; // Most recent
        }
        
        if (closestEntry && closestEntry.value) {
          const price = parseFloat(String(closestEntry.value));
          if (price > 0) {
            return {
              price,
              timestamp: closestEntry.date || timestamp.toISOString(),
              source: 'alpha-vantage',
              currency: 'USD',
              unit: 'per troy ounce'
            };
          }
        }
      }
    }
  } catch (error) {
    logger.debug('Alpha Vantage request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return null;
}

/**
 * Fetch gold price from ExchangeRate-API (free tier, no key required)
 * This is a fallback that provides current prices
 */
async function fetchFromExchangeRateAPI(): Promise<GoldPriceData | null> {
  try {
    // ExchangeRate-API has gold prices
    const url = 'https://api.exchangerate-api.com/v4/latest/XAU';
    
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json() as ExchangeRateAPIResponse;
      // XAU base means rates are in other currencies
      // For USD: data.rates.USD gives price per ounce
      if (data.rates && data.rates.USD) {
        const price = parseFloat(String(data.rates.USD));
        if (price > 0) {
          return {
            price,
            timestamp: new Date().toISOString(),
            source: 'exchangerate-api.com (current)',
            currency: 'USD',
            unit: 'per troy ounce'
          };
        }
      }
    }
  } catch (error) {
    logger.debug('ExchangeRate-API request failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return null;
}

/**
 * Get historical gold price at a specific timestamp
 * Tries multiple free APIs
 * Returns null if no external API can provide the data
 */
export async function getGoldPriceAtTime(timestamp: Date): Promise<GoldPriceData | null> {
  logger.info('Fetching gold price', {
    timestamp: timestamp.toISOString()
  });

  // Try Gold API (gold-api.com) first - free, no key required
  const goldApiResult = await fetchFromGoldAPI(timestamp);
  if (goldApiResult) {
    return goldApiResult;
  }

  // Try Frankfurter API (free, no key required, has historical data)
  const frankfurterResult = await fetchFromFrankfurter(timestamp);
  if (frankfurterResult) {
    return frankfurterResult;
  }

  // Try GoldAPI.io if API key is available (different service)
  let goldAPIIOResult = await fetchFromGoldAPIIO(timestamp);
  if (goldAPIIOResult) {
    return goldAPIIOResult;
  }

  // If no data for requested date, try previous day as fallback (for early morning trades)
  // This handles cases where the trade happened before market data is available for that day
  const previousDay = new Date(timestamp);
  previousDay.setDate(previousDay.getDate() - 1);
  
  // Only try previous day if requested date is today or very recent (within 2 days)
  const daysDiff = Math.floor((Date.now() - timestamp.getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff <= 2) {
    logger.debug('Trying previous day for gold price', {
      requestedDate: timestamp.toISOString().split('T')[0],
      previousDate: previousDay.toISOString().split('T')[0]
    });
    
    goldAPIIOResult = await fetchFromGoldAPIIO(previousDay);
    if (goldAPIIOResult) {
      logger.info('Using previous day gold price as fallback', {
        requestedDate: timestamp.toISOString().split('T')[0],
        previousDate: previousDay.toISOString().split('T')[0],
        price: goldAPIIOResult.price
      });
      return goldAPIIOResult;
    }
  }

  // Try Alpha Vantage if API key is available
  const alphaResult = await fetchFromAlphaVantage(timestamp);
  if (alphaResult) {
    return alphaResult;
  }

  // Try Fixer.io if API key is available (current price only)
  const fixerResult = await fetchFromFixerIO();
  if (fixerResult) {
    logger.warn('Using current gold price as historical data not available', {
      requestedTimestamp: timestamp.toISOString(),
      currentPrice: fixerResult.price
    });
    return fixerResult;
  }

  // Fallback to ExchangeRate-API (current price only)
  const exchangeResult = await fetchFromExchangeRateAPI();
  if (exchangeResult) {
    logger.warn('Using current gold price as historical data not available', {
      requestedTimestamp: timestamp.toISOString(),
      currentPrice: exchangeResult.price
    });
    return exchangeResult;
  }

  logger.warn('Could not fetch gold price from any external source');
  return null;
}

/**
 * Get current gold price (for comparison)
 */
export async function getCurrentGoldPrice(): Promise<GoldPriceData | null> {
  return getGoldPriceAtTime(new Date());
}

