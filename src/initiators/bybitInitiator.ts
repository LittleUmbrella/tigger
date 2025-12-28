import { RestClientV5 } from 'bybit-api';
import { InitiatorContext, InitiatorFunction } from './initiatorRegistry.js';
import { AccountConfig } from '../types/config.js';
import { logger } from '../utils/logger.js';
import { validateBybitSymbol } from './symbolValidator.js';
import dayjs from 'dayjs';

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
const getAccountCredentials = (account: AccountConfig | null, fallbackTestnet: boolean = false): { apiKey: string | undefined; apiSecret: string | undefined; testnet: boolean } => {
  if (account) {
    // Use account config credentials, with fallback to env vars if specified
    const apiKey = account.apiKey || (account.envVars?.apiKey ? process.env[account.envVars.apiKey] : process.env.BYBIT_API_KEY);
    const apiSecret = account.apiSecret || (account.envVars?.apiSecret ? process.env[account.envVars.apiSecret] : process.env.BYBIT_API_SECRET);
    return {
      apiKey,
      apiSecret,
      testnet: account.testnet || false
    };
  } else {
    // Fallback to environment variables
    return {
      apiKey: process.env.BYBIT_API_KEY,
      apiSecret: process.env.BYBIT_API_SECRET,
      testnet: fallbackTestnet
    };
  }
};

/**
 * Get list of accounts to use for this initiator
 */
const getAccountsToUse = (context: InitiatorContext): (AccountConfig | null)[] => {
  const { config, accounts } = context;
  
  // If accounts config is provided and initiator specifies accounts
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
  
  // Fallback: use default account (null means use env vars)
  // For backward compatibility, if testnet is set in config, preserve it
  // We'll pass it to getAccountCredentials when account is null
  return [null]; // null means use environment variables
};

/**
 * Get decimal precision from a price value
 */
const getDecimalPrecision = (price: number): number => {
  if (!isFinite(price)) return 2;
  const priceStr = price.toString();
  if (priceStr.includes('.')) {
    return priceStr.split('.')[1].length;
  }
  return 0;
};

/**
 * Get symbol information from Bybit to determine precision
 */
const getSymbolInfo = async (
  bybitClient: RestClientV5,
  symbol: string
): Promise<{ qtyPrecision?: number; pricePrecision?: number } | null> => {
  try {
    // Try to get instrument info
    const instruments = await bybitClient.getInstrumentsInfo({ category: 'linear', symbol });
    
    if (instruments.retCode === 0 && instruments.result && instruments.result.list) {
      const instrument = instruments.result.list.find((s: any) => s.symbol === symbol);
      if (!instrument) return null;
      return {
        qtyPrecision: (instrument as any).lot_size_filter?.qty_precision 
          ? parseInt((instrument as any).lot_size_filter.qty_precision) 
          : undefined,
        pricePrecision: (instrument as any).price_filter?.tick_size
          ? getDecimalPrecision(parseFloat((instrument as any).price_filter.tick_size))
          : undefined
      };
    }
  } catch (error) {
    logger.warn('Failed to get symbol info', {
      symbol,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return null;
};

/**
 * Distribute quantity evenly across take profits, rounding with highest amount in first TP
 */
const distributeQuantityAcrossTPs = (
  totalQty: number,
  numTPs: number,
  decimalPrecision: number
): number[] => {
  if (numTPs === 0) return [];
  if (numTPs === 1) return [totalQty];
  
  // Calculate base quantity per TP
  const baseQty = totalQty / numTPs;
  
  // Round to specified decimal places
  const roundToPrecision = (value: number): number => {
    const multiplier = Math.pow(10, decimalPrecision);
    return Math.round(value * multiplier) / multiplier;
  };
  
  // Round all quantities
  const roundedQuantities = Array(numTPs).fill(0).map(() => roundToPrecision(baseQty));
  
  // Calculate total rounded quantity
  const totalRounded = roundedQuantities.reduce((sum, qty) => sum + qty, 0);
  
  // Adjust first TP to account for rounding differences (highest amount)
  const difference = totalQty - totalRounded;
  roundedQuantities[0] = roundToPrecision(roundedQuantities[0] + difference);
  
  return roundedQuantities;
};

/**
 * Execute a trade for a single account
 */
const executeTradeForAccount = async (
  context: InitiatorContext,
  account: AccountConfig | null,
  accountName: string
): Promise<void> => {
  const { channel, riskPercentage, entryTimeoutDays, message, order, db, isSimulation, priceProvider, config } = context;

  try {
    // Get API credentials for this account
    // For backward compatibility, use testnet from config if account is null
    const fallbackTestnet = account === null ? ((config as any).testnet || false) : false;
    const { apiKey, apiSecret, testnet } = getAccountCredentials(account, fallbackTestnet);
    
    if (!isSimulation && (!apiKey || !apiSecret)) {
      logger.error('Bybit API credentials not found', {
        channel,
        accountName: accountName || 'default',
        missing: !apiKey ? 'apiKey' : 'apiSecret'
      });
      return;
    }

    let bybitClient: RestClientV5 | undefined;
    if (!isSimulation && apiKey && apiSecret) {
      bybitClient = new RestClientV5({ key: apiKey, secret: apiSecret, testnet: testnet });
      logger.info('Bybit client initialized', { 
        channel,
        accountName: accountName || 'default',
        testnet: testnet 
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
      const validation = await validateBybitSymbol(bybitClient, symbol);
      if (!validation.valid) {
        logger.error('Invalid symbol, skipping trade', {
          channel,
          symbol,
          tradingPair: order.tradingPair,
          error: validation.error
        });
        throw new Error(`Invalid symbol: ${validation.error}`);
      }
      // Use the actual symbol found (might be USDC if USDT doesn't exist)
      if (validation.actualSymbol && validation.actualSymbol !== symbol) {
        symbol = validation.actualSymbol;
        logger.info('Using alternative quote currency', {
          originalSymbol: order.tradingPair.replace('/', ''),
          actualSymbol: symbol
        });
      }
      logger.debug('Symbol validated', { symbol, tradingPair: order.tradingPair });
    }
    
    // Determine side (Buy for long, Sell for short)
    const side = order.signalType === 'long' ? 'Buy' : 'Sell';
    
    // For market orders, we need to get current price first
    let entryPrice = order.entryPrice;
    if (!entryPrice || entryPrice <= 0) {
      if (!isSimulation && bybitClient) {
        try {
          const ticker = await bybitClient.getTickers({ category: 'linear', symbol });
          if (ticker.retCode === 0 && ticker.result && ticker.result.list && ticker.result.list.length > 0 && ticker.result.list[0]?.lastPrice) {
            entryPrice = parseFloat(ticker.result.list[0].lastPrice);
            logger.info('Using market price for entry', { symbol, entryPrice });
          }
        } catch (error) {
          logger.warn('Failed to get market price', {
            symbol,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      // Fallback: use a default or throw error
      if (!entryPrice || entryPrice <= 0) {
        throw new Error(`Cannot calculate position size: entry price is required for ${symbol}`);
      }
    }

    // Calculate position size based on risk percentage
    const riskAmount = balance * (riskPercentage / 100);
    const priceDiff = Math.abs(entryPrice - order.stopLoss);
    const riskPerUnit = priceDiff / entryPrice;
    const positionSize = riskAmount / riskPerUnit;
    
    // Calculate quantity (simplified - in production you'd need to handle lot size filters)
    const qty = Math.floor((positionSize / entryPrice) * 100) / 100;

    // Determine decimal precision for rounding
    // Use entry price if available, otherwise get from symbol info
    let decimalPrecision = 2; // default
    if (entryPrice && entryPrice > 0) {
      decimalPrecision = getDecimalPrecision(entryPrice);
    } else if (!isSimulation && bybitClient) {
      // For market orders, get precision from symbol info
      const symbolInfo = await getSymbolInfo(bybitClient, symbol);
      if (symbolInfo?.qtyPrecision !== undefined) {
        decimalPrecision = symbolInfo.qtyPrecision;
      }
    }

    logger.info('Calculated trade parameters', {
      channel,
      symbol,
      side,
      qty,
      entryPrice: entryPrice,
      leverage: order.leverage,
      decimalPrecision
    });

    // Determine order type - use Market if original entry price was 0 or not provided
    const isMarketOrder = !order.entryPrice || order.entryPrice <= 0;
    const orderType = isMarketOrder ? 'Market' : 'Limit';

    // Using Bybit Futures API (linear perpetuals)
    // Create order at entry price (or market)
    const orderParams: any = {
      category: 'linear',
      symbol: symbol,
      side: side,
      orderType: orderType,
      qty: qty.toString(),
      timeInForce: isMarketOrder ? 'IOC' : 'GTC',
      reduceOnly: false,
      closeOnTrigger: false,
      positionIdx: 0,
    };

    // Only add price for limit orders
    if (!isMarketOrder) {
      orderParams.price = entryPrice.toString();
    }

    // Add stop loss to initial order if available (Bybit supports this)
    if (order.stopLoss && order.stopLoss > 0) {
      orderParams.stopLoss = order.stopLoss.toString();
    }

    let orderId: string | null = null;
    // Collect TP order IDs for storage
    const tpOrderIds: Array<{ index: number; orderId: string; price: number; quantity: number }> = [];

    if (isSimulation) {
      // In simulation mode, generate a fake order ID
      orderId = `SIM-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      logger.info('Simulation mode: Simulated order placement', {
        channel,
        orderId,
        symbol,
        side,
        qty,
        price: entryPrice
      });
    } else if (bybitClient) {
      // Set leverage first
      try {
        await bybitClient.setLeverage({
          category: 'linear',
          symbol: symbol,
          buyLeverage: order.leverage.toString(),
          sellLeverage: order.leverage.toString(),
        });
        logger.info('Leverage set', { symbol, leverage: order.leverage });
      } catch (error) {
        logger.warn('Failed to set leverage', {
          symbol,
          leverage: order.leverage,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      // Place the entry order with stop loss (if supported in initial order)
      const orderResponse = await bybitClient.submitOrder(orderParams);
      orderId = orderResponse.retCode === 0 && orderResponse.result
        ? orderResponse.result.orderId || 'unknown'
        : null;

      if (!orderId) {
        throw new Error(`Order placement failed: ${JSON.stringify(orderResponse)}`);
      }

      // Verify stop loss was set, or set it separately if initial order didn't support it
      // (Some order types may not support stopLoss in initial order)
      if (order.stopLoss && order.stopLoss > 0) {
        // Try to verify if stop loss was set by checking position or setting it explicitly
        // If the initial order included stopLoss but it wasn't accepted, set it separately
        try {
          await bybitClient.setTradingStop({
            category: 'linear',
            symbol: symbol,
            stopLoss: order.stopLoss.toString(),
            positionIdx: 0
          });
          logger.info('Stop loss verified/set', {
            symbol,
            stopLoss: order.stopLoss
          });
        } catch (error) {
          logger.warn('Failed to set/verify stop loss', {
            symbol,
            stopLoss: order.stopLoss,
            error: error instanceof Error ? error.message : String(error)
          });
          // If stop loss fails and order is still pending, cancel it for safety
          // But only if it's still pending (not filled)
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
              logger.warn('Cancelled entry order due to stop loss setup failure', {
                symbol,
                orderId
              });
              throw new Error('Entry order cancelled: failed to set stop loss');
            }
          } catch (cancelError) {
            // Order may already be filled, which is okay - we'll log but continue
            logger.warn('Could not cancel entry order (may already be filled)', {
              symbol,
              orderId,
              error: cancelError instanceof Error ? cancelError.message : String(cancelError)
            });
          }
        }
      }

      // Place take profit orders using batch placement if available
      if (order.takeProfits && order.takeProfits.length > 0) {
        // Distribute quantity evenly across TPs
        const tpQuantities = distributeQuantityAcrossTPs(
          qty,
          order.takeProfits.length,
          decimalPrecision
        );

        // Determine opposite side for TP orders (reduceOnly)
        const tpSide = order.signalType === 'long' ? 'Sell' : 'Buy';

        // Prepare batch order requests
        const batchOrders = order.takeProfits.map((tpPrice, i) => ({
          category: 'linear' as const,
          symbol: symbol,
          side: tpSide as 'Buy' | 'Sell',
          orderType: 'Limit' as const,
          qty: tpQuantities[i].toString(),
          price: tpPrice.toString(),
          timeInForce: 'GTC' as const,
          reduceOnly: true, // TP orders should reduce position
          closeOnTrigger: false,
          positionIdx: 0 as 0 | 1 | 2,
        }));

        // Try batch placement first (more atomic)
        let batchSuccess = false;
        try {
          // Check if batchPlaceOrder method exists
          if (typeof (bybitClient as any).batchPlaceOrder === 'function') {
            const batchResponse = await (bybitClient as any).batchPlaceOrder({
              category: 'linear',
              request: batchOrders
            });

            if (batchResponse.retCode === 0 && batchResponse.result && batchResponse.result.list && Array.isArray(batchResponse.result.list)) {
              batchSuccess = true;
              // Collect order IDs from batch response
              batchResponse.result.list.forEach((result: any, i: number) => {
                if (result.orderId) {
                  tpOrderIds.push({
                    index: i,
                    orderId: result.orderId,
                    price: order.takeProfits[i],
                    quantity: tpQuantities[i]
                  });
                }
              });
              logger.info('Take profit orders placed via batch', {
                symbol,
                numTPs: order.takeProfits.length,
                orderIds: tpOrderIds.map(tp => tp.orderId)
              });
            } else {
              logger.warn('Batch TP order placement failed, falling back to individual orders', {
                symbol,
                error: JSON.stringify(batchResponse)
              });
            }
          }
        } catch (batchError) {
          logger.warn('Batch placement not available or failed, using individual orders', {
            symbol,
            error: batchError instanceof Error ? batchError.message : String(batchError)
          });
        }

        // Fallback to individual orders if batch failed or not available
        if (!batchSuccess) {
          let tpSuccessCount = 0;
          const tpErrors: Array<{ index: number; error: string }> = [];

          for (let i = 0; i < order.takeProfits.length; i++) {
            const tpPrice = order.takeProfits[i];
            const tpQty = tpQuantities[i];

            try {
              const tpOrderResponse = await bybitClient.submitOrder(batchOrders[i]);

              if (tpOrderResponse.retCode === 0 && tpOrderResponse.result) {
                tpSuccessCount++;
                const tpOrderId = tpOrderResponse.result.orderId;
                if (tpOrderId) {
                  tpOrderIds.push({
                    index: i,
                    orderId: tpOrderId,
                    price: tpPrice,
                    quantity: tpQty
                  });
                }
                logger.info('Take profit order placed', {
                  symbol,
                  tpIndex: i + 1,
                  tpPrice,
                  tpQty,
                  tpOrderId
                });
              } else {
                tpErrors.push({
                  index: i + 1,
                  error: JSON.stringify(tpOrderResponse)
                });
                logger.warn('Failed to place take profit order', {
                  symbol,
                  tpIndex: i + 1,
                  tpPrice,
                  tpQty,
                  error: JSON.stringify(tpOrderResponse)
                });
              }
            } catch (error) {
              tpErrors.push({
                index: i + 1,
                error: error instanceof Error ? error.message : String(error)
              });
              logger.warn('Error placing take profit order', {
                symbol,
                tpIndex: i + 1,
                tpPrice,
                tpQty,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }

          // If all TP orders failed, consider cancelling entry order
          if (tpSuccessCount === 0 && order.takeProfits.length > 0) {
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
          } else if (tpSuccessCount < order.takeProfits.length) {
            logger.warn('Some take profit orders failed', {
              symbol,
              orderId,
              successful: tpSuccessCount,
              total: order.takeProfits.length,
              errors: tpErrors
            });
          }
        }
      }
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

    // Store trade in database with account name
    const expiresAt = dayjs().add(entryTimeoutDays, 'days').toISOString();
    const tradeId = await db.insertTrade({
      message_id: message.message_id,
      channel: channel,
      trading_pair: order.tradingPair,
      leverage: order.leverage,
      entry_price: entryPrice,
      stop_loss: order.stopLoss,
      take_profits: JSON.stringify(order.takeProfits),
      risk_percentage: riskPercentage,
      quantity: qty,
      exchange: 'bybit',
      account_name: accountName || undefined,
      order_id: orderId,
      status: 'pending',
      stop_loss_breakeven: false,
      expires_at: expiresAt
    });

    // Store entry order
    try {
      await db.insertOrder({
        trade_id: tradeId,
        order_type: 'entry',
        order_id: orderId || undefined,
        price: entryPrice,
        quantity: qty,
        status: 'pending'
      });
    } catch (error) {
      logger.warn('Failed to store entry order', {
        tradeId,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Store stop loss order (if not in simulation)
    if (!isSimulation && order.stopLoss && order.stopLoss > 0) {
      try {
        await db.insertOrder({
          trade_id: tradeId,
          order_type: 'stop_loss',
          price: order.stopLoss,
          status: 'pending'
        });
      } catch (error) {
        logger.warn('Failed to store stop loss order', {
          tradeId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Store take profit orders (if not in simulation and we have order IDs)
    if (!isSimulation && tpOrderIds.length > 0) {
      for (const tpOrder of tpOrderIds) {
        try {
          await db.insertOrder({
            trade_id: tradeId,
            order_type: 'take_profit',
            order_id: tpOrder.orderId,
            price: tpOrder.price,
            tp_index: tpOrder.index,
            quantity: tpOrder.quantity,
            status: 'pending'
          });
        } catch (error) {
          logger.warn('Failed to store take profit order', {
            tradeId,
            tpIndex: tpOrder.index,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    // In simulation mode, pre-fetch price data for this trade
    if (isSimulation && priceProvider) {
      const messageTime = dayjs(message.date);
      const maxDuration = entryTimeoutDays + 1; // Add 1 day buffer
      priceProvider.prefetchPriceData(order.tradingPair, messageTime, maxDuration).catch(error => {
        logger.warn('Failed to pre-fetch price data', {
          tradingPair: order.tradingPair,
          error: error instanceof Error ? error.message : String(error)
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
      error: error instanceof Error ? error.message : String(error)
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
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
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
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

