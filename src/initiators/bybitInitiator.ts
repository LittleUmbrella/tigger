import { RestClientV5 } from 'bybit-api';
import { InitiatorContext, InitiatorFunction } from './initiatorRegistry.js';
import { AccountConfig } from '../types/config.js';
import { logger } from '../utils/logger.js';
import { validateBybitSymbol, getSymbolInfo } from './symbolValidator.js';
import { calculatePositionSize, calculateQuantity, getDecimalPrecision, getQuantityPrecisionFromRiskAmount, roundPrice, roundQuantity, distributeQuantityAcrossTPs, validateAndRedistributeTPQuantities } from '../utils/positionSizing.js';
import { validateTradePrices } from '../utils/tradeValidation.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
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
    // Try to stringify object errors
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
 * Bybit-specific initiator configuration
 */
export interface BybitInitiatorConfig {
  testnet?: boolean;
  apiKey?: string;
  apiSecret?: string;
}

/**
 * Get account credentials from account config or environment variables
 */
const getAccountCredentials = (account: AccountConfig | null, fallbackTestnet: boolean = false): { apiKey: string | undefined; apiSecret: string | undefined; testnet: boolean; demo: boolean } => {
  if (account) {
    // Priority: envVarNames > envVars (backward compat) > apiKey/apiSecret (deprecated) > default env vars
    const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
    const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
    const apiKey = envVarNameForKey ? process.env[envVarNameForKey] : (account.apiKey || process.env.BYBIT_API_KEY);
    const apiSecret = envVarNameForSecret ? process.env[envVarNameForSecret] : (account.apiSecret || process.env.BYBIT_API_SECRET);
    return {
      apiKey,
      apiSecret,
      testnet: account.testnet || false,
      demo: account.demo || false
    };
  } else {
    // Fallback to environment variables
    return {
      apiKey: process.env.BYBIT_API_KEY,
      apiSecret: process.env.BYBIT_API_SECRET,
      testnet: fallbackTestnet,
      demo: false
    };
  }
};

/**
 * Check if an order matches a filter rule
 */
const matchesFilterRule = (order: ParsedOrder, rule: { tradingPairs?: string[]; minLeverage?: number; maxLeverage?: number; signalTypes?: ('long' | 'short')[] }): boolean => {
  // Check trading pair match
  if (rule.tradingPairs && rule.tradingPairs.length > 0) {
    const normalizedTradingPair = order.tradingPair.toUpperCase();
    const matchesTradingPair = rule.tradingPairs.some(tp => {
      const normalizedTp = tp.toUpperCase().replace('/', '');
      return normalizedTradingPair.includes(normalizedTp) || normalizedTp.includes(normalizedTradingPair.replace('/', ''));
    });
    if (!matchesTradingPair) {
      return false;
    }
  }

  // Check leverage range
  if (rule.minLeverage !== undefined && order.leverage < rule.minLeverage) {
    return false;
  }
  if (rule.maxLeverage !== undefined && order.leverage > rule.maxLeverage) {
    return false;
  }

  // Check signal type
  if (rule.signalTypes && rule.signalTypes.length > 0) {
    if (!rule.signalTypes.includes(order.signalType)) {
      return false;
    }
  }

  return true;
};

/**
 * Get list of accounts to use for this initiator
 * Supports signal-based account filtering via accountFilters
 */
const getAccountsToUse = (context: InitiatorContext): (AccountConfig | null)[] => {
  const { config, accounts, accountFilters, order } = context;
  
  // First, check if accountFilters are provided (channel-level signal-based filtering)
  if (accountFilters && accountFilters.length > 0 && accounts) {
    const accountMap = new Map(accounts.map(acc => [acc.name, acc]));
    
    // Evaluate filters in order - first match wins
    for (const filter of accountFilters) {
      if (matchesFilterRule(order, filter.rules)) {
        const accountNames = Array.isArray(filter.accounts) ? filter.accounts : [filter.accounts];
        const selectedAccounts: (AccountConfig | null)[] = [];
        
        for (const accountName of accountNames) {
          const account = accountMap.get(accountName);
          if (account && account.exchange === 'bybit') {
            selectedAccounts.push(account);
          } else {
            logger.warn('Account not found or wrong exchange type in filter', {
              accountName,
              filterRules: filter.rules,
              availableAccounts: Array.from(accountMap.keys())
            });
          }
        }
        
        if (selectedAccounts.length > 0) {
          logger.info('Account filter matched', {
            tradingPair: order.tradingPair,
            leverage: order.leverage,
            signalType: order.signalType,
            matchedAccounts: selectedAccounts.map(acc => acc?.name || 'default'),
            filterRules: filter.rules
          });
          return selectedAccounts;
        }
      }
    }
    
    // No filters matched - log and fall through to initiator-level accounts
    logger.debug('No account filters matched, falling back to initiator accounts', {
      tradingPair: order.tradingPair,
      leverage: order.leverage,
      signalType: order.signalType
    });
  }
  
  // Fallback: use initiator-level accounts configuration
  if (accounts && config.accounts) {
    const accountNames = Array.isArray(config.accounts) ? config.accounts : [config.accounts];
    const accountMap = new Map(accounts.map(acc => [acc.name, acc]));
    
    const selectedAccounts: (AccountConfig | null)[] = [];
    for (const accountName of accountNames) {
      const account = accountMap.get(accountName);
      if (account && account.exchange === 'bybit') {
        selectedAccounts.push(account);
      } else {
        logger.warn('Account not found or wrong exchange type', {
          accountName,
          availableAccounts: Array.from(accountMap.keys())
        });
      }
    }
    
    if (selectedAccounts.length > 0) {
      return selectedAccounts;
    }
  }
  
  // Final fallback: use default account (null means use env vars)
  // For backward compatibility, if testnet is set in config, preserve it
  // We'll pass it to getAccountCredentials when account is null
  return [null]; // null means use environment variables
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

  try {
    // Log trade initiation start for this account - critical for investigations
    logger.info('Starting Bybit trade initiation for account', {
      channel,
      messageId: message.message_id,
      tradingPair: order.tradingPair,
      signalType: order.signalType,
      accountName: accountName || 'default',
      accountConfig: account ? {
        name: account.name,
        testnet: account.testnet,
        demo: account.demo
      } : null,
      isSimulation
    });

    // Get API credentials for this account
    // For backward compatibility, use testnet from config if account is null
    const fallbackTestnet = account === null ? ((config as any).testnet || false) : false;
    const { apiKey, apiSecret, testnet, demo } = getAccountCredentials(account, fallbackTestnet);
    
    if (!isSimulation && (!apiKey || !apiSecret)) {
      logger.error('Bybit API credentials not found', {
        channel,
        accountName: accountName || 'default',
        missing: !apiKey ? 'apiKey' : 'apiSecret',
        accountConfig: account ? {
          name: account.name,
          testnet: account.testnet,
          envVarNames: account.envVarNames
        } : null
      });
      return;
    }

    let bybitClient: RestClientV5 | undefined;
    if (!isSimulation && apiKey && apiSecret) {
      // Log API key info (first 8 chars for debugging, but don't log full key)
      const apiKeyPreview = apiKey.length > 8 ? `${apiKey.substring(0, 8)}...` : '***';
      
      // Demo trading uses api-demo.bybit.com endpoint (different from testnet)
      const baseUrl = demo ? 'https://api-demo.bybit.com' : undefined;
      const effectiveTestnet = testnet && !demo; // Don't use testnet if demo is enabled
      
      logger.info('Bybit client initialized', { 
        channel,
        accountName: accountName || 'default',
        testnet: effectiveTestnet,
        demo: demo,
        baseUrl: baseUrl || (effectiveTestnet ? 'api-testnet.bybit.com' : 'api.bybit.com'),
        apiKeyPreview,
        accountConfig: account ? {
          name: account.name,
          testnet: account.testnet,
          demo: account.demo,
          envVarNames: account.envVarNames
        } : null
      });
      
      bybitClient = new RestClientV5({ 
        key: apiKey, 
        secret: apiSecret, 
        testnet: effectiveTestnet,
        ...(baseUrl && { baseUrl }) // Use demo endpoint if demo mode
      });
    }

    let balance = 10000; // Default simulation balance
    
    if (!isSimulation && bybitClient) {
      // Get account balance to calculate position size
      const accountInfo = await bybitClient.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
      const account = accountInfo.result?.list?.[0];
      const usdtCoin = account?.coin?.find((c: any) => c.coin === 'USDT');
      balance = parseFloat(usdtCoin?.walletBalance || usdtCoin?.availableToWithdraw || '0');
      
      if (balance === 0) {
        logger.warn('Zero balance available', { channel });
        return;
      }
    } else if (isSimulation) {
      logger.info('Simulation mode: Using default balance', { balance, channel });
    }

    // Convert trading pair to Bybit format (e.g., BTCUSDT or BTCUSDC)
    // Ensure symbol always ends with USDT or USDC
    let symbol = order.tradingPair.replace('/', '').toUpperCase();
    if (!symbol.endsWith('USDT') && !symbol.endsWith('USDC')) {
      symbol = symbol + 'USDT'; // Default to USDT
    }
    
    // Validate symbol exists before creating trade
    // Validation will try both USDT and USDC if needed
    if (!isSimulation && bybitClient) {
      // Log symbol validation attempt - critical for investigations
      logger.info('Validating symbol before trade creation', {
        channel,
        messageId: message.message_id,
        tradingPair: order.tradingPair,
        symbol,
        accountName: accountName || 'default'
      });

      const validation = await validateBybitSymbol(bybitClient, symbol);
      if (!validation.valid) {
        logger.error('Invalid symbol, skipping trade', {
          channel,
          messageId: message.message_id,
          symbol,
          tradingPair: order.tradingPair,
          signalType: order.signalType,
          accountName: accountName || 'default',
          error: validation.error,
          reason: 'Symbol validation failed - symbol does not exist or is not trading on Bybit'
        });
        throw new Error(`Invalid symbol: ${validation.error}`);
      }
      // Use the actual symbol found (might be USDC if USDT doesn't exist, or asset variant like SHIB1000 instead of 1000SHIB)
      if (validation.actualSymbol && validation.actualSymbol !== symbol) {
        symbol = validation.actualSymbol;
        logger.info('Using alternative symbol format', {
          channel,
          messageId: message.message_id,
          originalSymbol: order.tradingPair.replace('/', ''),
          actualSymbol: symbol,
          tradingPair: order.tradingPair,
          accountName: accountName || 'default',
          reason: symbol.endsWith('USDC') && !order.tradingPair.includes('USDC') 
            ? 'alternative quote currency' 
            : 'asset variant'
        });
      }
      logger.info('Symbol validated successfully', {
        channel,
        messageId: message.message_id,
        originalTradingPair: order.tradingPair,
        normalizedSymbol: symbol,
        accountName: accountName || 'default'
      });
    }
    
    // Check for existing open positions for the same symbol to prevent multiple positions
    // This ensures stop loss always applies to 100% of the position
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
        existingTradeStatus: existingTradeForSymbol.status,
        existingTradeCreatedAt: existingTradeForSymbol.created_at,
        reason: 'Prevents multiple positions for same symbol - stop loss applies to 100% of position'
      });
      // Mark message as parsed to avoid reprocessing
      await db.markMessageParsed(message.id);
      return;
    }
    
    // Determine side (Buy for long, Sell for short)
    const side = order.signalType === 'long' ? 'Buy' : 'Sell';
    
    // For market orders (entry price missing), we need to get current price first
    // We'll convert these to limit orders at current price for predictable cost
    let entryPrice: number | undefined = order.entryPrice;
    const isUsingMarketPrice = !entryPrice || entryPrice <= 0;
    
    if (isUsingMarketPrice) {
      if (!isSimulation && bybitClient) {
        try {
          const ticker = await bybitClient.getTickers({ category: 'linear', symbol });
          if (ticker.retCode === 0 && ticker.result && ticker.result.list && ticker.result.list.length > 0 && ticker.result.list[0]?.lastPrice) {
            entryPrice = parseFloat(ticker.result.list[0].lastPrice);
            logger.info('Using current market price for limit order entry', { symbol, entryPrice });
          }
        } catch (error) {
          logger.warn('Failed to get market price', {
            symbol,
            ...serializeError(error)
          });
        }
      }
      // Fallback: use a default or throw error
      if (!entryPrice || entryPrice <= 0) {
        throw new Error(`Cannot calculate position size: entry price is required for ${symbol}`);
      }
    }

    // At this point, entryPrice is guaranteed to be a number (either from order or fetched from market)
    // TypeScript doesn't know this, so we assert it
    if (!entryPrice || entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }
    const finalEntryPrice: number = entryPrice;

    // Validate trade prices before proceeding (safety net - parsers should have validated already)
    // Only validate strictly when using the original parsed entry price.
    // For market orders, skip strict validation since TP/SL were parsed relative to the original signal entry,
    // not the current market price which may have moved.
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
    } else {
      // For orders originally specified as market (now converted to limit at current price),
      // do a lenient validation - just check that prices are positive and reasonable
      // The actual validation will happen when the position is opened and we know the fill price
      logger.debug('Skipping strict validation for limit order at current market price - will validate after fill', {
        channel,
        symbol,
        entryPrice: finalEntryPrice,
        originalEntryPrice: order.entryPrice
      });
    }

    // Use baseLeverage as default if leverage is not specified in order
    const baseLeverage = context.config.baseLeverage;
    // Start with effective leverage, but may be adjusted if position limit error occurs
    let effectiveLeverage = order.leverage > 0 ? order.leverage : (baseLeverage || 1);
    
    // Calculate position size based on risk percentage
    const positionSize = calculatePositionSize(
      balance,
      riskPercentage,
      finalEntryPrice,
      order.stopLoss,
      effectiveLeverage,
      baseLeverage
    );
    
    // Get precision info from exchange symbol info
    let decimalPrecision = 2; // default fallback for quantity
    let pricePrecision: number | undefined = undefined;
    let tickSize: number | undefined = undefined;
    let minOrderQty: number | undefined = undefined;
    let maxOrderQty: number | undefined = undefined;
    let qtyStep: number | undefined = undefined;
    
    if (bybitClient) {
      const symbolInfo = await getSymbolInfo(bybitClient, symbol);
      logger.debug('Retrieved symbol info from Bybit', {
        channel,
        symbol,
        symbolInfo
      });
      if (symbolInfo?.qtyPrecision !== undefined) {
        decimalPrecision = symbolInfo.qtyPrecision;
      } else if (finalEntryPrice > 0 && positionSize > 0) {
        // Fallback: 2 decimal places lower than first significant digit of risk amount in asset
        const riskAmountInAsset = positionSize / finalEntryPrice;
        decimalPrecision = getQuantityPrecisionFromRiskAmount(riskAmountInAsset);
      }
      pricePrecision = symbolInfo?.pricePrecision;
      tickSize = symbolInfo?.tickSize;
      minOrderQty = symbolInfo?.minOrderQty;
      maxOrderQty = symbolInfo?.maxOrderQty;
      qtyStep = symbolInfo?.qtyStep;
    } else if (finalEntryPrice > 0 && positionSize > 0) {
      const riskAmountInAsset = positionSize / finalEntryPrice;
      decimalPrecision = getQuantityPrecisionFromRiskAmount(riskAmountInAsset);
      pricePrecision = getDecimalPrecision(finalEntryPrice);
    }
    
    // Fallback: if pricePrecision is 0 but price has decimal places, calculate from price
    // This handles cases where tickSize is an integer (e.g., 1) but price is fractional
    // Also handle case where tickSize exists but is larger than the price (invalid)
    if (pricePrecision === 0 && finalEntryPrice > 0) {
      const priceHasDecimals = finalEntryPrice % 1 !== 0;
      // If tickSize is undefined or larger than price, use price's precision
      if (priceHasDecimals && (!tickSize || tickSize > finalEntryPrice)) {
        pricePrecision = getDecimalPrecision(finalEntryPrice);
        // If tickSize is invalid (larger than price), clear it so roundPrice uses precision instead
        if (tickSize && tickSize > finalEntryPrice) {
          tickSize = undefined;
        }
        logger.warn('Adjusted pricePrecision from price value', {
          channel,
          symbol,
          originalPricePrecision: 0,
          adjustedPricePrecision: pricePrecision,
          entryPrice: finalEntryPrice,
          tickSize: tickSize || 'undefined'
        });
      }
    }
    
    // Round entry price to exchange precision
    const roundedEntryPrice = roundPrice(finalEntryPrice, pricePrecision, tickSize);
    
    // Validate rounded entry price is valid (must be > 0)
    if (!roundedEntryPrice || roundedEntryPrice <= 0 || !isFinite(roundedEntryPrice)) {
      // Log all relevant parameters before throwing error for debugging
      logger.error('Invalid rounded entry price - logging all parameters', {
        channel,
        symbol,
        accountName,
        roundedEntryPrice,
        originalEntryPrice: finalEntryPrice,
        pricePrecision,
        tickSize,
        symbolInfo: {
          qtyPrecision: decimalPrecision,
          pricePrecision,
          tickSize,
          minOrderQty,
          maxOrderQty,
          qtyStep
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
    
    // Round quantity to nearest qty_step if specified (required by Bybit)
    // If qtyStep is not available, infer it from decimalPrecision (e.g., precision 2 -> step 0.01)
    const effectiveQtyStep = qtyStep !== undefined && qtyStep > 0 
      ? qtyStep 
      : Math.pow(10, -decimalPrecision);
    
    if (effectiveQtyStep > 0) {
      const qtyBeforeStep = qty;
      qty = Math.floor(qty / effectiveQtyStep) * effectiveQtyStep;
      // Ensure we don't round to zero
      if (qty === 0 && positionSize > 0) {
        qty = effectiveQtyStep;
      }
      logger.debug('Rounded quantity to qty_step', {
        channel,
        symbol,
        qtyBeforeStep,
        qtyAfterStep: qty,
        qtyStep: effectiveQtyStep,
        qtyStepFromAPI: qtyStep
      });
    }
    
    // Ensure quantity meets minimum order size requirement
    if (minOrderQty !== undefined && qty < minOrderQty) {
      logger.warn('Quantity below minimum order size, adjusting', {
        channel,
        symbol,
        calculatedQty: qty,
        minOrderQty,
        positionSize,
        qtyStep: effectiveQtyStep
      });
      // Round up to nearest qty_step above minOrderQty
      qty = Math.ceil(minOrderQty / effectiveQtyStep) * effectiveQtyStep;
    }
    
    // Cap quantity to maximum order size if it exceeds the limit
    if (maxOrderQty !== undefined && qty > maxOrderQty) {
      const qtyBeforeCap = qty;
      // Round down to nearest qty_step below maxOrderQty
      qty = Math.floor(maxOrderQty / effectiveQtyStep) * effectiveQtyStep;
      
      // Recalculate position size based on capped quantity for accurate logging
      const cappedPositionSize = qty * roundedEntryPrice;
      
      logger.warn('Quantity exceeds maximum order size, capping to max', {
        channel,
        symbol,
        qtyBeforeCap,
        qtyAfterCap: qty,
        maxOrderQty,
        originalPositionSize: positionSize,
        cappedPositionSize,
        qtyStep: effectiveQtyStep,
        note: 'Stop loss and take profit prices remain unchanged, but quantities are based on capped quantity'
      });
    }
    
    // Final validation: ensure quantity is valid (positive, non-zero, and finite)
    if (!isFinite(qty) || qty <= 0) {
      throw new Error(`Invalid quantity calculated: ${qty} (positionSize: ${positionSize}, entryPrice: ${roundedEntryPrice}, qtyStep: ${effectiveQtyStep})`);
    }

    // Format quantity string with proper precision (remove trailing zeros, ensure correct decimal places)
    const formatQuantity = (quantity: number, precision: number): string => {
      // Validate quantity is finite before formatting (prevents "Infinity" string)
      if (!isFinite(quantity) || quantity <= 0) {
        throw new Error(`Cannot format invalid quantity: ${quantity}`);
      }
      // If qtyStep is specified, quantity should already be rounded to qtyStep
      // Just format it with the correct precision without additional rounding
      // Format to string with exact precision, removing trailing zeros
      const formatted = quantity.toFixed(precision);
      // Remove trailing zeros after decimal point
      return formatted.replace(/\.?0+$/, '');
    };

    // Round stop loss to exchange precision
    const roundedStopLoss = order.stopLoss && order.stopLoss > 0 
      ? roundPrice(order.stopLoss, pricePrecision, tickSize)
      : order.stopLoss;

    // Validate quantity is finite before formatting (prevents "Infinity" string)
    if (!isFinite(qty)) {
      throw new Error(`Quantity is not finite: ${qty} (positionSize: ${positionSize}, entryPrice: ${roundedEntryPrice})`);
    }
    
    const qtyString = formatQuantity(qty, decimalPrecision);
    
    logger.info('Calculated trade parameters', {
      channel,
      symbol,
      side,
      qty,
      qtyString,
      entryPrice: roundedEntryPrice,
      originalEntryPrice: finalEntryPrice,
      stopLoss: roundedStopLoss,
      leverage: effectiveLeverage,
      baseLeverage,
      decimalPrecision,
      pricePrecision,
      minOrderQty,
      maxOrderQty,
      qtyStep,
      positionSize
    });

    // Determine if this was originally a market order (entry price missing)
    // Even though we convert it to a limit order at current price, we keep this flag
    // for TP placement logic (immediate execution vs waiting for fill)
    const isMarketOrder = !order.entryPrice || order.entryPrice <= 0;
    // Convert market orders to limit orders at current price for predictable cost
    const orderType = 'Limit';
    
    // Declare tradeId early so it's available throughout the function
    let tradeId: number | undefined;
    
    // Final validation before creating order params: ensure price is valid
    if (!roundedEntryPrice || roundedEntryPrice <= 0 || !isFinite(roundedEntryPrice)) {
      throw new Error(`Cannot create order: invalid price ${roundedEntryPrice} for symbol ${symbol}`);
    }
    
    // Using Bybit Futures API (linear perpetuals)
    // Create order at entry price (limit order, even if originally market)
    const orderParams: any = {
      category: 'linear',
      symbol: symbol,
      side: side,
      orderType: orderType,
      qty: qtyString,
      // Use IOC for immediate execution (fills immediately if price is at or better, otherwise cancels)
      // This provides predictable cost while still executing quickly
      timeInForce: isMarketOrder ? 'IOC' : 'GTC',
      reduceOnly: false,
      closeOnTrigger: false,
      positionIdx: 0,
      // Always add price for limit orders (use rounded price)
      price: roundedEntryPrice.toString(),
    };

    // Add stop loss to initial order if available (Bybit supports this) - use rounded price
    if (roundedStopLoss && roundedStopLoss > 0) {
      orderParams.stopLoss = roundedStopLoss.toString();
    }
    
    // Log entry order parameters before sending to Bybit
    logger.debug('Entry order parameters being sent to Bybit', {
      channel,
      symbol,
      orderParams: JSON.stringify(orderParams, null, 2),
      orderParamsFormatted: orderParams
    });

    let orderId: string | null = null;
    // Collect TP order IDs for storage
    const tpOrderIds: Array<{ index: number; orderId: string; price: number; quantity: number; tpIndex?: number }> = [];
    
    // Round TP prices to exchange precision (declare early for use in trade storage)
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
          originalTPs: order.takeProfits,
          roundedTPs: order.takeProfits.map(tpPrice => 
            roundPrice(tpPrice, pricePrecision, tickSize)
          )
        });
      } else if (roundedTPPrices.length < order.takeProfits.length) {
        logger.info('Removed duplicate TP prices after rounding', {
          channel,
          symbol,
          originalCount: order.takeProfits.length,
          deduplicatedCount: roundedTPPrices.length,
          originalTPs: order.takeProfits,
          deduplicatedTPs: roundedTPPrices
        });
      }
    }

    if (isSimulation) {
      // In simulation mode, generate a fake order ID
      orderId = `SIM-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      logger.info('Simulation mode: Simulated order placement', {
        channel,
        orderId,
        symbol,
        side,
        qty,
        price: finalEntryPrice
      });
    } else if (bybitClient) {
      // Proactively check position limits before placing order
      // Get current position and pending orders to calculate effective position value
      let currentPositionSize = 0;
      let pendingOrderSize = 0;
      
      try {
        // Get current position for this symbol
        const positionResponse = await bybitClient.getPositionInfo({
          category: 'linear',
          symbol: symbol
        });
        
        if (positionResponse.retCode === 0 && positionResponse.result?.list) {
          const positions = positionResponse.result.list.filter((p: any) => {
            const size = parseFloat(getBybitField<string>(p, 'size') || '0');
            return size !== 0;
          });
          
          if (positions.length > 0) {
            const position = positions[0];
            const size = parseFloat(getBybitField<string>(position, 'size') || '0');
            const avgPrice = parseFloat(getBybitField<string>(position, 'avgPrice') || '0');
            if (size !== 0 && avgPrice > 0) {
              currentPositionSize = Math.abs(size) * avgPrice;
            }
          }
        }
        
        // Get pending orders for this symbol
        const activeOrdersResponse = await bybitClient.getActiveOrders({
          category: 'linear',
          symbol: symbol
        });
        
        if (activeOrdersResponse.retCode === 0 && activeOrdersResponse.result?.list) {
          const pendingOrders = activeOrdersResponse.result.list.filter((o: any) => {
            const orderSide = getBybitField<string>(o, 'side');
            // Only count orders in the same direction as our new order
            return orderSide === side;
          });
          
          for (const order of pendingOrders) {
            const orderQty = parseFloat(getBybitField<string>(order, 'qty') || '0');
            const orderPrice = parseFloat(getBybitField<string>(order, 'price') || '0');
            if (orderQty > 0 && orderPrice > 0) {
              pendingOrderSize += orderQty * orderPrice;
            }
          }
        }
      } catch (error) {
        logger.debug('Could not fetch position/order info for limit check', {
          symbol,
          error: error instanceof Error ? error.message : String(error)
        });
        // Continue anyway - we'll rely on retry logic if needed
      }
      
      // Calculate effective position value (current + pending + new order)
      const effectivePositionValue = currentPositionSize + pendingOrderSize + positionSize;
      
      // Proactively check if position might exceed limits
      // Bybit's position limits are based on leverage and risk tiers
      // Higher leverage = lower max position size allowed at that leverage tier
      // As a conservative heuristic: if position size is very large relative to balance * leverage,
      // we should proactively reduce leverage to avoid hitting limits
      // Conservative estimate: max position ≈ balance * leverage * 0.5 (very conservative)
      const positionToBalanceRatio = balance > 0 ? effectivePositionValue / balance : 0;
      const conservativeMaxPosition = balance * effectiveLeverage * 0.5;
      
      if (effectivePositionValue > conservativeMaxPosition && effectiveLeverage > 1 && balance > 0) {
        // Calculate recommended leverage: if position is too large, reduce leverage
        // We want: effectivePositionValue <= balance * newLeverage * 0.5
        // So: newLeverage >= effectivePositionValue / (balance * 0.5)
        // Use floor to be conservative, but ensure it's at least 1
        const calculatedLeverage = effectivePositionValue / (balance * 0.5);
        const recommendedLeverage = Math.max(1, Math.floor(calculatedLeverage));
        
        if (recommendedLeverage < effectiveLeverage) {
          logger.warn('Proactively reducing leverage to avoid position limit error', {
            channel,
            symbol,
            currentLeverage: effectiveLeverage,
            recommendedLeverage,
            calculatedLeverage,
            currentPositionSize,
            pendingOrderSize,
            newOrderPositionSize: positionSize,
            effectivePositionValue,
            balance,
            positionToBalanceRatio,
            conservativeMaxPosition,
            note: 'This is a conservative estimate - actual limits may vary by symbol and market conditions'
          });
          
          effectiveLeverage = recommendedLeverage;
        }
      } else {
        logger.debug('Position limit check passed', {
          channel,
          symbol,
          leverage: effectiveLeverage,
          currentPositionSize,
          pendingOrderSize,
          newOrderPositionSize: positionSize,
          effectivePositionValue,
          balance,
          positionToBalanceRatio,
          conservativeMaxPosition
        });
      }
      
      // Set leverage first (use effective leverage, potentially adjusted)
      const leverageParams = {
        category: 'linear' as const,
        symbol: symbol,
        buyLeverage: effectiveLeverage.toString(),
        sellLeverage: effectiveLeverage.toString(),
      };
      try {
        await bybitClient.setLeverage(leverageParams);
        logger.info('Leverage set', { symbol, leverage: effectiveLeverage });
      } catch (error) {
        logger.warn('Failed to set leverage', {
          symbol,
          leverage: effectiveLeverage,
          parameters: leverageParams,
          ...serializeError(error)
        });
      }

      // Place the entry order with stop loss (if supported in initial order)
      // Handle position limit errors by reducing leverage and retrying
      let orderResponse: any;
      let retryCount = 0;
      const maxRetries = 1; // Only retry once with reduced leverage
      
      // Helper function to check if error is position limit error (110090)
      const isPositionLimitError = (responseOrError: any): boolean => {
        if (responseOrError?.retCode === 110090) {
          return true;
        }
        if (responseOrError instanceof Error) {
          return responseOrError.message.includes('110090') || 
                 responseOrError.message.includes('position may exceed the max. limit');
        }
        if (typeof responseOrError === 'string') {
          return responseOrError.includes('110090') || 
                 responseOrError.includes('position may exceed the max. limit');
        }
        return false;
      };
      
      // Helper function to parse recommended leverage from error message
      // Looks for patterns like "adjust your leverage to 19 or below" or "leverage to 4.9"
      // Supports both integer and decimal leverage values
      const parseRecommendedLeverage = (errorMessage: string): number | null => {
        if (!errorMessage) return null;
        
        // Try pattern: "adjust your leverage to X or below" (supports decimals like 4.9)
        let match = errorMessage.match(/adjust\s+your\s+leverage\s+to\s+([\d.]+)\s+or\s+below/i);
        if (match && match[1]) {
          return parseFloat(match[1]);
        }
        
        // Try pattern: "leverage to X or below" (supports decimals)
        match = errorMessage.match(/leverage\s+to\s+([\d.]+)\s+or\s+below/i);
        if (match && match[1]) {
          return parseFloat(match[1]);
        }
        
        // Try pattern: "to X or below" (more generic, supports decimals)
        match = errorMessage.match(/to\s+([\d.]+)\s+or\s+below/i);
        if (match && match[1]) {
          return parseFloat(match[1]);
        }
        
        // Try pattern: "leverage to X" (supports decimals)
        match = errorMessage.match(/leverage\s+to\s+([\d.]+)/i);
        if (match && match[1]) {
          return parseFloat(match[1]);
        }
        
        return null;
      };
      
      while (retryCount <= maxRetries) {
        try {
          orderResponse = await bybitClient.submitOrder(orderParams);
          
          // Check if order was successful
          if (orderResponse?.retCode === 0 && orderResponse?.result) {
            orderId = getBybitField<string>(orderResponse.result, 'orderId', 'order_id') || 'unknown';
            if (orderId && orderId !== 'unknown') {
              break; // Success, exit retry loop
            }
          }
          
          // Check for position limit error (110090)
          if (isPositionLimitError(orderResponse)) {
            const errorMsg = orderResponse?.retMsg || orderResponse?.message || '';
            const recommendedLeverage = parseRecommendedLeverage(errorMsg);
            
            logger.warn('Position limit error detected, attempting to reduce leverage', {
              channel,
              symbol,
              retCode: orderResponse?.retCode || 110090,
              retMsg: errorMsg,
              currentLeverage: effectiveLeverage,
              recommendedLeverage,
              retryCount
            });
            
            // Reduce leverage to recommended value or below (as suggested by Bybit)
            if (recommendedLeverage !== null && effectiveLeverage > recommendedLeverage) {
              const newLeverage = recommendedLeverage;
              logger.info('Reducing leverage to comply with position limit', {
                channel,
                symbol,
                oldLeverage: effectiveLeverage,
                newLeverage,
                recommendedByExchange: true
              });
              
              effectiveLeverage = newLeverage;
              
              // Update leverage on exchange
              const reducedLeverageParams = {
                category: 'linear' as const,
                symbol: symbol,
                buyLeverage: effectiveLeverage.toString(),
                sellLeverage: effectiveLeverage.toString(),
              };
              try {
                await bybitClient.setLeverage(reducedLeverageParams);
                logger.info('Leverage reduced and set on exchange', { 
                  symbol, 
                  leverage: effectiveLeverage 
                });
              } catch (leverageError) {
                logger.warn('Failed to set reduced leverage', {
                  symbol,
                  leverage: effectiveLeverage,
                  parameters: reducedLeverageParams,
                  ...serializeError(leverageError)
                });
                // Continue anyway - might still work
              }
              
              retryCount++;
              continue; // Retry with reduced leverage
            } else if (recommendedLeverage === null) {
              // Could not parse recommended leverage from error message
              logger.error('Position limit error but could not parse recommended leverage', {
                channel,
                symbol,
                errorMsg,
                currentLeverage: effectiveLeverage,
                parameters: orderParams
              });
              throw new Error(`Order placement failed: ${JSON.stringify(orderResponse)}`);
            } else {
              // Leverage already <= recommended value, but still getting error
              // This might be a position size issue, throw error
              logger.error('Position limit error but leverage already at or below recommended value', {
                channel,
                symbol,
                currentLeverage: effectiveLeverage,
                recommendedLeverage,
                parameters: orderParams
              });
              throw new Error(`Order placement failed: ${JSON.stringify(orderResponse)}`);
            }
          } else {
            // Other error, throw immediately
            logger.error('Order placement failed with error', {
              channel,
              symbol,
              parameters: orderParams,
              response: orderResponse
            });
            throw new Error(`Order placement failed: ${JSON.stringify(orderResponse)}`);
          }
        } catch (error) {
          // Check if this is a position limit error that we can retry
          if (isPositionLimitError(error) && retryCount < maxRetries) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const recommendedLeverage = parseRecommendedLeverage(errorMsg);
            
            // Position limit error, reduce leverage and retry
            if (recommendedLeverage !== null && effectiveLeverage > recommendedLeverage) {
              logger.warn('Position limit error caught, reducing leverage and retrying', {
                channel,
                symbol,
                currentLeverage: effectiveLeverage,
                recommendedLeverage,
                error: errorMsg
              });
              
              effectiveLeverage = recommendedLeverage;
              
              // Update leverage on exchange
              const retryLeverageParams = {
                category: 'linear' as const,
                symbol: symbol,
                buyLeverage: effectiveLeverage.toString(),
                sellLeverage: effectiveLeverage.toString(),
              };
              try {
                await bybitClient.setLeverage(retryLeverageParams);
                logger.info('Leverage reduced and set on exchange after error', { 
                  symbol, 
                  leverage: effectiveLeverage 
                });
              } catch (leverageError) {
                logger.warn('Failed to set reduced leverage after error', {
                  symbol,
                  leverage: effectiveLeverage,
                  parameters: retryLeverageParams,
                  ...serializeError(leverageError)
                });
                // Continue anyway - might still work
              }
              
              retryCount++;
              continue; // Retry with reduced leverage
            } else {
              // Could not parse recommended leverage or already at/below recommended
              logger.error('Position limit error but cannot reduce leverage further', {
                channel,
                symbol,
                currentLeverage: effectiveLeverage,
                recommendedLeverage,
                error: errorMsg,
                couldNotParse: recommendedLeverage === null,
                parameters: orderParams
              });
              throw error;
            }
          }
          
          // Re-throw error if not handled
          logger.error('Order placement error not handled by retry logic', {
            channel,
            symbol,
            parameters: orderParams,
            retryCount,
            ...serializeError(error)
          });
          throw error;
        }
      }
      
      // Final check - if orderId is still null after retries, throw error
      if (!orderId) {
        throw new Error(`Order placement failed after retries: ${JSON.stringify(orderResponse)}`);
      }

      // Insert trade record early so we can update it if needed (e.g., if we need to close position)
      const expiresAt = dayjs().add(entryTimeoutMinutes, 'minutes').toISOString();
      try {
        tradeId = await db.insertTrade({
          message_id: message.message_id,
          channel: channel,
          trading_pair: order.tradingPair,
          leverage: effectiveLeverage,
          entry_price: roundedEntryPrice,
          stop_loss: roundedStopLoss || order.stopLoss,
          take_profits: JSON.stringify(roundedTPPrices || order.takeProfits),
          risk_percentage: riskPercentage,
          quantity: qty,
          exchange: 'bybit',
          account_name: accountName || undefined,
          order_id: orderId,
          entry_order_type: 'limit', // Always limit order (market orders converted to limit at current price)
          direction: order.signalType,
          status: 'pending',
          stop_loss_breakeven: false,
          expires_at: expiresAt
        });
      } catch (error) {
        logger.warn('Failed to insert trade record early', {
          channel,
          symbol,
          orderId,
          error: error instanceof Error ? error.message : String(error)
        });
        // Continue anyway - we'll insert it later
      }

      // Verify stop loss was set, or set it separately if initial order didn't support it
      // Note: If Bybit accepted the stop loss in the initial order, it will be set when the position opens
      // For limit orders, we can't verify until position exists, so we'll set it separately if needed
      if (order.stopLoss && order.stopLoss > 0) {
        // Check if entry order has already filled (market orders or fast-filling limit orders)
        let entryFilled = false;
        try {
          const orderStatus = await bybitClient.getActiveOrders({
            category: 'linear',
            symbol: symbol,
            orderId: orderId
          });
          
          if (orderStatus.retCode === 0 && orderStatus.result) {
            const activeOrders = orderStatus.result.list || [];
            const isStillActive = activeOrders.some((o: any) => 
              getBybitField<string>(o, 'orderId', 'order_id') === orderId
            );
            entryFilled = !isStillActive;
          }
        } catch (error) {
          logger.debug('Could not check order status for stop loss verification', {
            symbol,
            orderId,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        // Only try to set stop loss if entry has filled (position exists)
        // If entry hasn't filled, Bybit will apply the stop loss from the initial order when position opens
        if (entryFilled) {
          const stopLossParams: any = {
            category: 'linear' as const,
            symbol: symbol,
            stopLoss: roundedStopLoss.toString(),
            positionIdx: 0 as 0 | 1 | 2,
            tpslMode: 'Full' // Apply stop loss to 100% of position automatically
          };
          
          try {
            logger.debug('Stop loss parameters being sent to Bybit (entry already filled)', {
              channel,
              symbol,
              stopLossParams: JSON.stringify(stopLossParams, null, 2),
              stopLossParamsFormatted: stopLossParams,
              roundedStopLoss,
              originalStopLoss: order.stopLoss
            });
            
            // Bybit's setTradingStop with tpslMode='Full' automatically applies to 100% of position
            await bybitClient.setTradingStop(stopLossParams);
            
            // Update stop loss order quantity in database for tracking
            // Bybit API automatically covers 100% of position, but we track quantity for consistency
            if (tradeId) {
              try {
                const orders = await db.getOrdersByTradeId(tradeId);
                const stopLossOrder = orders.find(o => o.order_type === 'stop_loss');
                if (stopLossOrder) {
                  await db.updateOrder(stopLossOrder.id, {
                    quantity: qty
                  });
                  logger.debug('Updated stop loss order quantity after setting on exchange', {
                    tradeId,
                    orderId: stopLossOrder.id,
                    quantity: qty
                  });
                }
              } catch (error) {
                logger.warn('Failed to update stop loss order quantity', {
                  tradeId,
                  error: error instanceof Error ? error.message : String(error)
                });
              }
            }
            
            logger.info('Stop loss verified/set', {
              symbol,
              stopLoss: roundedStopLoss
            });
          } catch (error) {
            // If stop loss fails but entry is filled, log warning but don't cancel
            // The monitor will handle setting stop loss if needed
            logger.warn('Failed to set stop loss after entry fill, monitor will retry', {
              symbol,
              stopLoss: order.stopLoss,
              parameters: stopLossParams,
              ...serializeError(error)
            });
          }
        } else {
          // Entry hasn't filled yet - Bybit should apply stop loss from initial order when position opens
          // If it doesn't, the monitor will set it after entry fills
          logger.debug('Entry order pending, stop loss will be applied when position opens', {
            symbol,
            orderId,
            stopLoss: roundedStopLoss
          });
        }
      }

      // Place take profit orders using batch placement if available
      // NOTE: For limit orders that may take hours/days to fill, TP orders are placed by the trade monitor
      // after the entry order fills. This prevents TP orders from being placed before a position exists.
      // Only place TP orders immediately if this was originally a market order (now limit with IOC, fills immediately)
      // (isMarketOrder already declared above)
      
      if (order.takeProfits && order.takeProfits.length > 0 && roundedTPPrices && isMarketOrder) {
        // For limit orders with IOC timeInForce (originally market orders), check if we have a position immediately and get position details
        let positionSide: 'Buy' | 'Sell' | null = null;
        let actualEntryPrice: number | undefined;
        let actualPositionQty: number | undefined;
        
        try {
          const positionResponse = await bybitClient.getPositionInfo({
            category: 'linear',
            symbol: symbol
          });
          
          if (positionResponse.retCode === 0 && positionResponse.result && positionResponse.result.list) {
            const positions = positionResponse.result.list.filter((p: any) => {
              const size = parseFloat(getBybitField<string>(p, 'size') || '0');
              return size !== 0;
            });
            
            if (positions.length > 0) {
              const position = positions[0];
              
              // Get position side
              if (position.side && (position.side === 'Buy' || position.side === 'Sell')) {
                positionSide = position.side as 'Buy' | 'Sell';
              } else {
                // Fallback: infer from size (for backward compatibility)
                const size = parseFloat(getBybitField<string>(position, 'size') || '0');
                positionSide = size > 0 ? 'Buy' : 'Sell';
                logger.debug('Position side not available, inferred from size', {
                  channel,
                  symbol,
                  inferredSide: positionSide,
                  size
                });
              }
              
              // Get actual entry price and position quantity
              const avgPrice = parseFloat(getBybitField<string>(position, 'avgPrice') || '0');
              const size = parseFloat(getBybitField<string>(position, 'size') || '0');
              if (avgPrice > 0) {
                actualEntryPrice = avgPrice;
              }
              if (size !== 0) {
                actualPositionQty = Math.abs(size);
              }
            }
          }
        } catch (error) {
          logger.debug('Could not check position for market order TP placement', {
            channel,
            symbol,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        if (positionSide) {
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
                existingTPCount: existingTPOrders.length,
                existingTPIndices: existingTPOrders.map(o => o.tp_index).filter(i => i !== undefined)
              });
              // Skip placing TP orders - they already exist
              // Note: tpOrderIds will remain empty, so we won't try to store duplicates later
              shouldPlaceTPOrders = false;
            }
          }
          
          if (shouldPlaceTPOrders) {
            // No existing TP orders, proceed with placement
            
            // Step 1: Validate with current market price first (already done earlier)
            // Step 2: Validate with actual entry fill price from position
            
            // Use actual entry price if available, otherwise fall back to finalEntryPrice
            const entryPriceForValidation = actualEntryPrice || finalEntryPrice;
            
            // Step 3: Validate TP prices against actual entry fill price
            // Filter out invalid TPs and recalculate quantities if needed
            let validTPPrices = [...roundedTPPrices];
            let validTPIndices: number[] = [];
            
            // Check each TP price against entry price
            validTPPrices.forEach((tpPrice, index) => {
              const isValid = order.signalType === 'long' 
                ? tpPrice > entryPriceForValidation 
                : tpPrice < entryPriceForValidation;
              
              if (isValid) {
                validTPIndices.push(index);
              }
            });
            
            // Filter to only valid TPs
            validTPPrices = validTPPrices.filter((tpPrice, index) => {
              return order.signalType === 'long' 
                ? tpPrice > entryPriceForValidation 
                : tpPrice < entryPriceForValidation;
            });
            
            if (validTPPrices.length < roundedTPPrices.length) {
              const removedCount = roundedTPPrices.length - validTPPrices.length;
              logger.warn('Some TP prices invalid relative to actual entry fill price - removing invalid TPs', {
                channel,
                symbol,
                entryPriceForValidation,
                actualEntryPrice,
                finalEntryPrice,
                originalTPs: roundedTPPrices,
                validTPs: validTPPrices,
                removedCount,
                signalType: order.signalType
              });
            }
            
            // Step 4: If no valid TPs remain, close the position
            if (validTPPrices.length === 0) {
              logger.error('No valid TP prices relative to actual entry fill price - closing position', {
                channel,
                symbol,
                entryPriceForValidation,
                actualEntryPrice,
                finalEntryPrice,
                originalTPs: roundedTPPrices,
                stopLoss: order.stopLoss,
                signalType: order.signalType,
                note: 'All TP prices were invalid, closing position immediately'
              });
              
              // Close the position using reduce-only market order
              if (!isSimulation && bybitClient && actualPositionQty) {
                const closeSide = order.signalType === 'long' ? 'Sell' : 'Buy';
                const closeOrderParams = {
                  category: 'linear' as const,
                  symbol: symbol,
                  side: closeSide as 'Buy' | 'Sell',
                  orderType: 'Market' as const,
                  qty: actualPositionQty.toString(),
                  timeInForce: 'IOC' as const,
                  reduceOnly: true,
                  closeOnTrigger: false
                };
                try {
                  const closeOrder = await bybitClient.submitOrder(closeOrderParams);
                  
                  if (closeOrder.retCode === 0 && closeOrder.result) {
                    const closeOrderId = getBybitField<string>(closeOrder.result, 'orderId', 'order_id') || 'unknown';
                    logger.info('Position closed due to invalid TP prices', {
                      channel,
                      symbol,
                      tradeId,
                      entryOrderId: orderId,
                      closeOrderId
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
                          tradeId,
                          error: error instanceof Error ? error.message : String(error)
                        });
                      }
                    }
                    
                    // Don't place TP orders - position is already closed
                    return;
                  } else {
                    throw new Error(`Failed to close position: ${JSON.stringify(closeOrder)}`);
                  }
                } catch (error) {
                  logger.error('Failed to close position with invalid TPs', {
                    channel,
                    symbol,
                    tradeId,
                    orderId,
                    parameters: closeOrderParams,
                    error: error instanceof Error ? error.message : String(error)
                  });
                  throw error;
                }
              } else {
                // Simulation mode - mark trade as closed
                if (tradeId) {
                  try {
                    await db.updateTrade(tradeId, {
                      status: 'closed',
                      exit_filled_at: dayjs().toISOString()
                    });
                  } catch (error) {
                    logger.warn('Could not update trade status in simulation', {
                      channel,
                      symbol,
                      tradeId,
                      error: error instanceof Error ? error.message : String(error)
                    });
                  }
                }
                logger.info('Simulated position close due to invalid TP prices', {
                  channel,
                  symbol,
                  tradeId
                });
                return;
              }
            }
            
            // Step 5: Deduplicate valid TP prices (in case validation didn't catch duplicates)
            const deduplicatedValidTPs = deduplicateTakeProfits(validTPPrices, order.signalType);
            
            // Step 6: Recalculate TP quantities for remaining valid TPs
            // Use the deduplicated valid TP prices and recalculate quantities
            roundedTPPrices = deduplicatedValidTPs;
            
            if (deduplicatedValidTPs.length < validTPPrices.length) {
              logger.info('Removed duplicate TP prices after validation', {
                channel,
                symbol,
                beforeDedupCount: validTPPrices.length,
                afterDedupCount: deduplicatedValidTPs.length,
                removedCount: validTPPrices.length - deduplicatedValidTPs.length
              });
            }
            
            logger.info('Using filtered TP prices after validation', {
              channel,
              symbol,
              originalTPCount: order.takeProfits.length,
              validTPCount: roundedTPPrices.length,
              validTPPrices: roundedTPPrices
            });
          
            // Verify position side matches expected side
            const expectedPositionSide = order.signalType === 'long' ? 'Buy' : 'Sell';
          if (positionSide !== expectedPositionSide) {
            logger.error('Position side mismatch', {
              channel,
              symbol,
              orderId,
              expectedPositionSide,
              actualPositionSide: positionSide,
              note: 'TP orders may fail due to side mismatch'
            });
          }

            // Distribute quantity evenly across remaining valid TPs (last TP rounded up)
            const tpQuantities = distributeQuantityAcrossTPs(
              qty,
              validTPPrices.length, // Use filtered count, not original
              decimalPrecision
            );

            // Validate and redistribute TP quantities (handles qtyStep rounding, minOrderQty, maxOrderQty, and redistribution)
            // Note: Last TP will use remaining quantity to ensure full position coverage (exchange determines final size)
            const validTPOrders = validateAndRedistributeTPQuantities(
              tpQuantities,
              roundedTPPrices,
              qty,
              qtyStep,
              minOrderQty,
              maxOrderQty,
              decimalPrecision
            );
            
            // Log that last TP uses remaining quantity (similar to SL with tpslMode='Full')
            if (validTPOrders.length > 0) {
              const lastTP = validTPOrders[validTPOrders.length - 1];
              const allocatedQty = validTPOrders.slice(0, -1).reduce((sum, tp) => sum + tp.quantity, 0);
              const remainingQty = qty - allocatedQty;
              logger.info('Last TP order uses remaining quantity to close entire position', {
                channel,
                symbol,
                lastTPIndex: lastTP.index,
                lastTPQuantity: lastTP.quantity,
                remainingQuantity: remainingQty,
                totalPositionQty: qty,
                allocatedQty,
                note: 'Bybit will automatically adjust last TP quantity to match available position size when executing (similar to SL with tpslMode=Full)'
              });
            }

            // Log redistribution if fewer TPs than expected
            if (validTPOrders.length < order.takeProfits.length) {
              const skippedCount = order.takeProfits.length - validTPOrders.length;
              const skippedIndices: number[] = [];
              const validIndices = validTPOrders.map(tp => tp.index);
              for (let i = 1; i <= order.takeProfits.length; i++) {
                if (!validIndices.includes(i)) {
                  skippedIndices.push(i);
                }
              }
              
              if (skippedIndices.length > 0 && validTPOrders.length > 0) {
                logger.info('Redistributed skipped TP quantities to remaining TPs', {
                  channel,
                  symbol,
                  skippedTPs: skippedIndices,
                  redistributedTo: validIndices
                });
              }
              
              logger.warn('Placing fewer TP orders than expected due to quantity constraints', {
                channel,
                symbol,
                expectedTPs: order.takeProfits.length,
                actualTPs: validTPOrders.length,
                skipped: skippedCount,
                note: 'Some portion of the position may not have TP orders'
              });
            }

            // Log fallback usage for any TP orders that used minOrderQty
            for (const tpOrder of validTPOrders) {
              const originalQty = tpQuantities[tpOrder.index - 1];
              const effectiveQtyStep = qtyStep !== undefined && qtyStep > 0 ? qtyStep : Math.pow(10, -decimalPrecision);
              const roundedQty = Math.floor(originalQty / effectiveQtyStep) * effectiveQtyStep;
              if (tpOrder.quantity === minOrderQty && (roundedQty === 0 || (minOrderQty !== undefined && minOrderQty > 0 && roundedQty < minOrderQty))) {
                logger.warn('Using minimum order quantity as fallback for TP order', {
                  channel,
                  symbol,
                  tpIndex: tpOrder.index,
                  tpPrice: tpOrder.price,
                  originalQty: roundedQty,
                  minOrderQty,
                  note: 'Bybit will adjust quantity to available position size if needed'
                });
              }
            }

            if (validTPOrders.length === 0) {
              logger.error('No valid TP orders to place - all quantities are zero or below minimum', {
                channel,
                symbol,
                qty,
                numTPs: order.takeProfits.length,
                minOrderQty
              });
              // Don't throw error - let the monitor handle TP placement later
              logger.warn('TP orders will be placed by monitor after entry fills', {
                channel,
                symbol,
                orderId
              });
            }

            // Determine opposite side for TP orders based on actual position side
            // For a Long position (Buy side), TP is Sell
            // For a Short position (Sell side), TP is Buy
            const tpSide = positionSide === 'Buy' ? 'Sell' : 'Buy';

            // Prepare batch order requests using only valid TP orders
            // Always use reduceOnly=true since we have a confirmed position
            const batchOrders = validTPOrders.map((tpOrder) => ({
            category: 'linear' as const,
            symbol: symbol,
            side: tpSide as 'Buy' | 'Sell',
            orderType: 'Limit' as const,
            qty: formatQuantity(tpOrder.quantity, decimalPrecision),
            price: tpOrder.price.toString(),
            timeInForce: 'GTC' as const,
            reduceOnly: true, // Always reduce-only since we have a position
              closeOnTrigger: false,
              positionIdx: 0 as 0 | 1 | 2,
            }));

            // Log TP order parameters before sending to Bybit
            logger.debug('Take profit orders parameters being sent to Bybit', {
            channel,
            symbol,
            positionSide,
            tpSide,
            numTPs: batchOrders.length,
            expectedTPs: order.takeProfits.length,
            batchOrders: JSON.stringify(batchOrders, null, 2),
            batchOrdersFormatted: batchOrders.map((order, i) => ({
              index: validTPOrders[i].index,
              ...order,
                tpPrice: validTPOrders[i].price,
                tpQty: validTPOrders[i].quantity
              }))
            });

            // Try batch placement first (more atomic)
            let batchSuccess = false;
            const batchRequestParams = {
              category: 'linear',
              request: batchOrders
            };
            try {
              // Check if batchPlaceOrder method exists
              if (typeof (bybitClient as any).batchPlaceOrder === 'function') {
              logger.debug('Batch take profit orders request parameters being sent to Bybit', {
                channel,
                symbol,
                batchRequestParams: JSON.stringify(batchRequestParams, null, 2),
                batchRequestParamsFormatted: batchRequestParams
              });
              
              const batchResponse = await (bybitClient as any).batchPlaceOrder(batchRequestParams);

              if (batchResponse.retCode === 0 && batchResponse.result && batchResponse.result.list && Array.isArray(batchResponse.result.list)) {
                batchSuccess = true;
                // Collect order IDs from batch response
                batchResponse.result.list.forEach((result: any, i: number) => {
                  const orderId = getBybitField<string>(result, 'orderId', 'order_id');
                  if (orderId && i < validTPOrders.length) {
                    tpOrderIds.push({
                      index: validTPOrders[i].index - 1, // Convert to 0-based for array compatibility
                      orderId: orderId,
                      price: validTPOrders[i].price,
                      quantity: validTPOrders[i].quantity,
                      tpIndex: validTPOrders[i].index // Store 1-based TP index for database
                    });
                  }
                });
                logger.info('Take profit orders placed via batch', {
                  symbol,
                  numTPs: validTPOrders.length,
                  expectedTPs: order.takeProfits.length,
                  orderIds: tpOrderIds.map(tp => tp.orderId)
                });
              } else {
                logger.warn('Batch TP order placement failed, falling back to individual orders', {
                  symbol,
                  parameters: batchRequestParams,
                  error: JSON.stringify(batchResponse)
                });
              }
            }
          } catch (batchError) {
            logger.warn('Batch placement not available or failed, using individual orders', {
              symbol,
              parameters: batchRequestParams,
              error: batchError instanceof Error ? batchError.message : String(batchError)
            });
            }

            // Fallback to individual orders if batch failed or not available
            if (!batchSuccess) {
            let tpSuccessCount = 0;
            const tpErrors: Array<{ index: number; error: string }> = [];

            for (let i = 0; i < validTPOrders.length; i++) {
              const tpOrder = validTPOrders[i];

              try {
                // Log individual TP order parameters before sending
                logger.debug('Individual take profit order parameters being sent to Bybit', {
                  channel,
                  symbol,
                  tpIndex: tpOrder.index,
                  orderParams: JSON.stringify(batchOrders[i], null, 2),
                  orderParamsFormatted: batchOrders[i],
                  tpPrice: tpOrder.price,
                  tpQty: tpOrder.quantity
                });
                
                const tpOrderResponse = await bybitClient.submitOrder(batchOrders[i]);

                if (tpOrderResponse.retCode === 0 && tpOrderResponse.result) {
                  tpSuccessCount++;
                  const tpOrderId = getBybitField<string>(tpOrderResponse.result, 'orderId', 'order_id');
                  if (tpOrderId) {
                    tpOrderIds.push({
                      index: tpOrder.index - 1, // Convert to 0-based for array compatibility
                      orderId: tpOrderId,
                      price: tpOrder.price,
                      quantity: tpOrder.quantity,
                      tpIndex: tpOrder.index // Store 1-based TP index for database
                    });
                  }
                  logger.info('Take profit order placed', {
                    symbol,
                    tpIndex: tpOrder.index,
                    tpPrice: tpOrder.price,
                    tpQty: tpOrder.quantity,
                    tpOrderId
                  });
                } else {
                  tpErrors.push({
                    index: tpOrder.index,
                    error: JSON.stringify(tpOrderResponse)
                  });
                  logger.warn('Failed to place take profit order', {
                    symbol,
                    tpIndex: tpOrder.index,
                    tpPrice: tpOrder.price,
                    tpQty: tpOrder.quantity,
                    parameters: batchOrders[i],
                    error: JSON.stringify(tpOrderResponse)
                  });
                }
                } catch (error) {
                const serialized = serializeError(error);
                tpErrors.push({
                  index: tpOrder.index,
                  error: serialized.error
                });
                logger.warn('Error placing take profit order', {
                  symbol,
                  tpIndex: tpOrder.index,
                  tpPrice: tpOrder.price,
                  tpQty: tpOrder.quantity,
                  parameters: batchOrders[i],
                  ...serializeError(error)
                });
              }
            }

            // If all TP orders failed, consider cancelling entry order
            if (tpSuccessCount === 0 && validTPOrders.length > 0) {
              logger.error('All take profit orders failed', {
                symbol,
                orderId,
                errors: tpErrors
              });
              // Try to cancel entry order if still pending
              try {
                const orderStatus = await bybitClient.getActiveOrders({
                  category: 'linear',
                  symbol: symbol,
                  orderId: orderId
                });
                if (orderStatus.retCode === 0 && orderStatus.result && orderStatus.result.list && orderStatus.result.list.length > 0) {
                  await bybitClient.cancelOrder({
                    category: 'linear',
                    symbol: symbol,
                    orderId: orderId
                  });
                  logger.warn('Cancelled entry order due to all TP orders failing', {
                    symbol,
                    orderId
                  });
                  throw new Error('Entry order cancelled: all take profit orders failed');
                }
              } catch (cancelError) {
                // Order may already be filled, log warning but continue
                logger.warn('Could not cancel entry order (may already be filled)', {
                  symbol,
                  orderId,
                  error: cancelError instanceof Error ? cancelError.message : String(cancelError)
                });
              }
            } else if (tpSuccessCount < validTPOrders.length) {
              logger.warn('Some take profit orders failed', {
                symbol,
                orderId,
                successful: tpSuccessCount,
                attempted: validTPOrders.length,
                expected: order.takeProfits.length,
                errors: tpErrors
              });
            }
            }
          } // End of if (shouldPlaceTPOrders) block
        } else {
          logger.info('Limit order (IOC) placed but no position detected yet, TP orders will be placed by monitor', {
            channel,
            symbol,
            orderId
          });
        }
      } else if (order.takeProfits && order.takeProfits.length > 0 && roundedTPPrices && !isMarketOrder) {
        // For limit orders, skip TP placement - monitor will handle it after entry fills
        logger.info('Limit order placed, TP orders will be placed by trade monitor after entry fills', {
          channel,
          symbol,
          orderId,
          entryPrice: order.entryPrice
        });
      } // End of takeProfits check
    } else {
      throw new Error('No Bybit client available and not in simulation mode');
    }

    logger.info('Order placed successfully', {
      channel,
      orderId,
      symbol,
      side,
      stopLossSet: !isSimulation,
      tpOrdersPlaced: !isSimulation && order.takeProfits && order.takeProfits.length > 0
    });

    // Update trade record if it was already inserted earlier, otherwise insert it now
    // (For limit orders with IOC timeInForce, trade was inserted earlier to allow closing position if needed)
    if (!tradeId) {
      const expiresAt = dayjs().add(entryTimeoutMinutes, 'minutes').toISOString();
      tradeId = await db.insertTrade({
        message_id: message.message_id,
        channel: channel,
        trading_pair: order.tradingPair,
        leverage: effectiveLeverage,
        entry_price: roundedEntryPrice,
        stop_loss: roundedStopLoss || order.stopLoss,
        take_profits: JSON.stringify(roundedTPPrices || order.takeProfits),
        risk_percentage: riskPercentage,
        quantity: qty,
        exchange: 'bybit',
        account_name: accountName || undefined,
        order_id: orderId,
        entry_order_type: isMarketOrder ? 'market' : 'limit',
        direction: order.signalType, // Store direction: 'long' or 'short'
        status: 'pending',
        stop_loss_breakeven: false,
        expires_at: expiresAt
      });
    } else {
      // Update existing trade with final TP prices (may have been filtered)
      await db.updateTrade(tradeId, {
        take_profits: JSON.stringify(roundedTPPrices || order.takeProfits)
      });
    }

    // Store entry order (use rounded price)
    try {
      await db.insertOrder({
        trade_id: tradeId,
        order_type: 'entry',
        order_id: orderId || undefined,
        price: roundedEntryPrice,
        quantity: qty,
        status: 'pending'
      });
    } catch (error) {
      logger.warn('Failed to store entry order', {
        tradeId,
        ...serializeError(error)
      });
    }

    // Store stop loss order (if not in simulation, use rounded price)
    // Set quantity to trade quantity to ensure 100% coverage tracking
    // Note: Bybit's setTradingStop API is position-level and automatically covers 100% of the position
    if (!isSimulation && roundedStopLoss && roundedStopLoss > 0) {
      try {
        await db.insertOrder({
          trade_id: tradeId,
          order_type: 'stop_loss',
          price: roundedStopLoss,
          quantity: qty, // Store quantity for tracking (Bybit API automatically covers 100% of position)
          status: 'pending'
        });
        logger.debug('Stored stop loss order with quantity', {
          tradeId,
          quantity: qty,
          stopLoss: roundedStopLoss
        });
      } catch (error) {
        logger.warn('Failed to store stop loss order', {
          tradeId,
          ...serializeError(error)
        });
      }
    }

    // Store take profit orders (if not in simulation and we have order IDs)
    if (!isSimulation && tpOrderIds.length > 0) {
      // Get existing orders to check for duplicates
      const existingOrders = await db.getOrdersByTradeId(tradeId);
      const existingTPOrdersByIndex = new Map(
        existingOrders
          .filter(o => o.order_type === 'take_profit' && o.tp_index !== undefined)
          .map(o => [o.tp_index!, o])
      );

      for (const tpOrder of tpOrderIds) {
        try {
          const tpIndex = (tpOrder as any).tpIndex || tpOrder.index + 1; // Use 1-based TP index if available, otherwise convert from 0-based
          
          // Check if TP order with this index already exists
          if (existingTPOrdersByIndex.has(tpIndex)) {
            const existingOrder = existingTPOrdersByIndex.get(tpIndex)!;
            logger.warn('Skipping duplicate take profit order - order with same tp_index already exists', {
              tradeId,
              tpIndex,
              existingOrderId: existingOrder.id,
              existingOrderOrderId: existingOrder.order_id,
              newOrderId: tpOrder.orderId,
              existingPrice: existingOrder.price,
              newPrice: tpOrder.price
            });
            continue;
          }

          await db.insertOrder({
            trade_id: tradeId,
            order_type: 'take_profit',
            order_id: tpOrder.orderId,
            price: tpOrder.price,
            tp_index: tpIndex,
            quantity: tpOrder.quantity,
            status: 'pending'
          });
          
          // Add to map to prevent duplicates within this batch
          existingTPOrdersByIndex.set(tpIndex, {
            id: 0, // Placeholder
            tp_index: tpIndex
          } as any);
        } catch (error) {
          logger.warn('Failed to store take profit order', {
            tradeId,
            tpIndex: tpOrder.index,
            ...serializeError(error)
          });
        }
      }
    }

    // In simulation mode, pre-fetch price data for this trade
    if (isSimulation && priceProvider) {
      const messageTime = dayjs(message.date);
      const maxDuration = entryTimeoutMinutes + 1440; // Add 1 day (1440 minutes) buffer
      priceProvider.prefetchPriceData(order.tradingPair, messageTime, maxDuration).catch(error => {
        logger.warn('Failed to pre-fetch price data', {
          tradingPair: order.tradingPair,
          ...serializeError(error)
        });
      });
    }

    logger.info('Trade stored in database', {
      channel,
      accountName: accountName || 'default',
      messageId: message.message_id,
      orderId
    });
  } catch (error) {
    logger.error('Error initiating Bybit trade for account', {
      channel,
      accountName: accountName || 'default',
      ...serializeError(error)
    });
    throw error;
  }
};

/**
 * Bybit initiator function - supports multiple accounts
 */
export const bybitInitiator: InitiatorFunction = async (context: InitiatorContext): Promise<void> => {
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
    logger.error('Error in bybitInitiator', {
      channel,
      ...serializeError(error)
    });
    throw error;
  }
};

