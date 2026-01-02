import { RestClientV5 } from 'bybit-api';
import { InitiatorContext, InitiatorFunction } from './initiatorRegistry.js';
import { AccountConfig } from '../types/config.js';
import { logger } from '../utils/logger.js';
import { validateBybitSymbol, getSymbolInfo } from './symbolValidator.js';
import { calculatePositionSize, calculateQuantity, getDecimalPrecision, getQuantityPrecisionFromRiskAmount, roundPrice, roundQuantity } from '../utils/positionSizing.js';
import { validateTradePrices } from '../utils/tradeValidation.js';
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
    // Priority: envVarNames > envVars (backward compat) > apiKey/apiSecret (deprecated) > default env vars
    const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
    const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
    const apiKey = envVarNameForKey ? process.env[envVarNameForKey] : (account.apiKey || process.env.BYBIT_API_KEY);
    const apiSecret = envVarNameForSecret ? process.env[envVarNameForSecret] : (account.apiSecret || process.env.BYBIT_API_SECRET);
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
 * Distribute quantity evenly across take profits, rounding up the last TP (max TP) to ensure whole trade quantity is accounted for
 */
const distributeQuantityAcrossTPs = (
  totalQty: number,
  numTPs: number,
  decimalPrecision: number
): number[] => {
  if (numTPs === 0) return [];
  if (numTPs === 1) return [roundQuantity(totalQty, decimalPrecision, false)];
  
  // Calculate base quantity per TP
  const baseQty = totalQty / numTPs;
  
  // Round down all quantities except the last one
  const roundedQuantities: number[] = [];
  for (let i = 0; i < numTPs - 1; i++) {
    roundedQuantities.push(roundQuantity(baseQty, decimalPrecision, false));
  }
  
  // Calculate remaining quantity for the last TP (max TP)
  const allocatedQty = roundedQuantities.reduce((sum, qty) => sum + qty, 0);
  const remainingQty = totalQty - allocatedQty;
  
  // Round UP the last TP to ensure whole trade quantity is accounted for
  roundedQuantities.push(roundQuantity(remainingQty, decimalPrecision, true));
  
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

    // Validate trade prices before proceeding (safety net - parsers should have validated already)
    if (!validateTradePrices(
      order.signalType,
      entryPrice,
      order.stopLoss,
      order.takeProfits,
      { channel, symbol, messageId: message.message_id }
    )) {
      throw new Error(`Trade validation failed for ${symbol}: Invalid price relationships detected`);
    }

    // Use baseLeverage as default if leverage is not specified in order
    const baseLeverage = context.config.baseLeverage;
    const effectiveLeverage = order.leverage > 0 ? order.leverage : (baseLeverage || 1);
    
    // Calculate position size based on risk percentage
    const positionSize = calculatePositionSize(
      balance,
      riskPercentage,
      entryPrice,
      order.stopLoss,
      effectiveLeverage,
      baseLeverage
    );
    
    // Get precision info from exchange symbol info
    let decimalPrecision = 2; // default fallback for quantity
    let pricePrecision: number | undefined = undefined;
    let tickSize: number | undefined = undefined;
    
    if (bybitClient) {
      const symbolInfo = await getSymbolInfo(bybitClient, symbol);
      if (symbolInfo?.qtyPrecision !== undefined) {
        decimalPrecision = symbolInfo.qtyPrecision;
      } else if (entryPrice && entryPrice > 0 && positionSize > 0) {
        // Fallback: 2 decimal places lower than first significant digit of risk amount in asset
        const riskAmountInAsset = positionSize / entryPrice;
        decimalPrecision = getQuantityPrecisionFromRiskAmount(riskAmountInAsset);
      }
      pricePrecision = symbolInfo?.pricePrecision;
      // Note: tickSize would need to be extracted from symbolInfo if available
      // For now, we'll use pricePrecision for rounding
    } else if (entryPrice && entryPrice > 0 && positionSize > 0) {
      const riskAmountInAsset = positionSize / entryPrice;
      decimalPrecision = getQuantityPrecisionFromRiskAmount(riskAmountInAsset);
      pricePrecision = getDecimalPrecision(entryPrice);
    }
    
    // Round entry price to exchange precision
    const roundedEntryPrice = roundPrice(entryPrice, pricePrecision, tickSize);
    
    // Calculate quantity with exchange-provided precision (using rounded entry price)
    const qty = calculateQuantity(positionSize, roundedEntryPrice, decimalPrecision);

    // Round stop loss to exchange precision
    const roundedStopLoss = order.stopLoss && order.stopLoss > 0 
      ? roundPrice(order.stopLoss, pricePrecision, tickSize)
      : order.stopLoss;

    logger.info('Calculated trade parameters', {
      channel,
      symbol,
      side,
      qty,
      entryPrice: roundedEntryPrice,
      originalEntryPrice: entryPrice,
      stopLoss: roundedStopLoss,
      leverage: effectiveLeverage,
      baseLeverage,
      decimalPrecision,
      pricePrecision
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

    // Only add price for limit orders (use rounded price)
    if (!isMarketOrder) {
      orderParams.price = roundedEntryPrice.toString();
    }

    // Add stop loss to initial order if available (Bybit supports this) - use rounded price
    if (roundedStopLoss && roundedStopLoss > 0) {
      orderParams.stopLoss = roundedStopLoss.toString();
    }

    let orderId: string | null = null;
    // Collect TP order IDs for storage
    const tpOrderIds: Array<{ index: number; orderId: string; price: number; quantity: number }> = [];
    
    // Round TP prices to exchange precision (declare early for use in trade storage)
    let roundedTPPrices: number[] | undefined = undefined;
    if (order.takeProfits && order.takeProfits.length > 0) {
      roundedTPPrices = order.takeProfits.map(tpPrice => 
        roundPrice(tpPrice, pricePrecision, tickSize)
      );
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
        price: entryPrice
      });
    } else if (bybitClient) {
      // Set leverage first (use effective leverage)
      try {
        await bybitClient.setLeverage({
          category: 'linear',
          symbol: symbol,
          buyLeverage: effectiveLeverage.toString(),
          sellLeverage: effectiveLeverage.toString(),
        });
        logger.info('Leverage set', { symbol, leverage: effectiveLeverage });
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
            stopLoss: roundedStopLoss.toString(),
            positionIdx: 0
          });
          logger.info('Stop loss verified/set', {
            symbol,
            stopLoss: roundedStopLoss
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
      if (order.takeProfits && order.takeProfits.length > 0 && roundedTPPrices) {
        // Distribute quantity evenly across TPs (last TP rounded up)
        const tpQuantities = distributeQuantityAcrossTPs(
          qty,
          order.takeProfits.length,
          decimalPrecision
        );

        // Determine opposite side for TP orders (reduceOnly)
        const tpSide = order.signalType === 'long' ? 'Sell' : 'Buy';

        // Prepare batch order requests
        const batchOrders = roundedTPPrices.map((tpPrice, i) => ({
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
                    price: roundedTPPrices[i],
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

          for (let i = 0; i < roundedTPPrices.length; i++) {
            const tpPrice = roundedTPPrices[i];
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

    // Store trade in database with account name (use rounded prices)
    const expiresAt = dayjs().add(entryTimeoutDays, 'days').toISOString();
    const tradeId = await db.insertTrade({
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
      status: 'pending',
      stop_loss_breakeven: false,
      expires_at: expiresAt
    });

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
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Store stop loss order (if not in simulation, use rounded price)
    if (!isSimulation && roundedStopLoss && roundedStopLoss > 0) {
      try {
        await db.insertOrder({
          trade_id: tradeId,
          order_type: 'stop_loss',
          price: roundedStopLoss,
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

