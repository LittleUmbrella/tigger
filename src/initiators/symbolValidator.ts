/**
 * Symbol Validator
 * 
 * Utilities for validating trading symbols before creating trades.
 */

import { RestClientV5 } from 'bybit-api';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { logger } from '../utils/logger.js';

/**
 * Validate if a symbol exists on Bybit
 * Tries USDT first, then USDC if USDT doesn't exist
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
    
    // Neither USDT nor USDC found
    return { 
      valid: false, 
      error: `Symbol ${baseSymbol} not found on Bybit (tried ${symbolsToTry.join(', ')})` 
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
 */
export async function validateSymbolWithPriceProvider(
  priceProvider: HistoricalPriceProvider,
  tradingPair: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    // Try to get current price - if it fails, symbol likely doesn't exist
    const currentPrice = await priceProvider.getCurrentPrice(tradingPair);
    
    if (currentPrice && currentPrice > 0) {
      return { valid: true };
    }
    
    return { 
      valid: false, 
      error: `Symbol ${tradingPair} not found or no price data available` 
    };
  } catch (error) {
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : String(error) 
    };
  }
}

