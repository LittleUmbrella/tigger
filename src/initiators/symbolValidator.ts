/**
 * Symbol Validator
 * 
 * Utilities for validating trading symbols before creating trades.
 */

import { RestClientV5 } from 'bybit-api';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { logger } from '../utils/logger.js';
import { getDecimalPrecision } from '../utils/positionSizing.js';
import { getAssetVariant } from '../utils/assetNormalizer.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import { getCachedResponse, setCachedResponse } from '../utils/bybitCache.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';

export interface SymbolInfo {
  qtyPrecision?: number;
  pricePrecision?: number;
  minOrderQty?: number;
  maxOrderQty?: number;
  qtyStep?: number;
  tickSize?: number;
}

/**
 * Get symbol information from cTrader for quantity/precision (evaluation mode)
 */
/**
 * Validate if a symbol exists on cTrader (for investigation)
 */
export async function validateCTraderSymbol(
  ctraderClient: { getSymbolInfo: (symbol: string) => Promise<any> },
  symbol: string
): Promise<{ valid: boolean; error?: string; actualSymbol?: string }> {
  try {
    const normalized = symbol.replace('/', '').toUpperCase();
    const toTry = normalized.endsWith('USDT') || normalized.endsWith('USDC')
      ? `${normalized.replace(/USDT$|USDC$/, '')}USD`
      : normalized;
    const info = await ctraderClient.getSymbolInfo(toTry);
    if (info) {
      const name = info.symbolName ?? info.symbol ?? toTry;
      return { valid: true, actualSymbol: name };
    }
    return { valid: false, error: `Symbol ${toTry} not found on cTrader` };
  } catch (error) {
    const msg = serializeErrorForLog(error);
    return { valid: false, error: msg.includes('not found') ? `Symbol ${symbol} not found on cTrader` : msg };
  }
}

export async function getCTraderSymbolInfo(
  ctraderClient: { getSymbolInfo: (symbol: string) => Promise<any> },
  symbol: string
): Promise<SymbolInfo | null> {
  try {
    const raw = await ctraderClient.getSymbolInfo(symbol);
    if (!raw) return null;

    const { protobufLongToNumber } = await import('../utils/protobufLong.js');
    const digits = raw.digits ?? 5;
    const lotSize = protobufLongToNumber(raw.lotSize) ?? 100;
    const stepVolume = protobufLongToNumber(raw.stepVolume) ?? protobufLongToNumber(raw.volumeStep) ?? lotSize;
    const minVolume = protobufLongToNumber(raw.minVolume);
    const maxVolume = protobufLongToNumber(raw.maxVolume);

    const qtyPrecision = stepVolume > 0 && lotSize > 0
      ? Math.max(0, -Math.floor(Math.log10(stepVolume / lotSize)))
      : 2;

    return {
      qtyPrecision,
      pricePrecision: digits,
      tickSize: Math.pow(10, -digits),
      minOrderQty: minVolume != null && lotSize > 0 ? minVolume / lotSize : undefined,
      maxOrderQty: maxVolume != null && lotSize > 0 ? maxVolume / lotSize : undefined,
      qtyStep: stepVolume > 0 && lotSize > 0 ? stepVolume / lotSize : undefined,
    };
  } catch (error) {
    logger.warn('Failed to get cTrader symbol info', {
      symbol,
      error: serializeErrorForLog(error),
    });
    return null;
  }
}

// In-memory cache for validation results (valid for the duration of the run)
// Key: symbol string, Value: validation result
const validationCache = new Map<string, { valid: boolean; error?: string; actualSymbol?: string }>();

/**
 * Get symbol information from Bybit to determine precision
 * @param useCache - If true, use disk cache for API calls (only use in evaluation mode)
 */
export async function getSymbolInfo(
  bybitClient: RestClientV5,
  symbol: string,
  useCache: boolean = false
): Promise<SymbolInfo | null> {
  try {
    // Try linear first (futures), then spot
    const categories = ['linear', 'spot'] as const;
    
    // Extract base asset from symbol (e.g., XPLUSDT -> XPL)
    // This might be needed for some API calls
    const baseAsset = symbol.replace(/USDT$|USDC$/, '');
    
    for (const category of categories) {
      try {
        // First try with the full symbol - check cache first if enabled
        const cacheParams = { category, symbol };
        let instruments: any = null;
        
        if (useCache) {
          instruments = await getCachedResponse('getInstrumentsInfo', cacheParams);
        }
        
        if (!instruments) {
          // Not in cache or caching disabled, make API call
          instruments = await bybitClient.getInstrumentsInfo({ category, symbol });
          // Cache successful responses only if caching is enabled
          if (useCache && instruments.retCode === 0) {
            await setCachedResponse('getInstrumentsInfo', cacheParams, instruments);
          }
        }
        
        // If that fails or returns empty, try without symbol parameter to get all instruments
        if (instruments.retCode !== 0 || !instruments.result?.list || instruments.result.list.length === 0) {
          logger.debug('Trying to get all instruments without symbol filter', {
            symbol,
            category,
            retCode: instruments.retCode
          });
          
          // Check cache for all instruments call if enabled
          const allInstrumentsCacheParams = { category };
          let allInstruments: any = null;
          
          if (useCache) {
            allInstruments = await getCachedResponse('getInstrumentsInfo', allInstrumentsCacheParams);
          }
          
          if (!allInstruments) {
            // Not in cache or caching disabled, make API call
            allInstruments = await bybitClient.getInstrumentsInfo({ category });
            // Cache successful responses only if caching is enabled
            if (useCache && allInstruments.retCode === 0) {
              await setCachedResponse('getInstrumentsInfo', allInstrumentsCacheParams, allInstruments);
            }
          }
          
          instruments = allInstruments;
        }
        
        if (instruments.retCode === 0 && instruments.result && instruments.result.list) {
          // Try multiple matching strategies
          let instrument = instruments.result.list.find((s: any) => s.symbol === symbol);
          
          // If not found, try case-insensitive match
          if (!instrument) {
            instrument = instruments.result.list.find((s: any) => s.symbol?.toUpperCase() === symbol.toUpperCase());
          }
          
          // If still not found, try matching by base asset
          if (!instrument && baseAsset) {
            instrument = instruments.result.list.find((s: any) => 
              s.symbol?.startsWith(baseAsset) && (s.symbol?.endsWith('USDT') || s.symbol?.endsWith('USDC'))
            );
          }
          
          if (!instrument) {
            logger.debug('Symbol not found in instruments list', {
              symbol,
              baseAsset,
              category,
              availableSymbols: instruments.result.list.map((s: any) => s.symbol).slice(0, 20),
              totalInstruments: instruments.result.list.length
            });
            continue;
          }
          
          const lotSizeFilter = getBybitField<any>(instrument, 'lotSizeFilter', 'lot_size_filter');
          const priceFilter = getBybitField<any>(instrument, 'priceFilter', 'price_filter');
          
          logger.debug('Inspecting instrument structure', {
            symbol,
            category,
            hasLotSizeFilter: !!lotSizeFilter,
            hasPriceFilter: !!priceFilter,
            lotSizeFilterKeys: lotSizeFilter ? Object.keys(lotSizeFilter) : [],
            priceFilterKeys: priceFilter ? Object.keys(priceFilter) : []
          });
          
          const symbolInfo: SymbolInfo = {};
          
          const qtyPrecision = getBybitField<string | number>(lotSizeFilter, 'qtyPrecision', 'qty_precision');
          if (qtyPrecision !== undefined && qtyPrecision !== null) {
            symbolInfo.qtyPrecision = parseInt(String(qtyPrecision));
          }

          const tickSize = getBybitField<string | number>(priceFilter, 'tickSize', 'tick_size');
          if (tickSize !== undefined && tickSize !== null) {
            const parsedTickSize = parseFloat(String(tickSize));
            symbolInfo.tickSize = parsedTickSize;
            symbolInfo.pricePrecision = getDecimalPrecision(parsedTickSize);
          }

          const minQty = getBybitField<string | number>(lotSizeFilter, 'minOrderQty', 'min_order_qty');
          if (minQty !== undefined && minQty !== null) {
            symbolInfo.minOrderQty = parseFloat(String(minQty));
          }

          const maxQty = getBybitField<string | number>(lotSizeFilter, 'maxOrderQty', 'max_order_qty');
          if (maxQty !== undefined && maxQty !== null) {
            symbolInfo.maxOrderQty = parseFloat(String(maxQty));
          }

          const qtyStep = getBybitField<string | number>(lotSizeFilter, 'qtyStep', 'qty_step');
          if (qtyStep !== undefined && qtyStep !== null) {
            symbolInfo.qtyStep = parseFloat(String(qtyStep));
          }
          
          // Return symbol info if we got at least qtyStep or qtyPrecision (most important fields)
          if (symbolInfo.qtyStep !== undefined || symbolInfo.qtyPrecision !== undefined || symbolInfo.minOrderQty !== undefined) {
            logger.debug('Extracted symbol info from Bybit API', {
              symbol,
              category,
              lotSizeFilter: JSON.stringify(lotSizeFilter),
              priceFilter: JSON.stringify(priceFilter),
              symbolInfo
            });
            
            return symbolInfo;
          } else {
            logger.debug('No valid symbol info extracted from instrument', {
              symbol,
              category,
              hasLotSizeFilter: !!lotSizeFilter,
              hasPriceFilter: !!priceFilter,
              lotSizeFilterKeys: lotSizeFilter ? Object.keys(lotSizeFilter) : [],
              priceFilterKeys: priceFilter ? Object.keys(priceFilter) : [],
              instrumentSample: JSON.stringify(instrument).substring(0, 500)
            });
          }
        } else {
          logger.debug('Failed to get instruments info', {
            symbol,
            category,
            retCode: instruments.retCode,
            retMsg: instruments.retMsg
          });
        }
      } catch (error) {
        // Continue to next category
        continue;
      }
    }
  } catch (error) {
    logger.warn('Failed to get symbol info', {
      symbol,
      error: serializeErrorForLog(error)
    });
  }
  return null;
}

/**
 * Validate if a symbol exists on Bybit
 * Tries USDT first, then USDC if USDT doesn't exist
 * Also tries asset variant (e.g., "1000SHIB" -> "SHIB1000") as fallback
 * @param useCache - If true, use disk cache for API calls (only use in evaluation mode)
 */
export async function validateBybitSymbol(
  bybitClient: RestClientV5,
  symbol: string,
  useCache: boolean = false
): Promise<{ valid: boolean; error?: string; actualSymbol?: string }> {
  try {
    let normalizedSymbol = symbol.replace('/', '').toUpperCase();
    
    // Log validation attempt - critical for investigations
    logger.debug('Starting symbol validation', {
      symbol: normalizedSymbol,
      useCache
    });
    
    // Check in-memory cache first
    if (validationCache.has(normalizedSymbol)) {
      const cached = validationCache.get(normalizedSymbol)!;
      logger.debug('Using cached validation result', {
        symbol: normalizedSymbol,
        valid: cached.valid,
        actualSymbol: cached.actualSymbol,
        cached: true
      });
      return cached;
    }
    
    // Ensure symbol ends with USDT or USDC
    const baseSymbol = normalizedSymbol.replace(/USDT$|USDC$/, '');
    const quoteCurrency = normalizedSymbol.endsWith('USDC') ? 'USDC' : 'USDT';
    
    // Try USDT first (most common)
    let symbolsToTry = [`${baseSymbol}USDT`];
    if (quoteCurrency === 'USDC') {
      // If explicitly USDC, try that first
      symbolsToTry = [`${baseSymbol}USDC`, `${baseSymbol}USDT`];
    } else {
      // Try USDT first, then USDC as fallback
      symbolsToTry = [`${baseSymbol}USDT`, `${baseSymbol}USDC`];
    }
    
    // Log what symbols will be tried - critical for investigations
    logger.debug('Symbol validation: trying symbols and categories', {
      originalSymbol: normalizedSymbol,
      baseSymbol,
      quoteCurrency,
      symbolsToTry,
      categories: ['spot', 'linear']
    });
    
    // Try both spot and linear categories
    const categories = ['spot', 'linear'];
    
    // First, try the original symbols
    for (const symbolToCheck of symbolsToTry) {
      for (const category of categories) {
        try {
          // Check cache first if enabled
          const cacheParams = { 
            category: category as 'spot' | 'linear', 
            symbol: symbolToCheck 
          };
          let instruments: any = null;
          
          if (useCache) {
            instruments = await getCachedResponse('getInstrumentsInfo', cacheParams);
          }
          
          if (!instruments) {
            // Not in cache or caching disabled, make API call
            instruments = await bybitClient.getInstrumentsInfo(cacheParams);
            // Cache successful responses only if caching is enabled
            if (useCache && instruments.retCode === 0) {
              await setCachedResponse('getInstrumentsInfo', cacheParams, instruments);
            }
          }
          
          if (instruments.retCode === 0 && instruments.result?.list) {
            const instrument = instruments.result.list.find(
              (s: any) => s.symbol === symbolToCheck
            );
            
            if (instrument) {
              // Check if symbol is active for trading
              const status = (instrument as any).status;
              const result = status === 'Trading' 
                ? { valid: true, actualSymbol: symbolToCheck }
                : { 
                    valid: false, 
                    error: `Symbol ${symbolToCheck} exists but is not trading (status: ${status}, category: ${category})`,
                    actualSymbol: symbolToCheck
                  };
              
              // Log validation result - critical for investigations
              logger.info('Symbol validation result', {
                symbol: normalizedSymbol,
                symbolChecked: symbolToCheck,
                category,
                valid: result.valid,
                actualSymbol: result.actualSymbol,
                status: status,
                error: result.error
              });
              
              // Cache the result
              validationCache.set(normalizedSymbol, result);
              return result;
            }
            
            // If list is empty or symbol not found in list, try fetching all instruments as fallback
            // This handles cases where Bybit returns success but empty list for symbol-specific queries
            if (instruments.result.list.length === 0) {
              logger.debug('Symbol-specific query returned empty list, trying all instruments', {
                symbol: symbolToCheck,
                category
              });
              
              try {
                // Check cache for all instruments call if enabled
                const allInstrumentsCacheParams = { category };
                let allInstruments: any = null;
                
                if (useCache) {
                  allInstruments = await getCachedResponse('getInstrumentsInfo', allInstrumentsCacheParams);
                }
                
                if (!allInstruments) {
                  allInstruments = await bybitClient.getInstrumentsInfo({ category: category as 'spot' | 'linear' });
                  if (useCache && allInstruments.retCode === 0) {
                    await setCachedResponse('getInstrumentsInfo', allInstrumentsCacheParams, allInstruments);
                  }
                }
                
                if (allInstruments.retCode === 0 && allInstruments.result?.list) {
                  const instrument = allInstruments.result.list.find(
                    (s: any) => s.symbol === symbolToCheck
                  );
                  
                  if (instrument) {
                    const status = (instrument as any).status;
                    const result = status === 'Trading' 
                      ? { valid: true, actualSymbol: symbolToCheck }
                      : { 
                          valid: false, 
                          error: `Symbol ${symbolToCheck} exists but is not trading (status: ${status}, category: ${category})`,
                          actualSymbol: symbolToCheck
                        };
                    
                    // Log validation result from fallback search - critical for investigations
                    logger.info('Symbol validation result (via all instruments fallback)', {
                      symbol: normalizedSymbol,
                      symbolChecked: symbolToCheck,
                      category,
                      valid: result.valid,
                      actualSymbol: result.actualSymbol,
                      status: status,
                      error: result.error,
                      method: 'all-instruments-fallback'
                    });
                    
                    validationCache.set(normalizedSymbol, result);
                    return result;
                  }
                }
              } catch (fallbackError) {
                logger.debug('Fallback to all instruments failed', {
                  symbol: symbolToCheck,
                  category,
                  error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                });
              }
            }
          }
          
          // If we got a non-10001 error, don't try other categories for this symbol
          // But log it for debugging
          if (instruments.retCode !== 0 && instruments.retCode !== 10001) {
            logger.debug('API returned non-10001 error, trying next category', {
              symbol: symbolToCheck,
              category,
              retCode: instruments.retCode,
              retMsg: instruments.retMsg
            });
            break; // Try next category
          }
        } catch (error) {
          // Log exceptions instead of silently ignoring them
          logger.warn('Exception during symbol validation, trying next category', {
            symbol: symbolToCheck,
            category,
            error: error instanceof Error ? error.message : String(error)
          });
          // Continue to next category
          continue;
        }
      }
    }
    
    // If original symbols didn't work, try asset variant as fallback
    // For example, if "1000SHIBUSDT" didn't work, try "SHIB1000USDT"
    const assetVariant = getAssetVariant(baseSymbol);
    if (assetVariant) {
      const variantSymbolsToTry = [`${assetVariant}USDT`, `${assetVariant}USDC`];
      
      logger.debug('Trying asset variant as fallback', {
        originalSymbol: baseSymbol,
        variant: assetVariant,
        symbolsToTry: variantSymbolsToTry
      });
      
      for (const symbolToCheck of variantSymbolsToTry) {
        for (const category of categories) {
          try {
            // Check cache first if enabled
            const cacheParams = { 
              category: category as 'spot' | 'linear', 
              symbol: symbolToCheck 
            };
            let instruments: any = null;
            
            if (useCache) {
              instruments = await getCachedResponse('getInstrumentsInfo', cacheParams);
            }
            
            if (!instruments) {
              // Not in cache or caching disabled, make API call
              instruments = await bybitClient.getInstrumentsInfo(cacheParams);
              // Cache successful responses only if caching is enabled
              if (useCache && instruments.retCode === 0) {
                await setCachedResponse('getInstrumentsInfo', cacheParams, instruments);
              }
            }
            
            if (instruments.retCode === 0 && instruments.result?.list) {
              const instrument = instruments.result.list.find(
                (s: any) => s.symbol === symbolToCheck
              );
              
              if (instrument) {
                // Check if symbol is active for trading
                const status = (instrument as any).status;
                const result = status === 'Trading'
                  ? { valid: true, actualSymbol: symbolToCheck }
                  : { 
                      valid: false, 
                      error: `Symbol ${symbolToCheck} exists but is not trading (status: ${status}, category: ${category})`,
                      actualSymbol: symbolToCheck
                    };
                
                if (status === 'Trading') {
                  logger.info('Found symbol using asset variant', {
                    originalSymbol: baseSymbol,
                    variant: assetVariant,
                    actualSymbol: symbolToCheck
                  });
                }
                
                // Cache the result
                validationCache.set(normalizedSymbol, result);
                return result;
              }
              
              // If list is empty or symbol not found in list, try fetching all instruments as fallback
              if (instruments.result.list.length === 0) {
                logger.debug('Symbol-specific query returned empty list for variant, trying all instruments', {
                  symbol: symbolToCheck,
                  category
                });
                
                try {
                  const allInstrumentsCacheParams = { category };
                  let allInstruments: any = null;
                  
                  if (useCache) {
                    allInstruments = await getCachedResponse('getInstrumentsInfo', allInstrumentsCacheParams);
                  }
                  
                  if (!allInstruments) {
                    allInstruments = await bybitClient.getInstrumentsInfo({ category: category as 'spot' | 'linear' });
                    if (useCache && allInstruments.retCode === 0) {
                      await setCachedResponse('getInstrumentsInfo', allInstrumentsCacheParams, allInstruments);
                    }
                  }
                  
                  if (allInstruments.retCode === 0 && allInstruments.result?.list) {
                    const instrument = allInstruments.result.list.find(
                      (s: any) => s.symbol === symbolToCheck
                    );
                    
                    if (instrument) {
                      const status = (instrument as any).status;
                      const result = status === 'Trading'
                        ? { valid: true, actualSymbol: symbolToCheck }
                        : { 
                            valid: false, 
                            error: `Symbol ${symbolToCheck} exists but is not trading (status: ${status}, category: ${category})`,
                            actualSymbol: symbolToCheck
                          };
                      
                      if (status === 'Trading') {
                        logger.info('Found symbol using asset variant (via all instruments fallback)', {
                          originalSymbol: baseSymbol,
                          variant: assetVariant,
                          actualSymbol: symbolToCheck
                        });
                      }
                      
                      validationCache.set(normalizedSymbol, result);
                      return result;
                    }
                  }
                } catch (fallbackError) {
                  logger.debug('Fallback to all instruments failed for variant', {
                    symbol: symbolToCheck,
                    category,
                    error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                  });
                }
              }
            }
            
            // If we got a non-10001 error, don't try other categories for this symbol
            // But log it for debugging
            if (instruments.retCode !== 0 && instruments.retCode !== 10001) {
              logger.debug('API returned non-10001 error for variant, trying next category', {
                symbol: symbolToCheck,
                category,
                retCode: instruments.retCode,
                retMsg: instruments.retMsg
              });
              break; // Try next category
            }
          } catch (error) {
            // Log exceptions instead of silently ignoring them
            logger.warn('Exception during variant symbol validation, trying next category', {
              symbol: symbolToCheck,
              category,
              error: error instanceof Error ? error.message : String(error)
            });
            // Continue to next category
            continue;
          }
        }
      }
    }
    
    // Neither original nor variant found
    const triedSymbols = assetVariant 
      ? [...symbolsToTry, `${assetVariant}USDT`, `${assetVariant}USDC`]
      : symbolsToTry;
    
    // Log validation failure - critical for investigations
    logger.warn('Symbol validation failed: symbol not found on Bybit', {
      symbol: normalizedSymbol,
      baseSymbol,
      symbolsTried: triedSymbols,
      categoriesTried: categories,
      assetVariantTried: assetVariant || false,
      reason: 'Symbol does not exist on Bybit in any category (spot/linear) or quote currency (USDT/USDC)'
    });
    
    const result = { 
      valid: false, 
      error: `Symbol ${baseSymbol} not found on Bybit (tried ${triedSymbols.join(', ')})` 
    };
    // Cache the negative result too
    validationCache.set(normalizedSymbol, result);
    return result;
  } catch (error) {
    logger.error('Exception during symbol validation', {
      symbol,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : String(error) 
    };
  }
}

/**
 * Validate if a symbol exists using price provider (for evaluation mode)
 * Uses Bybit or cTrader client from price provider when available
 */
export async function validateSymbolWithPriceProvider(
  priceProvider: HistoricalPriceProvider,
  tradingPair: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Try cTrader first if provider has cTrader client
    const getCTraderClient = priceProvider.getCTraderClient;
    if (getCTraderClient) {
      const ctraderClient = getCTraderClient();
      if (ctraderClient) {
        const normalizedSymbol = tradingPair.replace('/', '').toUpperCase();
        const symbol = normalizedSymbol.endsWith('USD') ? normalizedSymbol : `${normalizedSymbol.replace(/USDT$|USDC$/, '')}USD`;
        try {
          if (!ctraderClient.isConnected?.()) {
            await ctraderClient.connect();
            await ctraderClient.authenticate();
          }
          await ctraderClient.getSymbolInfo(symbol);
          return { valid: true };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return { valid: false, error: errMsg.includes('not found') ? `Symbol ${symbol} not found on cTrader` : errMsg };
        }
      }
    }

    // Bybit path
    const bybitClient = priceProvider.getBybitClient();
    if (!bybitClient) {
      return await validateSymbolWithPriceData(priceProvider, tradingPair);
    }

    let normalizedPair = tradingPair.replace('/', '').toUpperCase();
    const baseSymbol = normalizedPair.replace(/USDT$|USDC$/, '');
    const quoteCurrency = normalizedPair.endsWith('USDC') ? 'USDC' : 'USDT';
    const originalSymbol = `${baseSymbol}${quoteCurrency}`;
    const validation = await validateBybitSymbol(bybitClient, originalSymbol, true);
    if (validation.valid) return { valid: true };

    const assetVariant = getAssetVariant(baseSymbol);
    if (assetVariant) {
      const variantSymbol = `${assetVariant}${quoteCurrency}`;
      const variantValidation = await validateBybitSymbol(bybitClient, variantSymbol, true);
      if (variantValidation.valid) return { valid: true };
    }

    return {
      valid: false,
      error: validation.error || `Symbol ${baseSymbol} not found on Bybit`,
    };
  } catch (error) {
    return await validateSymbolWithPriceData(priceProvider, tradingPair);
  }
}

/**
 * Fallback validation using price data (used when no exchange client available)
 */
async function validateSymbolWithPriceData(
  priceProvider: HistoricalPriceProvider,
  tradingPair: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    const normalizedPair = tradingPair.replace('/', '').toUpperCase();

    // cTrader forex/CFD: EURUSD, XAUUSD - try as-is
    if (normalizedPair.endsWith('USD') && !normalizedPair.endsWith('USDT') && !normalizedPair.endsWith('USDC')) {
      try {
        const price = await priceProvider.getCurrentPrice(normalizedPair);
        if (price && price > 0) return { valid: true };
      } catch {
        /* continue */
      }
      return { valid: false, error: `Symbol ${normalizedPair} not found or no price data` };
    }

    // Bybit: ensure USDT/USDC
    const baseSymbol = normalizedPair.replace(/USDT$|USDC$/, '');
    const quoteCurrency = normalizedPair.endsWith('USDC') ? 'USDC' : 'USDT';
    const originalSymbol = `${baseSymbol}${quoteCurrency}`;

    try {
      const price = await priceProvider.getCurrentPrice(originalSymbol);
      if (price && price > 0) return { valid: true };
    } catch {
      /* continue */
    }

    const assetVariant = getAssetVariant(baseSymbol);
    if (assetVariant) {
      const variantSymbol = `${assetVariant}${quoteCurrency}`;
      try {
        const price = await priceProvider.getCurrentPrice(variantSymbol);
        if (price && price > 0) return { valid: true };
      } catch {
        /* continue */
      }
    }

    return {
      valid: false,
      error: `Symbol ${baseSymbol} not found or no price data available`,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

