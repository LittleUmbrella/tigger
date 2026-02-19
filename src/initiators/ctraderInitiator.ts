import { InitiatorContext, InitiatorFunction } from './initiatorRegistry.js';
import { AccountConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';
import { calculatePositionSize, calculateQuantity, getDecimalPrecision, getQuantityPrecisionFromRiskAmount, roundPrice, roundQuantity, distributeQuantityAcrossTPs, validateAndRedistributeTPQuantities } from '../utils/positionSizing.js';
import { validateTradePrices } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
import { validateTradeAgainstPropFirms } from '../utils/propFirmPreTradeValidation.js';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import dayjs from 'dayjs';

/**
 * Serialize error for logging - handles Error instances, objects, and primitives
 */
const serializeError = (error: unknown): { error: string; stack?: string } => {
  if (error instanceof Error) {
    return {
      error: error.message,
      ...(error.stack && { stack: error.stack })
    };
  } else if (error && typeof error === 'object') {
    try {
      return { error: JSON.stringify(error) };
    } catch {
      return { error: String(error) };
    }
  } else {
    return { error: String(error) };
  }
};

/**
 * cTrader-specific initiator configuration
 */
export interface CTraderInitiatorConfig {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  environment?: 'demo' | 'live';
}

/**
 * Get account credentials from account config or environment variables
 */
const getAccountCredentials = (account: AccountConfig | null): { 
  clientId: string | undefined; 
  clientSecret: string | undefined; 
  accessToken: string | undefined;
  refreshToken: string | undefined;
  accountId: string | undefined;
  environment: 'demo' | 'live';
} => {
  if (account) {
    const envVarNameForClientId = account.envVarNames?.apiKey; // Reuse apiKey field for clientId
    const envVarNameForSecret = account.envVarNames?.apiSecret;
    const envVarNameForAccessToken = account.envVarNames?.accessToken;
    const envVarNameForRefreshToken = account.envVarNames?.refreshToken;
    const envVarNameForAccountId = account.envVarNames?.accountId;
    
    return {
      clientId: envVarNameForClientId ? process.env[envVarNameForClientId] : process.env.CTRADER_CLIENT_ID,
      clientSecret: envVarNameForSecret ? process.env[envVarNameForSecret] : process.env.CTRADER_CLIENT_SECRET,
      accessToken: envVarNameForAccessToken ? process.env[envVarNameForAccessToken] : process.env.CTRADER_ACCESS_TOKEN,
      refreshToken: envVarNameForRefreshToken ? process.env[envVarNameForRefreshToken] : process.env.CTRADER_REFRESH_TOKEN,
      accountId: envVarNameForAccountId ? process.env[envVarNameForAccountId] : process.env.CTRADER_ACCOUNT_ID,
      environment: account.demo ? 'demo' : 'live'
    };
  } else {
    return {
      clientId: process.env.CTRADER_CLIENT_ID,
      clientSecret: process.env.CTRADER_CLIENT_SECRET,
      accessToken: process.env.CTRADER_ACCESS_TOKEN,
      refreshToken: process.env.CTRADER_REFRESH_TOKEN,
      accountId: process.env.CTRADER_ACCOUNT_ID,
      environment: 'demo'
    };
  }
};

/**
 * Get list of accounts to use for this trade
 * Similar to Bybit initiator's getAccountsToUse
 */
const getAccountsToUse = (context: InitiatorContext): (AccountConfig | null)[] => {
  const { accounts, accountFilters, config, order } = context;
  
  // Check account filters first
  if (accountFilters && accountFilters.length > 0 && accounts) {
    for (const filter of accountFilters) {
      const rule = filter.rules;
      let matches = true;
      
      // Check trading pair match
      if (rule.tradingPairs && rule.tradingPairs.length > 0) {
        const normalizedTradingPair = order.tradingPair.toUpperCase();
        const matchesTradingPair = rule.tradingPairs.some(tp => {
          const normalizedTp = tp.toUpperCase().replace('/', '');
          return normalizedTradingPair.includes(normalizedTp) || normalizedTp.includes(normalizedTradingPair.replace('/', ''));
        });
        if (!matchesTradingPair) {
          matches = false;
        }
      }
      
      // Check leverage range
      if (rule.minLeverage !== undefined && order.leverage < rule.minLeverage) {
        matches = false;
      }
      if (rule.maxLeverage !== undefined && order.leverage > rule.maxLeverage) {
        matches = false;
      }
      
      // Check signal type
      if (rule.signalTypes && rule.signalTypes.length > 0) {
        if (!rule.signalTypes.includes(order.signalType)) {
          matches = false;
        }
      }
      
      if (matches) {
        const accountNames = Array.isArray(filter.accounts) ? filter.accounts : [filter.accounts];
        const accountMap = new Map(accounts.map(acc => [acc.name, acc]));
        const selectedAccounts = accountNames
          .map(name => accountMap.get(name))
          .filter((acc): acc is AccountConfig => acc !== undefined && acc.exchange === 'ctrader');
        
        if (selectedAccounts.length > 0) {
          logger.info('Account filter matched', {
            tradingPair: order.tradingPair,
            leverage: order.leverage,
            signalType: order.signalType,
            matchedAccounts: selectedAccounts.map(acc => acc.name),
            filterRules: filter.rules
          });
          return selectedAccounts;
        }
      }
    }
  }
  
  // Fallback: use initiator-level accounts configuration
  if (accounts && config.accounts) {
    const accountNames = Array.isArray(config.accounts) ? config.accounts : [config.accounts];
    const accountMap = new Map(accounts.map(acc => [acc.name, acc]));
    const selectedAccounts = accountNames
      .map(name => accountMap.get(name))
      .filter((acc): acc is AccountConfig => acc !== undefined && acc.exchange === 'ctrader');
    
    if (selectedAccounts.length > 0) {
      return selectedAccounts;
    }
  }
  
  // Final fallback: use default account (null means use env vars)
  return [null];
};

/**
 * Normalize trading pair symbol for cTrader
 * cTrader uses format like "BTCUSD" or "EURUSD"
 */
const normalizeCTraderSymbol = (tradingPair: string): string => {
  // Remove slash and convert to uppercase
  let normalized = tradingPair.replace('/', '').toUpperCase();
  
  // cTrader typically uses formats like BTCUSD, EURUSD, etc.
  // If it doesn't end with USD, add it
  if (!normalized.endsWith('USD')) {
    // Try to detect if it already has a quote currency
    const commonQuotes = ['USDT', 'USDC', 'EUR', 'GBP', 'JPY'];
    const hasQuote = commonQuotes.some(quote => normalized.endsWith(quote));
    if (!hasQuote) {
      normalized = normalized + 'USD';
    }
  }
  
  return normalized;
};

/**
 * Execute a trade for a single account
 */
const executeTradeForAccount = async (
  context: InitiatorContext,
  account: AccountConfig | null,
  accountName: string
): Promise<void> => {
  const { channel, riskPercentage, entryTimeoutMinutes, message, order, db, isSimulation, priceProvider, config } = context;

  let ctraderClient: CTraderClient | undefined = undefined;

  try {
    logger.info('Starting cTrader trade initiation for account', {
      channel,
      messageId: message.message_id,
      tradingPair: order.tradingPair,
      signalType: order.signalType,
      accountName: accountName || 'default',
      accountConfig: account ? {
        name: account.name,
        demo: account.demo
      } : null,
      isSimulation
    });

    // Get API credentials for this account
    const { clientId, clientSecret, accessToken, refreshToken, accountId, environment } = getAccountCredentials(account);
    
    if (!isSimulation && (!accessToken || !accountId)) {
      logger.error('cTrader credentials not found', {
        channel,
        accountName: accountName || 'default',
        missing: !accessToken ? 'accessToken' : 'accountId',
        accountConfig: account ? {
          name: account.name,
          envVarNames: account.envVarNames
        } : null
      });
      return;
    }
    if (!isSimulation && accessToken && accountId) {
      const clientConfig: CTraderClientConfig = {
        clientId: clientId || '',
        clientSecret: clientSecret || '',
        accessToken,
        refreshToken,
        accountId,
        environment: environment || 'demo'
      };
      
      ctraderClient = new CTraderClient(clientConfig);
      
      try {
        await ctraderClient.connect();
        await ctraderClient.authenticate();
        logger.info('cTrader client initialized', {
          channel,
          accountName: accountName || 'default',
          environment,
          accountId
        });
      } catch (error) {
        logger.error('Failed to connect/authenticate with cTrader', {
          channel,
          accountName: accountName || 'default',
          ...serializeError(error)
        });
        throw error;
      }
    }

    let balance = 10000; // Default simulation balance
    
    if (!isSimulation && ctraderClient) {
      try {
        const accountInfo = await ctraderClient.getAccountInfo();
        
        // Extract balance from accountInfo (Gap #12)
        // ProtoOATraderRes contains a trader object with balance and other details
        const trader = accountInfo?.trader;
        if (trader) {
          const balanceRaw = trader.balance;
          const moneyDigits = trader.moneyDigits || 2;
          
          // Balance is stored as integer (e.g., 2500000 for 25000.00 with 2 digits)
          // Need to divide by 10^moneyDigits to get actual balance
          if (balanceRaw !== undefined && balanceRaw !== null) {
            // Handle both number and object formats (protobufjs may return { low, high } for int64)
            let balanceValue: number;
            if (typeof balanceRaw === 'object' && balanceRaw !== null && 'low' in balanceRaw) {
              // Protobuf int64 format
              balanceValue = (balanceRaw as any).low || 0;
            } else {
              balanceValue = typeof balanceRaw === 'number' ? balanceRaw : parseFloat(String(balanceRaw)) || 0;
            }
            
            balance = balanceValue / Math.pow(10, moneyDigits);
            
            logger.info('Account balance extracted', {
              channel,
              accountName: accountName || 'default',
              balanceRaw: balanceValue,
              moneyDigits,
              balance,
              currency: trader.depositAssetId === 15 || trader.depositAssetId === '15' ? 'USD' : 'Unknown'
            });
          } else {
            logger.warn('Balance not found in trader object, using default', {
              channel,
              accountName: accountName || 'default',
              traderKeys: Object.keys(trader)
            });
            balance = 10000;
          }
        } else {
          // Fallback: try to extract from root level
          const balanceRaw = accountInfo?.balance || accountInfo?.deposit || accountInfo?.equity;
          if (balanceRaw !== undefined) {
            const moneyDigits = accountInfo?.moneyDigits || 2;
            balance = parseFloat(String(balanceRaw)) / Math.pow(10, moneyDigits);
            logger.info('Balance extracted from root level', {
              channel,
              accountName: accountName || 'default',
              balance
            });
          } else {
            logger.warn('Balance not found in accountInfo, using default', {
              channel,
              accountName: accountName || 'default',
              accountInfoKeys: Object.keys(accountInfo || {})
            });
            balance = 10000;
          }
        }
        
        if (balance === 0 || !isFinite(balance)) {
          logger.warn('Zero or invalid balance available', { 
            channel,
            accountName: accountName || 'default',
            balance 
          });
          return;
        }
      } catch (error) {
        logger.error('Failed to get account balance', {
          channel,
          accountName: accountName || 'default',
          ...serializeError(error)
        });
        throw error;
      }
    } else if (isSimulation) {
      logger.info('Simulation mode: Using default balance', { balance, channel });
    }

    // Normalize symbol for cTrader
    const symbol = normalizeCTraderSymbol(order.tradingPair);
    
    // Validate symbol exists before creating trade (Gap #1)
    if (!isSimulation && ctraderClient) {
      logger.info('Validating symbol before trade creation', {
        channel,
        messageId: message.message_id,
        tradingPair: order.tradingPair,
        symbol,
        accountName: accountName || 'default'
      });

      try {
        const symbolInfo = await ctraderClient.getSymbolInfo(symbol);
        logger.info('Symbol validated successfully', {
          channel,
          messageId: message.message_id,
          originalTradingPair: order.tradingPair,
          normalizedSymbol: symbol,
          accountName: accountName || 'default'
        });
      } catch (error) {
        logger.error('Invalid symbol, skipping trade', {
          channel,
          messageId: message.message_id,
          symbol,
          tradingPair: order.tradingPair,
          signalType: order.signalType,
          accountName: accountName || 'default',
          error: error instanceof Error ? error.message : String(error),
          reason: 'Symbol validation failed - symbol does not exist or is not trading on cTrader'
        });
        throw new Error(`Invalid symbol: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Check for existing open positions
    const existingTrades = await db.getActiveTrades();
    const existingTradeForSymbol = existingTrades.find(t => 
      t.trading_pair === order.tradingPair && 
      (t.status === 'pending' || t.status === 'active' || t.status === 'filled')
    );
    
    if (existingTradeForSymbol) {
      logger.info('Skipping trade - existing open position for symbol', {
        channel,
        messageId: message.message_id,
        symbol,
        tradingPair: order.tradingPair,
        signalType: order.signalType,
        accountName: accountName || 'default',
        existingTradeId: existingTradeForSymbol.id,
        existingTradeStatus: existingTradeForSymbol.status
      });
      await db.markMessageParsed(message.id);
      return;
    }
    
    // Determine trade side (BUY for long, SELL for short)
    const tradeSide = order.signalType === 'long' ? 'BUY' : 'SELL';
    
    // Get entry price
    let entryPrice: number | undefined = order.entryPrice;
    const isUsingMarketPrice = !entryPrice || entryPrice <= 0;
    
    if (isUsingMarketPrice) {
      if (!isSimulation && ctraderClient) {
        try {
          const currentPrice = await ctraderClient.getCurrentPrice(symbol);
          if (currentPrice !== null && currentPrice > 0) {
            entryPrice = currentPrice;
            logger.info('Using current market price for limit order entry', { symbol, entryPrice });
          }
        } catch (error) {
          logger.warn('Failed to get market price', {
            symbol,
            ...serializeError(error)
          });
        }
      } else if (isSimulation && priceProvider) {
        const currentPrice = await priceProvider.getCurrentPrice(order.tradingPair);
        if (currentPrice !== null) {
          entryPrice = currentPrice;
        }
      }
      
      if (!entryPrice || entryPrice <= 0) {
        throw new Error(`Cannot calculate position size: entry price is required for ${symbol}`);
      }
    }

    if (!entryPrice || entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }
    const finalEntryPrice: number = entryPrice;

    // Validate trade prices
    if (!isUsingMarketPrice) {
      if (!validateTradePrices(
        order.signalType,
        finalEntryPrice,
        order.stopLoss,
        order.takeProfits,
        { channel, symbol, messageId: message.message_id }
      )) {
        throw new Error(`Trade validation failed for ${symbol}: Invalid price relationships detected`);
      }
    }

    // Use baseLeverage as default if leverage is not specified
    const baseLeverage = context.config.baseLeverage;
    const effectiveLeverage = order.leverage > 0 ? order.leverage : (baseLeverage || 1);
    
    // Calculate position size based on risk percentage
    const positionSize = calculatePositionSize(
      balance,
      riskPercentage,
      finalEntryPrice,
      order.stopLoss,
      effectiveLeverage,
      baseLeverage
    );
    
    // Get precision info from exchange symbol info (Gap #2)
    let decimalPrecision = 2; // default fallback for quantity
    let pricePrecision: number | undefined = undefined;
    let tickSize: number | undefined = undefined;
    let minOrderVolume: number | undefined = undefined;
    let maxOrderVolume: number | undefined = undefined;
    let volumeStep: number | undefined = undefined;
    
    if (ctraderClient) {
      try {
        const symbolInfo = await ctraderClient.getSymbolInfo(symbol);
        
        logger.debug('Retrieved symbol info from cTrader', {
          channel,
          symbol,
          symbolInfo: {
            symbolId: symbolInfo.symbolId,
            symbolName: symbolInfo.symbolName,
            digits: symbolInfo.digits,
            pipSize: symbolInfo.pipSize,
            volumePrecision: symbolInfo.volumePrecision,
            minVolume: symbolInfo.minVolume,
            maxVolume: symbolInfo.maxVolume,
            volumeStep: symbolInfo.volumeStep
          },
          accountName: accountName || 'default'
        });
        
        // Extract precision from symbolInfo (Gap #2)
        // cTrader uses 'digits' for price precision and 'volumePrecision' for quantity precision
        if (symbolInfo.volumePrecision !== undefined) {
          decimalPrecision = symbolInfo.volumePrecision;
        } else if (finalEntryPrice > 0 && positionSize > 0) {
          // Fallback: calculate from risk amount in asset
          const riskAmountInAsset = positionSize / finalEntryPrice;
          decimalPrecision = getQuantityPrecisionFromRiskAmount(riskAmountInAsset);
        }
        
        pricePrecision = symbolInfo.digits !== undefined ? symbolInfo.digits : getDecimalPrecision(finalEntryPrice);
        tickSize = symbolInfo.pipSize !== undefined ? symbolInfo.pipSize : undefined;
        minOrderVolume = symbolInfo.minVolume !== undefined ? symbolInfo.minVolume : undefined;
        maxOrderVolume = symbolInfo.maxVolume !== undefined ? symbolInfo.maxVolume : undefined;
        volumeStep = symbolInfo.volumeStep !== undefined ? symbolInfo.volumeStep : undefined;
      } catch (error) {
        logger.warn('Failed to get symbol info, using defaults', {
          symbol,
          accountName: accountName || 'default',
          ...serializeError(error)
        });
        pricePrecision = getDecimalPrecision(finalEntryPrice);
        if (finalEntryPrice > 0 && positionSize > 0) {
          const riskAmountInAsset = positionSize / finalEntryPrice;
          decimalPrecision = getQuantityPrecisionFromRiskAmount(riskAmountInAsset);
        }
      }
    } else if (finalEntryPrice > 0 && positionSize > 0) {
      const riskAmountInAsset = positionSize / finalEntryPrice;
      decimalPrecision = getQuantityPrecisionFromRiskAmount(riskAmountInAsset);
      pricePrecision = getDecimalPrecision(finalEntryPrice);
    }
    
    // Fallback: if pricePrecision is 0 but price has decimal places, calculate from price
    if (pricePrecision === 0 && finalEntryPrice > 0) {
      const priceHasDecimals = finalEntryPrice % 1 !== 0;
      if (priceHasDecimals && (!tickSize || tickSize > finalEntryPrice)) {
        pricePrecision = getDecimalPrecision(finalEntryPrice);
        if (tickSize && tickSize > finalEntryPrice) {
          tickSize = undefined;
        }
        logger.debug('Adjusted pricePrecision from price value', {
          channel,
          symbol,
          originalPricePrecision: 0,
          adjustedPricePrecision: pricePrecision,
          entryPrice: finalEntryPrice,
          tickSize: tickSize || 'undefined',
          accountName: accountName || 'default'
        });
      }
    }
    
    // Round entry price to exchange precision (Gap #3)
    const roundedEntryPrice = roundPrice(finalEntryPrice, pricePrecision, tickSize);
    
    // Validate rounded entry price is valid (must be > 0)
    if (!roundedEntryPrice || roundedEntryPrice <= 0 || !isFinite(roundedEntryPrice)) {
      logger.error('Invalid rounded entry price - logging all parameters', {
        channel,
        symbol,
        accountName: accountName || 'default',
        roundedEntryPrice,
        originalEntryPrice: finalEntryPrice,
        pricePrecision,
        tickSize,
        symbolInfo: {
          qtyPrecision: decimalPrecision,
          pricePrecision,
          tickSize,
          minOrderVolume,
          maxOrderVolume,
          volumeStep
        },
        orderDetails: {
          signalType: order.signalType,
          entryPrice: order.entryPrice,
          stopLoss: order.stopLoss,
          takeProfits: order.takeProfits,
          leverage: order.leverage
        },
        positionSize,
        balance
      });
      throw new Error(`Invalid rounded entry price: ${roundedEntryPrice} (original: ${finalEntryPrice}, pricePrecision: ${pricePrecision}, tickSize: ${tickSize})`);
    }
    
    // Calculate quantity with exchange-provided precision (using rounded entry price)
    let qty = calculateQuantity(positionSize, roundedEntryPrice, decimalPrecision);
    
    // Round quantity to nearest volume_step if specified (Gap #3)
    const effectiveVolumeStep = volumeStep !== undefined && volumeStep > 0 
      ? volumeStep 
      : Math.pow(10, -decimalPrecision);
    
    if (effectiveVolumeStep > 0) {
      const qtyBeforeStep = qty;
      qty = Math.floor(qty / effectiveVolumeStep) * effectiveVolumeStep;
      // Ensure we don't round to zero
      if (qty === 0 && positionSize > 0) {
        qty = effectiveVolumeStep;
      }
      logger.debug('Rounded quantity to volume_step', {
        channel,
        symbol,
        accountName: accountName || 'default',
        qtyBeforeStep,
        qtyAfterStep: qty,
        volumeStep: effectiveVolumeStep,
        volumeStepFromAPI: volumeStep
      });
    }
    
    // Ensure quantity meets minimum order size requirement (Gap #3)
    if (minOrderVolume !== undefined && qty < minOrderVolume) {
      logger.warn('Quantity below minimum order size, adjusting', {
        channel,
        symbol,
        accountName: accountName || 'default',
        calculatedQty: qty,
        minOrderVolume,
        positionSize,
        volumeStep: effectiveVolumeStep
      });
      // Round up to nearest volume_step above minOrderVolume
      qty = Math.ceil(minOrderVolume / effectiveVolumeStep) * effectiveVolumeStep;
    }
    
    // Cap quantity to maximum order size if it exceeds the limit (Gap #3)
    if (maxOrderVolume !== undefined && qty > maxOrderVolume) {
      const qtyBeforeCap = qty;
      // Round down to nearest volume_step below maxOrderVolume
      qty = Math.floor(maxOrderVolume / effectiveVolumeStep) * effectiveVolumeStep;
      
      // Recalculate position size based on capped quantity for accurate logging
      const cappedPositionSize = qty * roundedEntryPrice;
      
      logger.warn('Quantity exceeds maximum order size, capping to max', {
        channel,
        symbol,
        accountName: accountName || 'default',
        qtyBeforeCap,
        qtyAfterCap: qty,
        maxOrderVolume,
        originalPositionSize: positionSize,
        cappedPositionSize,
        volumeStep: effectiveVolumeStep,
        note: 'Stop loss and take profit prices remain unchanged, but quantities are based on capped quantity'
      });
    }
    
    // Final validation: ensure quantity is valid (positive, non-zero, and finite)
    if (!isFinite(qty) || qty <= 0) {
      throw new Error(`Invalid quantity calculated: ${qty} (positionSize: ${positionSize}, entryPrice: ${roundedEntryPrice}, volumeStep: ${effectiveVolumeStep})`);
    }

    // Format quantity string with proper precision (remove trailing zeros, ensure correct decimal places)
    const formatQuantity = (quantity: number, precision: number): string => {
      // Validate quantity is finite before formatting (prevents "Infinity" string)
      if (!isFinite(quantity) || quantity <= 0) {
        throw new Error(`Cannot format invalid quantity: ${quantity}`);
      }
      // Format to string with exact precision, removing trailing zeros
      const formatted = quantity.toFixed(precision);
      // Remove trailing zeros after decimal point
      return formatted.replace(/\.?0+$/, '');
    };

    const qtyString = formatQuantity(qty, decimalPrecision);
    
    logger.info('Calculated trade parameters', {
      channel,
      symbol,
      accountName: accountName || 'default',
      tradeSide,
      qty,
      qtyString,
      entryPrice: roundedEntryPrice,
      originalEntryPrice: finalEntryPrice,
      stopLoss: order.stopLoss,
      leverage: effectiveLeverage,
      baseLeverage,
      decimalPrecision,
      pricePrecision,
      minOrderVolume,
      maxOrderVolume,
      volumeStep,
      positionSize
    });
    
    // Round stop loss to exchange precision (Gap #3)
    const roundedStopLoss = order.stopLoss && order.stopLoss > 0 
      ? roundPrice(order.stopLoss, pricePrecision, tickSize)
      : order.stopLoss;

    // Validate quantity is finite before formatting (prevents "Infinity" string)
    if (!isFinite(qty)) {
      throw new Error(`Quantity is not finite: ${qty} (positionSize: ${positionSize}, entryPrice: ${roundedEntryPrice})`);
    }
    
    // Deduplicate take profits
    const deduplicatedTPs = deduplicateTakeProfits(order.takeProfits, order.signalType, finalEntryPrice);
    
    // Round TP prices to exchange precision (Gap #3)
    let roundedTPPrices: number[] | undefined = undefined;
    if (order.takeProfits && order.takeProfits.length > 0) {
      roundedTPPrices = order.takeProfits.map(tpPrice => 
        roundPrice(tpPrice, pricePrecision, tickSize)
      );
      
      // Deduplicate rounded TP prices (rounding can create duplicates)
      roundedTPPrices = deduplicateTakeProfits(roundedTPPrices, order.signalType);
      
      if (roundedTPPrices.length === 0) {
        logger.warn('All TP prices were removed after deduplication', {
          channel,
          symbol,
          accountName: accountName || 'default',
          originalTPs: order.takeProfits,
          roundedTPs: order.takeProfits.map(tpPrice => 
            roundPrice(tpPrice, pricePrecision, tickSize)
          )
        });
      } else if (roundedTPPrices.length < order.takeProfits.length) {
        logger.info('Removed duplicate TP prices after rounding', {
          channel,
          symbol,
          accountName: accountName || 'default',
          originalCount: order.takeProfits.length,
          deduplicatedCount: roundedTPPrices.length,
          originalTPs: order.takeProfits,
          deduplicatedTPs: roundedTPPrices
        });
      }
    }

    // Prop firm pre-trade validation: check if total loss would violate rules (Gap #4)
    if (context.propFirms && context.propFirms.length > 0 && !isSimulation) {
      if (!ctraderClient) {
        throw new Error('Prop firm validation requires a cTrader client to fetch open positions');
      }
      const requiredCTraderClient = ctraderClient;

      // Use current balance from exchange as initial balance for prop firm validation
      const initialBalance = balance;
      
      // For cTrader, we don't have day-start balance tracking yet, so use current balance
      // TODO: Implement getUtcDayStartBalance for cTrader if needed
      const dayStartBalance = initialBalance;

      // Include worst-case loss for ALL currently open exchange positions (per-account)
      let openPositions: any[] = [];
      let openWorstCaseLoss = 0;
      let missingStopLossSymbols: string[] = [];
      
      try {
        openPositions = await requiredCTraderClient.getOpenPositions();
        
        // Calculate worst-case loss for open positions
        for (const position of openPositions) {
          const volume = Math.abs(position.volume || position.quantity || 0);
          if (!isFinite(volume) || volume <= 0) continue;

          const symbolName = position.symbolName || position.symbol || 'UNKNOWN';
          const tradeSide = (position.tradeSide || position.side || '').toLowerCase();
          const avgPrice = parseFloat(position.avgPrice || position.averagePrice || '0');
          const stopLoss = parseFloat(position.stopLoss || '0');

          if (!isFinite(avgPrice) || avgPrice <= 0) {
            missingStopLossSymbols.push(symbolName);
            continue;
          }

          if (!isFinite(stopLoss) || stopLoss <= 0) {
            missingStopLossSymbols.push(symbolName);
            continue;
          }

          // Only count downside (if SL is beyond entry in profit direction, treat loss as 0)
          const perUnitLoss =
            tradeSide === 'buy' || tradeSide === 'long'
              ? Math.max(0, avgPrice - stopLoss)
              : Math.max(0, stopLoss - avgPrice);

          openWorstCaseLoss += perUnitLoss * volume;
        }
      } catch (error) {
        logger.warn('Exception while fetching open positions for prop firm validation', {
          channel,
          accountName: accountName || 'default',
          error: error instanceof Error ? error.message : String(error),
          note: 'Prop firm validation will proceed without including existing open positions'
        });
        openWorstCaseLoss = 0;
      }

      if (!isFinite(openWorstCaseLoss)) {
        logger.warn('Prop firm validation: could not compute worst-case open-position risk (missing stop-loss)', {
          channel,
          messageId: message.message_id,
          accountName: accountName || 'default',
          missingStopLossSymbols,
        });
        openWorstCaseLoss = 0;
      }

      const validationResults = await validateTradeAgainstPropFirms(
        db,
        channel,
        context.propFirms,
        initialBalance,
        roundedEntryPrice,
        roundedStopLoss || 0,
        qty,
        effectiveLeverage,
        openWorstCaseLoss,
        dayStartBalance
      );
      
      // Check if any prop firm would be violated
      const blockedResults = validationResults.filter(r => !r.allowed);
      if (blockedResults.length > 0) {
        const violationMessages = blockedResults.map(r => 
          `${r.propFirmName}: ${r.violations.join('; ')}`
        ).join(' | ');
        
        logger.warn('Trade blocked by prop firm validation', {
          channel,
          messageId: message.message_id,
          tradingPair: order.tradingPair,
          entryPrice: roundedEntryPrice,
          stopLoss: roundedStopLoss,
          quantity: qty,
          accountName: accountName || 'default',
          violations: violationMessages,
          blockedBy: blockedResults.map(r => r.propFirmName)
        });
        
        throw new Error(`Trade would violate prop firm rules: ${violationMessages}`);
      }
      
      // Log successful validation
      logger.debug('Prop firm validation passed', {
        channel,
        messageId: message.message_id,
        tradingPair: order.tradingPair,
        accountName: accountName || 'default',
        propFirms: validationResults.map(r => r.propFirmName)
      });
    }
    
    // Determine if this was originally a market order (entry price missing)
    // Even though we convert it to a limit order at current price, we keep this flag
    // for TP placement logic (immediate execution vs waiting for fill)
    const isMarketOrder = !order.entryPrice || order.entryPrice <= 0;
    
    // Declare tradeId early so it's available throughout the function
    let tradeId: number | undefined;
    
    // Check if current market price is already past stop loss before placing order (Gap #6)
    if (roundedStopLoss && roundedStopLoss > 0 && !isSimulation && ctraderClient) {
      try {
        const currentPrice = await ctraderClient.getCurrentPrice(symbol);
        if (currentPrice !== null && currentPrice > 0) {
          let priceAlreadyPastStopLoss = false;
          let reason = '';
          
          if (order.signalType === 'short') {
            // For SHORT: stop loss is above entry, so if current price > stop loss, we're already past it
            if (currentPrice > roundedStopLoss) {
              priceAlreadyPastStopLoss = true;
              reason = `Current price ${currentPrice} is already above stop loss ${roundedStopLoss} for SHORT position`;
            }
          } else if (order.signalType === 'long') {
            // For LONG: stop loss is below entry, so if current price < stop loss, we're already past it
            if (currentPrice < roundedStopLoss) {
              priceAlreadyPastStopLoss = true;
              reason = `Current price ${currentPrice} is already below stop loss ${roundedStopLoss} for LONG position`;
            }
          }
          
          if (priceAlreadyPastStopLoss) {
            logger.warn('Rejecting order: current market price is already past stop loss', {
              channel,
              symbol,
              messageId: message.message_id,
              accountName: accountName || 'default',
              signalType: order.signalType,
              currentPrice,
              stopLoss: roundedStopLoss,
              entryPrice: roundedEntryPrice,
              reason
            });
            
            throw new Error(`Order rejected: ${reason}. Entry would trigger stop loss immediately.`);
          }
          
          logger.debug('Stop loss validation passed', {
            channel,
            symbol,
            accountName: accountName || 'default',
            signalType: order.signalType,
            currentPrice,
            stopLoss: roundedStopLoss,
            entryPrice: roundedEntryPrice
          });
        }
      } catch (error) {
        // If this is our rejection error, re-throw it
        if (error instanceof Error && error.message.includes('Order rejected')) {
          throw error;
        }
        // Otherwise, log warning but continue (don't block order placement if price check fails)
        logger.warn('Failed to check current price against stop loss, proceeding with order placement', {
          symbol,
          accountName: accountName || 'default',
          stopLoss: roundedStopLoss,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Note: cTrader doesn't support per-symbol leverage setting via API (unlike Bybit)
    // Leverage is set at the account level and configured by the broker
    // Also, cTrader doesn't have position limit error codes that require retry logic with leverage reduction
    // If position limit errors occur, they will be handled by the exchange's error response
    // (Gap #5: Not applicable - cTrader architecture differs from Bybit)
    
    // Place order
    let orderId: string;
    if (isSimulation) {
      orderId = `SIM-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      logger.info('Simulation mode: Trade created', {
        channel,
        accountName: accountName || 'default',
        orderId,
        symbol,
        tradeSide,
        qty,
        entryPrice: roundedEntryPrice
      });
    } else if (ctraderClient) {
      try {
        // Place limit order at entry price
        orderId = await ctraderClient.placeLimitOrder({
          symbol,
          volume: qty,
          tradeSide,
          price: roundedEntryPrice
        });
        logger.info('cTrader order placed', {
          channel,
          accountName: accountName || 'default',
          orderId,
          symbol,
          tradeSide,
          qty,
          entryPrice: roundedEntryPrice
        });
      } catch (error) {
        logger.error('Failed to place cTrader order', {
          channel,
          symbol,
          accountName: accountName || 'default',
          ...serializeError(error)
        });
        throw error;
      }
    } else {
      throw new Error('No cTrader client available');
    }

    // Calculate expiration time
    const expiresAt = dayjs().add(entryTimeoutMinutes, 'minute').toISOString();

    // Insert trade record early so we can update it if needed
    try {
      tradeId = await db.insertTrade({
        channel,
        message_id: message.message_id,
        trading_pair: order.tradingPair,
        direction: order.signalType, // long/short
        entry_price: roundedEntryPrice,
        stop_loss: roundedStopLoss || order.stopLoss,
        take_profits: JSON.stringify(roundedTPPrices || deduplicatedTPs),
        leverage: effectiveLeverage,
        quantity: qty,
        risk_percentage: riskPercentage,
        exchange: 'ctrader',
        account_name: accountName || undefined,
        order_id: orderId,
        entry_order_type: 'limit', // Always limit order (market orders converted to limit at current price)
        status: 'pending',
        stop_loss_breakeven: false,
        expires_at: expiresAt
      });
    } catch (error) {
      logger.warn('Failed to insert trade record early', {
        channel,
        symbol,
        accountName: accountName || 'default',
        orderId,
        error: error instanceof Error ? error.message : String(error)
      });
      // Continue anyway - we'll insert it later
    }

    // Verify stop loss was set, or set it separately if initial order didn't support it (Gap #7)
    // Note: For limit orders, we can't verify until position exists, so we'll set it separately if needed
    if (order.stopLoss && order.stopLoss > 0 && !isSimulation && ctraderClient) {
      // Check if entry order has already filled (market orders or fast-filling limit orders)
      let entryFilled = false;
      try {
        const openPositions = await ctraderClient.getOpenPositions();
        const positionForSymbol = openPositions.find((p: any) => 
          (p.symbolName || p.symbol) === symbol
        );
        entryFilled = !!positionForSymbol;
      } catch (error) {
        logger.debug('Could not check position status for stop loss verification', {
          symbol,
          accountName: accountName || 'default',
          orderId,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Only try to set stop loss if entry has filled (position exists)
      if (entryFilled) {
        try {
          const openPositions = await ctraderClient.getOpenPositions();
          const positionForSymbol = openPositions.find((p: any) => 
            (p.symbolName || p.symbol) === symbol
          );
          
          if (positionForSymbol) {
            const positionId = positionForSymbol.positionId || positionForSymbol.id;
            
            logger.debug('Stop loss parameters being sent to cTrader (entry already filled)', {
              channel,
              symbol,
              accountName: accountName || 'default',
              positionId,
              roundedStopLoss,
              originalStopLoss: order.stopLoss
            });
            
            // Set stop loss using modifyPosition
            await ctraderClient.modifyPosition({
              positionId,
              stopLoss: roundedStopLoss
            });
            
            // Update stop loss order quantity in database for tracking
            if (tradeId) {
              try {
                const orders = await db.getOrdersByTradeId(tradeId);
                const stopLossOrder = orders.find(o => o.order_type === 'stop_loss');
                if (stopLossOrder) {
                await db.updateOrder(stopLossOrder.id, {
                  quantity: qty as number
                });
                  logger.debug('Updated stop loss order quantity after setting on exchange', {
                    tradeId,
                    accountName: accountName || 'default',
                    orderId: stopLossOrder.id,
                    quantity: qty
                  });
                }
              } catch (error) {
                logger.warn('Failed to update stop loss order quantity', {
                  tradeId,
                  accountName: accountName || 'default',
                  error: error instanceof Error ? error.message : String(error)
                });
              }
            }
            
            logger.info('Stop loss verified/set', {
              symbol,
              accountName: accountName || 'default',
              stopLoss: roundedStopLoss
            });
          }
        } catch (error) {
          // If stop loss fails but entry is filled, log warning but don't cancel
          // The monitor will handle setting stop loss if needed
          logger.warn('Failed to set stop loss after entry fill, monitor will retry', {
            symbol,
            accountName: accountName || 'default',
            stopLoss: order.stopLoss,
            ...serializeError(error)
          });
        }
      } else {
        // Entry hasn't filled yet - stop loss will be set by the monitor after entry fills
        logger.debug('Entry order pending, stop loss will be applied when position opens', {
          symbol,
          accountName: accountName || 'default',
          orderId,
          stopLoss: roundedStopLoss
        });
      }
    }

    // Place take profit orders for market orders (immediate TP placement when entry fills) (Gap #8)
    // NOTE: For limit orders that may take hours/days to fill, TP orders are placed by the trade monitor
    // after the entry order fills. This prevents TP orders from being placed before a position exists.
    // Only place TP orders immediately if this was originally a market order (now limit with IOC, fills immediately)
    
    if (order.takeProfits && order.takeProfits.length > 0 && roundedTPPrices && isMarketOrder && !isSimulation && ctraderClient) {
      // For limit orders with IOC timeInForce (originally market orders), check if we have a position immediately
      let positionSide: 'BUY' | 'SELL' | null = null;
      let actualEntryPrice: number | undefined;
      let actualPositionQty: number | undefined;
      let positionId: string | undefined;
      
      try {
        const openPositions = await ctraderClient.getOpenPositions();
        const positionForSymbol = openPositions.find((p: any) => 
          (p.symbolName || p.symbol) === symbol
        );
        
        if (positionForSymbol) {
          positionId = positionForSymbol.positionId || positionForSymbol.id;
          const tradeSide = positionForSymbol.tradeSide || positionForSymbol.side || '';
          positionSide = (tradeSide === 'BUY' || tradeSide === 'buy' || tradeSide === 'long') ? 'BUY' : 'SELL';
          
          // Get actual entry price and position quantity
          const avgPrice = parseFloat(positionForSymbol.avgPrice || positionForSymbol.averagePrice || '0');
          const volume = Math.abs(parseFloat(positionForSymbol.volume || positionForSymbol.quantity || '0'));
          if (avgPrice > 0) {
            actualEntryPrice = avgPrice;
          }
          if (volume > 0) {
            actualPositionQty = volume;
          }
        }
      } catch (error) {
        logger.debug('Could not check position for market order TP placement', {
          channel,
          symbol,
          accountName: accountName || 'default',
          error: error instanceof Error ? error.message : String(error)
        });
      }
      
      if (positionSide && positionId) {
        // Only place TP orders if entry order has filled and we have position side
        
        // Check if TP orders already exist in database before placing on exchange
        // This prevents race conditions with the monitor that also places TP orders
        let shouldPlaceTPOrders = true;
        if (tradeId) {
          const existingOrders = await db.getOrdersByTradeId(tradeId);
          const existingTPOrders = existingOrders.filter(o => o.order_type === 'take_profit');
          if (existingTPOrders.length > 0) {
            logger.info('Take profit orders already exist in database, skipping placement on exchange', {
              tradeId,
              symbol,
              accountName: accountName || 'default',
              existingTPCount: existingTPOrders.length,
              existingTPIndices: existingTPOrders.map(o => o.tp_index).filter(i => i !== undefined)
            });
            shouldPlaceTPOrders = false;
          }
        }
        
        if (shouldPlaceTPOrders) {
          // No existing TP orders, proceed with placement
          
          // Use actual entry price if available, otherwise fall back to finalEntryPrice
          const entryPriceForValidation = actualEntryPrice || finalEntryPrice;
          
          // Validate TP prices against actual entry fill price (Gap #9)
          // Filter out invalid TPs and recalculate quantities if needed
          let validTPPrices = [...roundedTPPrices];
          
          // Check each TP price against entry price
          validTPPrices = validTPPrices.filter((tpPrice) => {
            return order.signalType === 'long' 
              ? tpPrice > entryPriceForValidation 
              : tpPrice < entryPriceForValidation;
          });
          
          if (validTPPrices.length < roundedTPPrices.length) {
            const removedCount = roundedTPPrices.length - validTPPrices.length;
            logger.warn('Some TP prices invalid relative to actual entry fill price - removing invalid TPs', {
              channel,
              symbol,
              accountName: accountName || 'default',
              entryPriceForValidation,
              actualEntryPrice,
              finalEntryPrice,
              originalTPs: roundedTPPrices,
              validTPs: validTPPrices,
              removedCount,
              signalType: order.signalType
            });
          }
          
          // If no valid TPs remain, close the position (Gap #10)
          if (validTPPrices.length === 0) {
            logger.error('No valid TP prices relative to actual entry fill price - closing position', {
              channel,
              symbol,
              accountName: accountName || 'default',
              entryPriceForValidation,
              actualEntryPrice,
              finalEntryPrice,
              originalTPs: roundedTPPrices,
              stopLoss: order.stopLoss,
              signalType: order.signalType,
              note: 'All TP prices were invalid, closing position immediately'
            });
            
            // Close the position
            if (actualPositionQty && positionId) {
              try {
                await ctraderClient.closePosition(positionId);
                
                logger.info('Position closed due to invalid TP prices', {
                  channel,
                  symbol,
                  accountName: accountName || 'default',
                  tradeId,
                  entryOrderId: orderId
                });
                
                // Update trade status
                if (tradeId) {
                  try {
                    await db.updateTrade(tradeId, {
                      status: 'closed',
                      exit_filled_at: dayjs().toISOString()
                    });
                  } catch (error) {
                    logger.warn('Could not update trade status after closing position', {
                      channel,
                      symbol,
                      accountName: accountName || 'default',
                      tradeId,
                      error: error instanceof Error ? error.message : String(error)
                    });
                  }
                }
                
                // Don't place TP orders - position is already closed
                return;
              } catch (error) {
                logger.error('Failed to close position with invalid TPs', {
                  channel,
                  symbol,
                  accountName: accountName || 'default',
                  tradeId,
                  orderId,
                  ...serializeError(error)
                });
                throw error;
              }
            }
          }
          
          // Deduplicate valid TP prices (in case validation didn't catch duplicates)
          const deduplicatedValidTPs = deduplicateTakeProfits(validTPPrices, order.signalType);
          
          // Recalculate TP quantities for remaining valid TPs
          roundedTPPrices = deduplicatedValidTPs;
          
          if (deduplicatedValidTPs.length < validTPPrices.length) {
            logger.info('Removed duplicate TP prices after validation', {
              channel,
              symbol,
              accountName: accountName || 'default',
              beforeDedupCount: validTPPrices.length,
              afterDedupCount: deduplicatedValidTPs.length,
              removedCount: validTPPrices.length - deduplicatedValidTPs.length
            });
          }
          
          logger.info('Using filtered TP prices after validation', {
            channel,
            symbol,
            accountName: accountName || 'default',
            originalTPCount: order.takeProfits.length,
            validTPCount: roundedTPPrices.length,
            validTPPrices: roundedTPPrices
          });
        
          // Verify position side matches expected side
          const expectedPositionSide = order.signalType === 'long' ? 'BUY' : 'SELL';
          if (positionSide !== expectedPositionSide) {
            logger.error('Position side mismatch', {
              channel,
              symbol,
              accountName: accountName || 'default',
              orderId,
              expectedPositionSide,
              actualPositionSide: positionSide,
              note: 'TP orders may fail due to side mismatch'
            });
          }

          // Distribute quantity evenly across remaining valid TPs
          const tpQuantities = distributeQuantityAcrossTPs(
            actualPositionQty || qty,
            validTPPrices.length,
            decimalPrecision
          );

          // Validate and redistribute TP quantities (handles volumeStep rounding, minOrderVolume, maxOrderVolume, and redistribution)
          const validTPOrders = validateAndRedistributeTPQuantities(
            tpQuantities,
            roundedTPPrices,
            actualPositionQty || qty,
            volumeStep,
            minOrderVolume,
            maxOrderVolume,
            decimalPrecision
          );
          
          if (validTPOrders.length === 0) {
            logger.error('No valid TP orders to place - all quantities are zero or below minimum', {
              channel,
              symbol,
              accountName: accountName || 'default',
              qty: actualPositionQty || qty,
              numTPs: order.takeProfits.length,
              minOrderVolume
            });
            // Don't throw error - let the monitor handle TP placement later
            logger.warn('TP orders will be placed by monitor after entry fills', {
              channel,
              symbol,
              accountName: accountName || 'default',
              orderId
            });
          } else {
            // Place individual TP orders using placeLimitOrder
            const tpOrderIds: Array<{ index: number; orderId: string; price: number; quantity: number }> = [];
            
            for (const tpOrder of validTPOrders) {
              try {
                // Determine opposite side for TP orders
                // For a Long position (BUY side), TP is SELL
                // For a Short position (SELL side), TP is BUY
                const tpSide = positionSide === 'BUY' ? 'SELL' : 'BUY';
                
                const tpOrderId = await ctraderClient.placeLimitOrder({
                  symbol,
                  volume: tpOrder.quantity,
                  tradeSide: tpSide,
                  price: tpOrder.price
                });
                
                tpOrderIds.push({
                  index: tpOrder.index,
                  orderId: tpOrderId,
                  price: tpOrder.price,
                  quantity: tpOrder.quantity
                });
                
                logger.info('TP order placed', {
                  channel,
                  symbol,
                  accountName: accountName || 'default',
                  tpIndex: tpOrder.index,
                  tpOrderId,
                  tpPrice: tpOrder.price,
                  tpQuantity: tpOrder.quantity
                });
              } catch (error) {
                logger.error('Failed to place TP order', {
                  channel,
                  symbol,
                  accountName: accountName || 'default',
                  tpIndex: tpOrder.index,
                  tpPrice: tpOrder.price,
                  ...serializeError(error)
                });
                // Continue placing other TPs even if one fails
              }
            }
            
            // Store TP orders in database
            if (tradeId) {
              for (const tpOrder of tpOrderIds) {
                try {
                  await db.insertOrder({
                    trade_id: tradeId,
                    order_type: 'take_profit',
                    order_id: tpOrder.orderId,
                    price: tpOrder.price,
                    quantity: tpOrder.quantity,
                    tp_index: tpOrder.index,
                    status: 'pending'
                  });
                } catch (error) {
                  logger.warn('Failed to store TP order in database', {
                    tradeId,
                    accountName: accountName || 'default',
                    tpOrderId: tpOrder.orderId,
                    error: error instanceof Error ? error.message : String(error)
                  });
                }
              }
            }
          }
        }
      }
    }

    // Ensure tradeId is defined before storing orders
    if (!tradeId) {
      // If tradeId wasn't set earlier, insert trade now
      try {
        tradeId = await db.insertTrade({
          channel,
          message_id: message.message_id,
          trading_pair: order.tradingPair,
          direction: order.signalType,
          entry_price: roundedEntryPrice,
          stop_loss: roundedStopLoss || order.stopLoss,
          take_profits: JSON.stringify(roundedTPPrices || deduplicatedTPs),
          leverage: effectiveLeverage,
          quantity: qty,
          risk_percentage: riskPercentage,
          exchange: 'ctrader',
          account_name: accountName || undefined,
          order_id: orderId,
          entry_order_type: 'limit',
          status: 'pending',
          stop_loss_breakeven: false,
          expires_at: expiresAt
        });
      } catch (error) {
        logger.error('Failed to insert trade record', {
          channel,
          symbol,
          accountName: accountName || 'default',
          orderId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }

    // TypeScript type guard: tradeId is now guaranteed to be a number
    const finalTradeId: number = tradeId;

    // Store entry order
    await db.insertOrder({
      trade_id: finalTradeId,
      order_type: 'entry',
      order_id: orderId,
      price: roundedEntryPrice,
      quantity: qty,
      status: 'pending'
    });

    // Store take profit orders (only for simulation - real TPs are placed above for market orders)
    if (isSimulation) {
      for (let i = 0; i < deduplicatedTPs.length; i++) {
        const tpPrice = deduplicatedTPs[i];
        const tpQty = qty / deduplicatedTPs.length; // Distribute quantity evenly
        
        const tpOrderId = `SIM-TP-${finalTradeId}-${i + 1}`;
        await db.insertOrder({
          trade_id: finalTradeId,
          order_type: 'take_profit',
          order_id: tpOrderId,
          price: tpPrice,
          quantity: tpQty,
          tp_index: i + 1,
          status: 'pending'
        });
      }
    }

    // Mark message as parsed
    await db.markMessageParsed(message.id);

    logger.info('Trade stored in database', {
      channel,
      accountName: accountName || 'default',
      messageId: message.message_id,
      orderId,
      tradeId
    });
  } catch (error) {
    logger.error('Error initiating cTrader trade for account', {
      channel,
      accountName: accountName || 'default',
      ...serializeError(error)
    });
    throw error;
  } finally {
    // Disconnect client if connected
    if (ctraderClient && ctraderClient.isConnected()) {
      await ctraderClient.disconnect().catch((err: unknown) => {
        logger.warn('Error disconnecting cTrader client', {
          ...serializeError(err)
        });
      });
    }
  }
};

/**
 * cTrader initiator function - supports multiple accounts
 */
export const ctraderInitiator: InitiatorFunction = async (context: InitiatorContext): Promise<void> => {
  const { channel, message, order } = context;

  try {
    // Get list of accounts to use
    const accountsToUse = getAccountsToUse(context);
    
    if (accountsToUse.length === 0) {
      logger.error('No accounts configured for initiator', {
        channel,
        initiatorName: context.config.name
      });
      return;
    }

    logger.info('Executing trade for multiple accounts', {
      channel,
      accountCount: accountsToUse.length,
      accounts: accountsToUse.map(acc => acc?.name || 'default')
    });

    // Execute trade for each account
    const results = await Promise.allSettled(
      accountsToUse.map(async (account) => {
        const accountName = account?.name || 'default';
        await executeTradeForAccount(context, account, accountName);
      })
    );

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const accountName = accountsToUse[index]?.name || 'default';
        logger.error('Failed to execute trade for account', {
          channel,
          accountName,
          ...serializeError(result.reason)
        });
      }
    });

    logger.info('Trade initiation completed for all accounts', {
      channel,
      totalAccounts: accountsToUse.length,
      successful: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length
    });
  } catch (error) {
    logger.error('Error in ctraderInitiator', {
      channel,
      ...serializeError(error)
    });
    throw error;
  }
};

