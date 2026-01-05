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

export interface SymbolInfo {
  qtyPrecision?: number;
  pricePrecision?: number;
  minOrderQty?: number;
  qtyStep?: number;
}

/**
 * Get symbol information from Bybit to determine precision
 */
export async function getSymbolInfo(
  bybitClient: RestClientV5,
  symbol: string
): Promise<SymbolInfo | null> {
  try {
    // Try linear first (futures), then spot
    const categories = ['linear', 'spot'] as const;
    
    // Extract base asset from symbol (e.g., XPLUSDT -> XPL)
    // This might be needed for some API calls
    const baseAsset = symbol.replace(/USDT$|USDC$/, '');
    
    for (const category of categories) {
      try {
        // First try with the full symbol
        let instruments = await bybitClient.getInstrumentsInfo({ category, symbol });
        
        // If that fails or returns empty, try without symbol parameter to get all instruments
        if (instruments.retCode !== 0 || !instruments.result?.list || instruments.result.list.length === 0) {
          logger.debug('Trying to get all instruments without symbol filter', {
            symbol,
            category,
            retCode: instruments.retCode
          });
          instruments = await bybitClient.getInstrumentsInfo({ category });
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
          
          // Try both snake_case (API format) and camelCase (possible SDK transformation)
          const lotSizeFilter = (instrument as any).lot_size_filter || (instrument as any).lotSizeFilter;
          const priceFilter = (instrument as any).price_filter || (instrument as any).priceFilter;
          
          // Log the actual structure for debugging
          logger.debug('Inspecting instrument structure', {
            symbol,
            category,
            instrumentKeys: Object.keys(instrument as any).slice(0, 20),
            hasLotSizeFilterSnake: !!(instrument as any).lot_size_filter,
            hasLotSizeFilterCamel: !!(instrument as any).lotSizeFilter,
            hasPriceFilterSnake: !!(instrument as any).price_filter,
            hasPriceFilterCamel: !!(instrument as any).priceFilter,
            lotSizeFilterKeys: lotSizeFilter ? Object.keys(lotSizeFilter) : [],
            priceFilterKeys: priceFilter ? Object.keys(priceFilter) : []
          });
          
          const symbolInfo: SymbolInfo = {};
          
          // Extract qty_precision (might be a string or number, try both formats)
          const qtyPrecision = lotSizeFilter?.qty_precision ?? lotSizeFilter?.qtyPrecision;
          if (qtyPrecision !== undefined && qtyPrecision !== null) {
            symbolInfo.qtyPrecision = parseInt(String(qtyPrecision));
          }
          
          // Extract price precision from tick_size (try both formats)
          const tickSize = priceFilter?.tick_size ?? priceFilter?.tickSize;
          if (tickSize !== undefined && tickSize !== null) {
            symbolInfo.pricePrecision = getDecimalPrecision(parseFloat(String(tickSize)));
          }
          
          // Extract min order quantity (try both formats)
          const minQty = lotSizeFilter?.min_qty ?? lotSizeFilter?.minQty;
          if (minQty !== undefined && minQty !== null) {
            symbolInfo.minOrderQty = parseFloat(String(minQty));
          }
          
          // Extract qty_step (CRITICAL - this determines if quantities must be whole numbers)
          // Try both snake_case and camelCase formats
          const qtyStep = lotSizeFilter?.qty_step ?? lotSizeFilter?.qtyStep;
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
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return null;
}

/**
 * Validate if a symbol exists on Bybit
 * Tries USDT first, then USDC if USDT doesn't exist
 * Also tries asset variant (e.g., "1000SHIB" -> "SHIB1000") as fallback
 */
export async function validateBybitSymbol(
  bybitClient: RestClientV5,
  symbol: string
): Promise<{ valid: boolean; error?: string; actualSymbol?: string }> {
  try {
    let normalizedSymbol = symbol.replace('/', '').toUpperCase();
    
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
    
    // Try both spot and linear categories
    const categories = ['spot', 'linear'];
    
    // First, try the original symbols
    for (const symbolToCheck of symbolsToTry) {
      for (const category of categories) {
        try {
          const instruments = await bybitClient.getInstrumentsInfo({ 
            category: category as 'spot' | 'linear', 
            symbol: symbolToCheck 
          });
          
          if (instruments.retCode === 0 && instruments.result?.list) {
            const instrument = instruments.result.list.find(
              (s: any) => s.symbol === symbolToCheck
            );
            
            if (instrument) {
              // Check if symbol is active for trading
              const status = (instrument as any).status;
              if (status === 'Trading') {
                return { valid: true, actualSymbol: symbolToCheck };
              } else {
                return { 
                  valid: false, 
                  error: `Symbol ${symbolToCheck} exists but is not trading (status: ${status}, category: ${category})`,
                  actualSymbol: symbolToCheck
                };
              }
            }
          }
          
          // If we got a non-10001 error, don't try other categories for this symbol
          if (instruments.retCode !== 0 && instruments.retCode !== 10001) {
            break; // Try next category
          }
        } catch (error) {
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
            const instruments = await bybitClient.getInstrumentsInfo({ 
              category: category as 'spot' | 'linear', 
              symbol: symbolToCheck 
            });
            
            if (instruments.retCode === 0 && instruments.result?.list) {
              const instrument = instruments.result.list.find(
                (s: any) => s.symbol === symbolToCheck
              );
              
              if (instrument) {
                // Check if symbol is active for trading
                const status = (instrument as any).status;
                if (status === 'Trading') {
                  logger.info('Found symbol using asset variant', {
                    originalSymbol: baseSymbol,
                    variant: assetVariant,
                    actualSymbol: symbolToCheck
                  });
                  return { valid: true, actualSymbol: symbolToCheck };
                } else {
                  return { 
                    valid: false, 
                    error: `Symbol ${symbolToCheck} exists but is not trading (status: ${status}, category: ${category})`,
                    actualSymbol: symbolToCheck
                  };
                }
              }
            }
            
            // If we got a non-10001 error, don't try other categories for this symbol
            if (instruments.retCode !== 0 && instruments.retCode !== 10001) {
              break; // Try next category
            }
          } catch (error) {
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
    return { 
      valid: false, 
      error: `Symbol ${baseSymbol} not found on Bybit (tried ${triedSymbols.join(', ')})` 
    };
  } catch (error) {
    logger.warn('Error validating symbol', {
      symbol,
      error: error instanceof Error ? error.message : String(error)
    });
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : String(error) 
    };
  }
}

/**
 * Validate if a symbol exists using price provider (for evaluation mode)
 * Tries asset variant (e.g., "1000SHIB" -> "SHIB1000") as fallback
 */
export async function validateSymbolWithPriceProvider(
  priceProvider: HistoricalPriceProvider,
  tradingPair: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Normalize trading pair
    let normalizedPair = tradingPair.replace('/', '').toUpperCase();
    
    // Ensure symbol ends with USDT or USDC
    const baseSymbol = normalizedPair.replace(/USDT$|USDC$/, '');
    const quoteCurrency = normalizedPair.endsWith('USDC') ? 'USDC' : 'USDT';
    
    // Try original symbol first
    const originalSymbol = `${baseSymbol}${quoteCurrency}`;
    try {
      const currentPrice = await priceProvider.getCurrentPrice(originalSymbol);
      if (currentPrice && currentPrice > 0) {
        return { valid: true };
      }
    } catch (error) {
      // Continue to try variant
    }
    
    // If original didn't work, try asset variant as fallback
    const assetVariant = getAssetVariant(baseSymbol);
    if (assetVariant) {
      const variantSymbol = `${assetVariant}${quoteCurrency}`;
      try {
        const currentPrice = await priceProvider.getCurrentPrice(variantSymbol);
        if (currentPrice && currentPrice > 0) {
          return { valid: true };
        }
      } catch (error) {
        // Variant also failed
      }
    }
    
    return { 
      valid: false, 
      error: `Symbol ${baseSymbol} not found or no price data available` 
    };
  } catch (error) {
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : String(error) 
    };
  }
}

