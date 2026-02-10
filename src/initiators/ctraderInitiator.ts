import { InitiatorContext, InitiatorFunction } from './initiatorRegistry.js';
import { AccountConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';
import { calculatePositionSize, calculateQuantity, getDecimalPrecision, roundPrice, roundQuantity } from '../utils/positionSizing.js';
import { validateTradePrices } from '../utils/tradeValidation.js';
import { deduplicateTakeProfits } from '../utils/deduplication.js';
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
    const envVarNameForAccessToken = (account as any).envVarNames?.accessToken;
    const envVarNameForRefreshToken = (account as any).envVarNames?.refreshToken;
    const envVarNameForAccountId = (account as any).envVarNames?.accountId;
    
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
        // TODO: Extract balance from accountInfo based on actual cTrader API response
        balance = (accountInfo as any).balance || 10000;
        
        if (balance === 0) {
          logger.warn('Zero balance available', { channel });
          return;
        }
      } catch (error) {
        logger.error('Failed to get account balance', {
          channel,
          ...serializeError(error)
        });
        throw error;
      }
    } else if (isSimulation) {
      logger.info('Simulation mode: Using default balance', { balance, channel });
    }

    // Normalize symbol for cTrader
    const symbol = normalizeCTraderSymbol(order.tradingPair);
    
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
    
    // Get symbol info (precision, etc.)
    // TODO: Implement getSymbolInfo for cTrader
    let decimalPrecision = 2;
    let pricePrecision: number | undefined = undefined;
    
    if (ctraderClient) {
      try {
        const symbolInfo = await ctraderClient.getSymbolInfo(symbol);
        // TODO: Extract precision from symbolInfo based on actual cTrader API response
        decimalPrecision = (symbolInfo as any).volumePrecision || 2;
        pricePrecision = (symbolInfo as any).pricePrecision || getDecimalPrecision(finalEntryPrice);
      } catch (error) {
        logger.warn('Failed to get symbol info, using defaults', {
          symbol,
          ...serializeError(error)
        });
        pricePrecision = getDecimalPrecision(finalEntryPrice);
      }
    } else {
      pricePrecision = getDecimalPrecision(finalEntryPrice);
    }
    
    // Round entry price
    const roundedEntryPrice = roundPrice(finalEntryPrice, pricePrecision);
    
    if (!roundedEntryPrice || roundedEntryPrice <= 0 || !isFinite(roundedEntryPrice)) {
      logger.error('Invalid rounded entry price', {
        channel,
        symbol,
        accountName,
        roundedEntryPrice,
        originalEntryPrice: finalEntryPrice,
        pricePrecision
      });
      throw new Error(`Invalid rounded entry price: ${roundedEntryPrice}`);
    }
    
    // Calculate quantity
    let qty = calculateQuantity(positionSize, roundedEntryPrice, decimalPrecision);
    qty = roundQuantity(qty, decimalPrecision);
    
    // Deduplicate take profits
    const deduplicatedTPs = deduplicateTakeProfits(order.takeProfits, order.signalType, finalEntryPrice);
    
    // Place order
    let orderId: string;
    if (isSimulation) {
      orderId = `SIM-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      logger.info('Simulation mode: Trade created', {
        channel,
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
          ...serializeError(error)
        });
        throw error;
      }
    } else {
      throw new Error('No cTrader client available');
    }

    // Calculate expiration time
    const expiresAt = dayjs().add(entryTimeoutMinutes, 'minute').toISOString();

    // Store trade in database
    const tradeId = await db.insertTrade({
      channel,
      message_id: message.message_id,
      trading_pair: order.tradingPair,
      direction: order.signalType, // long/short
      entry_price: roundedEntryPrice,
      stop_loss: order.stopLoss,
      take_profits: JSON.stringify(deduplicatedTPs),
      leverage: effectiveLeverage,
      quantity: qty,
      risk_percentage: riskPercentage,
      exchange: 'ctrader',
      status: 'pending',
      order_id: orderId,
      account_name: accountName || undefined,
      expires_at: expiresAt,
      stop_loss_breakeven: false
    });

    // Store entry order
    await db.insertOrder({
      trade_id: tradeId,
      order_type: 'entry',
      order_id: orderId,
      price: roundedEntryPrice,
      quantity: qty,
      status: 'pending'
    });

    // Store take profit orders
    for (let i = 0; i < deduplicatedTPs.length; i++) {
      const tpPrice = deduplicatedTPs[i];
      const tpQty = qty / deduplicatedTPs.length; // Distribute quantity evenly
      
      // In simulation, create placeholder TP orders
      // In real trading, TPs would be set when position is opened
      if (isSimulation) {
        const tpOrderId = `SIM-TP-${tradeId}-${i + 1}`;
        await db.insertOrder({
          trade_id: tradeId,
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

