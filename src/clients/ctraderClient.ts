import { logger } from '../utils/logger.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';
import { withCTraderRateLimitRetry } from '../utils/ctraderRateLimitRetry.js';
import { CTraderConnection } from '../lib/ctrader/CTraderConnection.js';

/**
 * Fixed price scale for cTrader Open API.
 * Per official docs (help.ctrader.com/open-api/symbol-data): all price fields
 * (trendbars, ticks, spot bid/ask) use the same encoding: divide by 100000.
 * Do NOT use symbol.digits for scale - that causes wrong prices for symbols like XAUUSD (digits=2).
 */
const CTRADER_PRICE_SCALE = 100000;

/**
 * cTrader OpenAPI client configuration
 */
export interface CTraderClientConfig {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  environment?: 'demo' | 'live';
  host?: string;
  port?: number;
  /** Map canonical symbol names to broker-specific names (e.g. {"XAUUSD": "GOLD"}) */
  symbolMap?: Record<string, string>;
  /** Timeout in ms for spot price subscription (default 8000) */
  spotPriceTimeoutMs?: number;
  /** Max retries for getCurrentPrice (default 3) */
  spotPriceMaxRetries?: number;
}

/**
 * cTrader OpenAPI client using local implementation
 * 
 * Uses our local CTraderConnection implementation which handles
 * the low-level protocol communication (Protobuf over TCP/WebSocket).
 */
/** Result of a spot price fetch - used to coalesce concurrent requests */
type SpotPriceResult = { bid: number; ask: number } | null;

export class CTraderClient {
  private config: CTraderClientConfig;
  private connection: CTraderConnection | null = null;
  private connected: boolean = false;
  private authenticated: boolean = false;
  /** Coalesce concurrent getCurrentPrice calls per symbol - one subscription, all callers share result */
  private inFlightSpotRequests = new Map<string, Promise<SpotPriceResult>>();

  constructor(config: CTraderClientConfig) {
    this.config = {
      environment: 'demo',
      host: config.environment === 'live' ? 'live.ctraderapi.com' : 'demo.ctraderapi.com',
      port: 5035,
      ...config
    };
  }

  /**
   * Connect to cTrader OpenAPI server
   */
  async connect(): Promise<void> {
    if (this.connected && this.connection) {
      return;
    }

    try {
      this.connection = new CTraderConnection({
        host: this.config.host!,
        port: this.config.port!
      });

      await this.connection.open();
      this.connected = true;
      
      logger.info('Connected to cTrader OpenAPI', {
        host: this.config.host,
        port: this.config.port,
        environment: this.config.environment
      });
    } catch (error) {
      logger.error('Failed to connect to cTrader OpenAPI', {
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Authenticate with cTrader OpenAPI
   */
  async authenticate(): Promise<void> {
    if (!this.connected || !this.connection) {
      throw new Error('Not connected to cTrader OpenAPI');
    }
    if (this.authenticated) {
      return;
    }

    try {
      // First authenticate the application
      await this.connection.sendCommand('ProtoOAApplicationAuthReq', {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret
      });

      logger.info('Application authenticated with cTrader OpenAPI');

      // Then authenticate the trading account if access token and account ID are provided
      if (this.config.accessToken && this.config.accountId) {
        const accountIdNum = parseInt(this.config.accountId, 10);
        if (isNaN(accountIdNum)) {
          throw new Error(`Invalid account ID: ${this.config.accountId}`);
        }

        logger.info('Authenticating trading account', {
          accountId: this.config.accountId,
          accountIdNum
        });

        const authResponse = await this.connection.sendCommand('ProtoOAAccountAuthReq', {
          accessToken: this.config.accessToken,
          ctidTraderAccountId: accountIdNum
        });

        this.authenticated = true;
        logger.info('Trading account authenticated', {
          accountId: this.config.accountId,
          response: authResponse
        });
      }
    } catch (error) {
      logger.error('Failed to authenticate with cTrader OpenAPI', {
        error: serializeErrorForLog(error),
        errorJson: error && typeof error === 'object' ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : undefined,
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Get account list (may require account authentication)
   * Note: This might not work with just application authentication.
   * Consider using CTraderConnection.getAccessTokenAccounts(accessToken) instead
   * if you have an access token.
   */
  async getAccountList(): Promise<any> {
    if (!this.connected || !this.connection) {
      throw new Error('Not connected to cTrader OpenAPI');
    }

    try {
      // ProtoOAGetAccountListReq might require account authentication
      // If this fails, use CTraderConnection.getAccessTokenAccounts() static method instead
      const response = await this.connection.sendCommand('ProtoOAGetAccountListReq', {});
      // The response should contain account list
      return response;
    } catch (error) {
      logger.error('Failed to get account list', {
        error: serializeErrorForLog(error),
        note: 'This might require account authentication. Try using CTraderConnection.getAccessTokenAccounts() if you have an access token.'
      });
      throw error;
    }
  }

  /**
   * Get account information (requires account authentication)
   * Uses ProtoOATraderReq to get trader account details including balance
   */
  async getAccountInfo(): Promise<any> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    if (!this.config.accountId) {
      throw new Error('Account ID is required to get account info');
    }

    try {
      const response = await this.connection.sendCommand('ProtoOATraderReq', {
        ctidTraderAccountId: parseInt(this.config.accountId, 10)
      });
      // The response should contain trader account information including balance
      return response;
    } catch (error) {
      logger.error('Failed to get account info', {
        error: serializeErrorForLog(error),
        errorJson: error && typeof error === 'object' ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : undefined
      });
      throw error;
    }
  }

  /**
   * Get historical OHLC trendbars for a symbol (for evaluation/backtesting)
   * Uses ProtoOAGetTrendbarsReq. Requires account authentication.
   * @param symbol - Symbol name (e.g., EURUSD, XAUUSD)
   * @param fromTimestamp - Start time in milliseconds
   * @param toTimestamp - End time in milliseconds
   * @param period - Bar period (M1, M5, etc.). Default M1 for evaluation
   */
  async getTrendbars(params: {
    symbol: string;
    fromTimestamp: number;
    toTimestamp: number;
    period?: 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';
  }): Promise<Array<{ timestamp: number; price: number; high?: number; low?: number }>> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    if (!this.config.accountId) {
      throw new Error('Account ID is required to get trendbars');
    }

    const accountIdNum = parseInt(this.config.accountId, 10);
    if (isNaN(accountIdNum)) {
      throw new Error(`Invalid account ID: ${this.config.accountId}`);
    }

    const symbolInfo = await this.getSymbolInfo(params.symbol);
    const symbolId = typeof symbolInfo.symbolId === 'object' && symbolInfo.symbolId?.low !== undefined
      ? symbolInfo.symbolId.low
      : symbolInfo.symbolId;

    const { protobufLongToNumber } = await import('../utils/protobufLong.js');

    const periodMap: Record<string, number> = {
      M1: 1, M5: 5, M15: 7, M30: 8, H1: 9, H4: 10, D1: 12
    };
    const periodNum = periodMap[params.period ?? 'M1'] ?? 1;

    const result: Array<{ timestamp: number; price: number; high?: number; low?: number }> = [];
    const maxChunkMs = params.period === 'M1' || params.period === 'M5' ? 5 * 7 * 24 * 60 * 60 * 1000 : 35 * 7 * 24 * 60 * 60 * 1000;
    let currentFrom = params.fromTimestamp;
    const toTs = params.toTimestamp;

    while (currentFrom < toTs) {
      const currentTo = Math.min(currentFrom + maxChunkMs, toTs);

      try {
        const response = await this.connection.sendCommand('ProtoOAGetTrendbarsReq', {
          ctidTraderAccountId: accountIdNum,
          fromTimestamp: currentFrom,
          toTimestamp: currentTo,
          period: periodNum,
          symbolId,
          count: 2000
        });

        const trendbars = response?.trendbar || [];
        for (const bar of trendbars) {
          const lowRaw = protobufLongToNumber(bar.low) ?? 0;
          const deltaOpen = protobufLongToNumber(bar.deltaOpen) ?? 0;
          const deltaHigh = protobufLongToNumber(bar.deltaHigh) ?? 0;
          const deltaClose = protobufLongToNumber(bar.deltaClose) ?? 0;

          const low = lowRaw / CTRADER_PRICE_SCALE;
          const open = (lowRaw + deltaOpen) / CTRADER_PRICE_SCALE;
          const high = (lowRaw + deltaHigh) / CTRADER_PRICE_SCALE;
          const close = (lowRaw + deltaClose) / CTRADER_PRICE_SCALE;
          const utcMinutes = protobufLongToNumber(bar.utcTimestampInMinutes) ?? 0;
          const timestamp = utcMinutes * 60 * 1000;

          result.push({
            timestamp,
            price: close,
            high,
            low
          });
        }
      } catch (error) {
        logger.warn('getTrendbars chunk failed', {
          symbol: params.symbol,
          from: new Date(currentFrom).toISOString(),
          to: new Date(currentTo).toISOString(),
          error: serializeErrorForLog(error)
        });
      }

      currentFrom = currentTo + 1;
      if (currentFrom < toTs) {
        await new Promise(r => setTimeout(r, 250));
      }
    }

    result.sort((a, b) => a.timestamp - b.timestamp);
    return result;
  }

  /**
   * Get historical tick data for a symbol (most granular - individual price updates)
   * Uses ProtoOAGetTickDataReq. Max 1 week per request. Requires account authentication.
   * @param symbol - Symbol name (e.g., EURUSD, XAUUSD)
   * @param fromTimestamp - Start time in milliseconds
   * @param toTimestamp - End time in milliseconds
   * @param type - BID or ASK (default: BID for evaluation)
   */
  async getTickData(params: {
    symbol: string;
    fromTimestamp: number;
    toTimestamp: number;
    type?: 'BID' | 'ASK';
  }): Promise<Array<{ timestamp: number; price: number }>> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    if (!this.config.accountId) {
      throw new Error('Account ID is required to get tick data');
    }

    const accountIdNum = parseInt(this.config.accountId, 10);
    if (isNaN(accountIdNum)) {
      throw new Error(`Invalid account ID: ${this.config.accountId}`);
    }

    const symbolInfo = await this.getSymbolInfo(params.symbol);
    const symbolId = typeof symbolInfo.symbolId === 'object' && symbolInfo.symbolId?.low !== undefined
      ? symbolInfo.symbolId.low
      : symbolInfo.symbolId;

    const { protobufLongToNumber } = await import('../utils/protobufLong.js');

    const typeNum = params.type === 'ASK' ? 2 : 1; // ProtoOAQuoteType: BID=1, ASK=2
    const maxChunkMs = 7 * 24 * 60 * 60 * 1000; // 1 week
    const result: Array<{ timestamp: number; price: number }> = [];
    let currentFrom = params.fromTimestamp;
    const toTs = params.toTimestamp;

    while (currentFrom < toTs) {
      const currentTo = Math.min(currentFrom + maxChunkMs, toTs);
      let chunkTo = currentTo;

      try {
        // cTrader returns ticks in descending order (newest first). When hasMore, request OLDER data
        // by using the oldest timestamp we got as the new toTimestamp.
        while (currentFrom <= chunkTo) {
          const response = await this.connection.sendCommand('ProtoOAGetTickDataReq', {
            ctidTraderAccountId: accountIdNum,
            symbolId,
            type: typeNum,
            fromTimestamp: currentFrom,
            toTimestamp: chunkTo,
          });

          const ticks = response?.tickData || [];
          let lastTimestampMs: number | null = null;
          let minTimestampMs: number | null = null;
          // Each response chunk: first tick is absolute price, subsequent are deltas (cTrader format)
          // Ticks are in descending order (newest first)
          let lastPrice: number | null = null;
          for (const t of ticks) {
            const tsRaw = protobufLongToNumber(t.timestamp) ?? 0;
            const tickRaw = protobufLongToNumber(t.tick) ?? 0;
            const absTimestamp: number = lastTimestampMs === null ? tsRaw : lastTimestampMs + tsRaw;
            lastTimestampMs = absTimestamp;
            if (minTimestampMs === null || absTimestamp < minTimestampMs) minTimestampMs = absTimestamp;
            // First tick in chunk: absolute price. Subsequent: delta from previous (cTrader format)
            const priceDelta = tickRaw / CTRADER_PRICE_SCALE;
            const tickPrice: number = lastPrice === null ? priceDelta : lastPrice + priceDelta;
            lastPrice = tickPrice;
            result.push({ timestamp: absTimestamp, price: tickPrice });
          }

          const hasMore = response?.hasMore === true;
          if (!hasMore || ticks.length === 0) break;
          // Request older ticks: use oldest timestamp in this chunk as new toTimestamp
          const nextChunkTo = minTimestampMs !== null ? minTimestampMs - 1 : chunkTo - 1;
          if (nextChunkTo < currentFrom) break;
          chunkTo = nextChunkTo;
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (error) {
        logger.warn('getTickData chunk failed', {
          symbol: params.symbol,
          from: new Date(currentFrom).toISOString(),
          to: new Date(currentTo).toISOString(),
          error: serializeErrorForLog(error),
        });
      }

      currentFrom = currentTo + 1;
      if (currentFrom < toTs) {
        await new Promise(r => setTimeout(r, 250));
      }
    }

    result.sort((a, b) => a.timestamp - b.timestamp);
    return result;
  }

  /**
   * Common cTrader symbol aliases by broker (primary -> alternatives).
   * Brokers may use GOLD, GOLD.a, XAUUSDm, etc. instead of XAUUSD.
   */
  private static readonly SYMBOL_ALIASES: Record<string, string[]> = {
    XAUUSD: ['GOLD', 'GOLD.a', 'GOLDm', 'XAUUSDm', 'XAUUSD.i', '#GOLD'],
    XAGUSD: ['SILVER', 'SILVER.a', 'SILVERm', 'XAGUSDm', 'XAGUSD.i', '#SILVER'],
  };

  /**
   * Get symbol information including full volume fields (lotSize, stepVolume, minVolume, maxVolume)
   * Uses ProtoOASymbolsListReq to resolve symbol name -> symbolId, then ProtoOASymbolByIdReq
   * for the full ProtoOASymbol (LightSymbol lacks volume fields).
   * Tries exact match first, then case-insensitive, then known aliases (e.g. XAUUSD -> GOLD).
   */
  async getSymbolInfo(symbol: string): Promise<any> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    if (!this.config.accountId) {
      throw new Error('Account ID is required to get symbol info');
    }

    try {
      const accountIdNum = parseInt(this.config.accountId, 10);
      if (isNaN(accountIdNum)) {
        throw new Error(`Invalid account ID: ${this.config.accountId}`);
      }

      // Step 1: Get symbol ID from symbol name (ProtoOASymbolsListReq returns ProtoOALightSymbol)
      const symbolListResponse = await this.connection.sendCommand('ProtoOASymbolsListReq', {
        ctidTraderAccountId: accountIdNum
      });

      const symbols = symbolListResponse?.symbol || [];
      const symbolVariants = (sym: string): string[] => {
        const v: string[] = [sym];
        const noSlash = sym.replace('/', '');
        const withSlash = sym.length >= 6 ? `${sym.slice(0, 3)}/${sym.slice(-3)}` : null;
        if (noSlash !== sym) v.push(noSlash);
        if (withSlash && withSlash !== sym) v.push(withSlash);
        return [...new Set(v)];
      };
      const symbolsToTry = this.config.symbolMap?.[symbol]
        ? [this.config.symbolMap[symbol], symbol]
        : [symbol];
      let lightSymbol: any = null;
      for (const sym of symbolsToTry) {
        for (const variant of symbolVariants(sym)) {
          lightSymbol = symbols.find((s: any) => s.symbolName === variant);
          if (!lightSymbol) {
            lightSymbol = symbols.find((s: any) => s.symbolName?.toUpperCase() === variant?.toUpperCase());
          }
          if (lightSymbol) {
            if (sym !== symbol || variant !== symbol) {
              const viaMap = this.config.symbolMap?.[symbol] === sym;
              logger.debug('Resolved cTrader symbol', {
                requested: symbol,
                resolved: lightSymbol.symbolName,
                ...(viaMap && { viaSymbolMap: true })
              });
            }
            break;
          }
        }
        if (lightSymbol) break;
      }

      if (!lightSymbol) {
        const aliases = CTraderClient.SYMBOL_ALIASES[symbol.toUpperCase()];
        if (aliases) {
          for (const alias of aliases) {
            lightSymbol = symbols.find((s: any) => s.symbolName === alias || s.symbolName?.toUpperCase() === alias);
            if (lightSymbol) {
              logger.debug('Resolved cTrader symbol via alias', { requested: symbol, alias, brokerSymbol: lightSymbol.symbolName });
              break;
            }
          }
        }
      }
      if (!lightSymbol) {
        // Fuzzy fallback: for XAUUSD, find symbols containing GOLD or XAU (broker-specific naming)
        const upper = symbol.toUpperCase();
        if (upper.includes('XAU') || upper === 'GOLD') {
          lightSymbol = symbols.find((s: any) => {
            const name = (s.symbolName || '').toUpperCase();
            return name.includes('XAU') || name.includes('GOLD');
          });
          if (lightSymbol) {
            logger.debug('Resolved cTrader symbol via fuzzy match', { requested: symbol, brokerSymbol: lightSymbol.symbolName });
          }
        }
      }
      if (!lightSymbol) {
        throw new Error(`Symbol ${symbol} not found`);
      }

      const symbolId = typeof lightSymbol.symbolId === 'object' && lightSymbol.symbolId?.low !== undefined
        ? lightSymbol.symbolId.low
        : lightSymbol.symbolId;

      // Step 2: Fetch full ProtoOASymbol (includes lotSize, stepVolume, minVolume, maxVolume)
      const fullSymbolResponse = await this.connection.sendCommand('ProtoOASymbolByIdReq', {
        ctidTraderAccountId: accountIdNum,
        symbolId: [symbolId]
      });

      const fullSymbols = fullSymbolResponse?.symbol || [];
      const fullSymbol = fullSymbols.find((s: any) => {
        const sid = typeof s.symbolId === 'object' && s.symbolId?.low !== undefined ? s.symbolId.low : s.symbolId;
        return sid === symbolId;
      });

      // Merge: prefer full symbol, fall back to light for name/enabled etc
      const result = fullSymbol
        ? { ...lightSymbol, ...fullSymbol, symbolName: symbol }
        : { ...lightSymbol, symbolName: symbol };
      return result;
    } catch (error) {
      logger.error('Failed to get symbol info', {
        symbol,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Place a market order.
   * Optionally set SL/TP on the order. For MARKET orders, cTrader only accepts RELATIVE values
   * (relativeStopLoss/relativeTakeProfit), not absolute prices. Pass relative when useRelativeSlTp is true.
   */
  async placeMarketOrder(params: {
    symbol: string;
    volume: number;
    tradeSide: 'BUY' | 'SELL';
    /** Optional. Relative SL in 1/100000 of price unit. For BUY: sl = entry - relative; for SELL: sl = entry + relative */
    relativeStopLoss?: number;
    /** Optional. Relative TP in 1/100000 of price unit. For BUY: tp = entry + relative; for SELL: tp = entry - relative */
    relativeTakeProfit?: number;
    /** Optional. User label (max 100 chars) - groups positions for management */
    label?: string;
  }): Promise<string> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const symbolInfo = await this.getSymbolInfo(params.symbol);
      const lotSize = typeof symbolInfo.lotSize === 'object' && symbolInfo.lotSize?.low !== undefined
        ? symbolInfo.lotSize.low
        : symbolInfo.lotSize ?? 100;
      const stepVolume = typeof symbolInfo.stepVolume === 'object' && symbolInfo.stepVolume?.low !== undefined
        ? symbolInfo.stepVolume.low
        : symbolInfo.stepVolume ?? lotSize;
      const volumeInApiUnits = Math.floor((params.volume * lotSize) / stepVolume) * stepVolume;
      const symbolId = typeof symbolInfo.symbolId === 'object' && symbolInfo.symbolId?.low !== undefined
        ? symbolInfo.symbolId.low
        : symbolInfo.symbolId;
      const payload: Record<string, unknown> = {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        symbolId,
        orderType: 'MARKET',
        tradeSide: params.tradeSide === 'BUY' ? 'BUY' : 'SELL',
        volume: volumeInApiUnits
      };
      // cTrader MARKET orders only accept relative SL/TP (absolute values are rejected)
      if (params.relativeStopLoss != null && params.relativeStopLoss > 0) {
        payload.relativeStopLoss = params.relativeStopLoss;
      }
      if (params.relativeTakeProfit != null && params.relativeTakeProfit > 0) {
        payload.relativeTakeProfit = params.relativeTakeProfit;
      }
      if (params.label != null && params.label !== '') {
        payload.label = params.label.slice(0, 100);
      }
      const response = await this.connection.sendCommand('ProtoOANewOrderReq', payload);

      const orderId = response?.orderId || response?.order?.orderId;
      if (!orderId) {
        throw new Error('No order ID returned from cTrader');
      }

      logger.info('Market order placed on cTrader', {
        orderId,
        symbol: params.symbol,
        tradeSide: params.tradeSide,
        volume: params.volume,
        ...(params.relativeStopLoss != null && { relativeStopLoss: params.relativeStopLoss }),
        ...(params.relativeTakeProfit != null && { relativeTakeProfit: params.relativeTakeProfit })
      });

      return orderId.toString();
    } catch (error) {
      logger.error('Failed to place market order', {
        symbol: params.symbol,
        tradeSide: params.tradeSide,
        volume: params.volume,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Place a limit order.
   * When positionId is provided, the order is linked to that position (closing/reduce behaviour when side is opposite).
   * Use positionId for TP orders as a guard - ensures we modify our position, not open a new one.
   */
  async placeLimitOrder(params: {
    symbol: string;
    volume: number;
    tradeSide: 'BUY' | 'SELL';
    price: number;
    /** Optional. Link order to position (cTrader "modify position") - use for TP orders as reduce-only-like guard */
    positionId?: string;
    /** Optional. Absolute stop loss - set on resulting position when order fills */
    stopLoss?: number;
    /** Optional. Absolute take profit - set on resulting position when order fills */
    takeProfit?: number;
    /** Optional. User label (max 100 chars) - groups positions for management */
    label?: string;
  }): Promise<string> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const symbolInfo = await this.getSymbolInfo(params.symbol);
      // cTrader volume is in 0.01 of a unit. lotSize from symbolInfo is in cents; volume = qty_lots * lotSize
      const lotSize = typeof symbolInfo.lotSize === 'object' && symbolInfo.lotSize?.low !== undefined
        ? symbolInfo.lotSize.low
        : symbolInfo.lotSize ?? 100;
      const stepVolume = typeof symbolInfo.stepVolume === 'object' && symbolInfo.stepVolume?.low !== undefined
        ? symbolInfo.stepVolume.low
        : symbolInfo.stepVolume ?? lotSize;
      // Round down to multiple of stepVolume (e.g. 8.33 lots with step 1.0 → 8 lots)
      const volumeInApiUnits = Math.floor((params.volume * lotSize) / stepVolume) * stepVolume;
      const symbolId = typeof symbolInfo.symbolId === 'object' && symbolInfo.symbolId?.low !== undefined
        ? symbolInfo.symbolId.low
        : symbolInfo.symbolId;
      logger.info('Placing limit order with volume conversion', {
        symbol: params.symbol,
        qtyLots: params.volume,
        lotSize,
        stepVolume,
        volumeInApiUnits,
        accountId: this.config.accountId,
        exchange: 'ctrader'
      });
      const payload: Record<string, unknown> = {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        symbolId,
        orderType: 'LIMIT',
        tradeSide: params.tradeSide === 'BUY' ? 'BUY' : 'SELL',
        volume: volumeInApiUnits,
        limitPrice: params.price,
        timeInForce: 'GOOD_TILL_CANCEL' // Keep order on book until filled or manually cancelled (default may vary by broker)
      };
      if (params.positionId != null && params.positionId !== '') {
        payload.positionId = parseInt(params.positionId, 10);
      }
      if (params.stopLoss != null && params.stopLoss > 0) {
        payload.stopLoss = params.stopLoss;
      }
      if (params.takeProfit != null && params.takeProfit > 0) {
        payload.takeProfit = params.takeProfit;
      }
      if (params.label != null && params.label !== '') {
        payload.label = params.label.slice(0, 100);
      }
      const response = await this.connection.sendCommand('ProtoOANewOrderReq', payload);

      const orderId = response?.orderId || response?.order?.orderId;
      if (!orderId) {
        throw new Error('No order ID returned from cTrader');
      }

      logger.info('Limit order placed on cTrader', {
        orderId,
        symbol: params.symbol,
        tradeSide: params.tradeSide,
        volume: params.volume,
        price: params.price,
        positionId: params.positionId ?? undefined,
        accountId: this.config.accountId,
        exchange: 'ctrader'
      });

      return orderId.toString();
    } catch (error) {
      logger.error('Failed to place limit order', {
        symbol: params.symbol,
        tradeSide: params.tradeSide,
        volume: params.volume,
        price: params.price,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Place a stop-limit order. Activates when price reaches stopPrice, then executes as limit at limitPrice.
   * Use for breakeven: stops only when price retraces to entry, unlike a plain limit which fills immediately.
   */
  async placeStopLimitOrder(params: {
    symbol: string;
    volume: number;
    tradeSide: 'BUY' | 'SELL';
    limitPrice: number;
    stopPrice: number;
    /** Link order to position (closing/reduce behaviour when side is opposite) */
    positionId?: string;
  }): Promise<string> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const symbolInfo = await this.getSymbolInfo(params.symbol);
      const lotSize = typeof symbolInfo.lotSize === 'object' && symbolInfo.lotSize?.low !== undefined
        ? symbolInfo.lotSize.low
        : symbolInfo.lotSize ?? 100;
      const stepVolume = typeof symbolInfo.stepVolume === 'object' && symbolInfo.stepVolume?.low !== undefined
        ? symbolInfo.stepVolume.low
        : symbolInfo.stepVolume ?? lotSize;
      const volumeInApiUnits = Math.floor((params.volume * lotSize) / stepVolume) * stepVolume;
      const symbolId = typeof symbolInfo.symbolId === 'object' && symbolInfo.symbolId?.low !== undefined
        ? symbolInfo.symbolId.low
        : symbolInfo.symbolId;
      const payload: Record<string, unknown> = {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        symbolId,
        orderType: 'STOP_LIMIT',
        tradeSide: params.tradeSide === 'BUY' ? 'BUY' : 'SELL',
        volume: volumeInApiUnits,
        limitPrice: params.limitPrice,
        stopPrice: params.stopPrice,
        timeInForce: 'GOOD_TILL_CANCEL'
      };
      if (params.positionId != null && params.positionId !== '') {
        payload.positionId = parseInt(params.positionId, 10);
      }
      const response = await this.connection.sendCommand('ProtoOANewOrderReq', payload);

      const orderId = response?.orderId || response?.order?.orderId;
      if (!orderId) {
        throw new Error('No order ID returned from cTrader');
      }

      logger.info('Stop-limit order placed on cTrader', {
        orderId,
        symbol: params.symbol,
        tradeSide: params.tradeSide,
        volume: params.volume,
        limitPrice: params.limitPrice,
        stopPrice: params.stopPrice,
        positionId: params.positionId ?? undefined,
        accountId: this.config.accountId,
        exchange: 'ctrader'
      });

      return orderId.toString();
    } catch (error) {
      logger.error('Failed to place stop-limit order', {
        symbol: params.symbol,
        tradeSide: params.tradeSide,
        volume: params.volume,
        limitPrice: params.limitPrice,
        stopPrice: params.stopPrice,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Get raw reconcile response (positions + orders in one call).
   * Useful for debugging - use getOpenPositions/getOpenOrders for normal usage.
   */
  async getReconcile(): Promise<{ position?: any[]; order?: any[]; [key: string]: any }> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }
    return this.connection.sendCommand('ProtoOAReconcileReq', {
      ctidTraderAccountId: parseInt(this.config.accountId!, 10)
    });
  }

  /**
   * Get open positions and orders in a single reconcile call.
   * Use when monitor needs both - avoids duplicate reconcile timeouts for closed trades.
   */
  async getOpenPositionsAndOrders(): Promise<{ positions: any[]; orders: any[] }> {
    const response = await this.getReconcile();
    const positions = response?.position || [];
    const orders = response?.order || [];

    let enrichedPositions = positions;
    if (positions.length > 0) {
      const symbolList = await this.connection!.sendCommand('ProtoOASymbolsListReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10)
      });
      const symbols = symbolList?.symbol || [];
      const symbolIdToName = new Map<number, string>();
      for (const s of symbols) {
        const id = typeof s.symbolId === 'object' && s.symbolId?.low != null ? s.symbolId.low : s.symbolId;
        if (s.symbolName != null) symbolIdToName.set(id, s.symbolName);
      }
      enrichedPositions = positions.map((p: any) => {
        const symbolId = p.tradeData?.symbolId;
        const id = typeof symbolId === 'object' && symbolId?.low != null ? symbolId.low : symbolId;
        const symbolName = id != null ? symbolIdToName.get(id) : undefined;
        const volume = p.tradeData?.volume;
        const vol = typeof volume === 'object' && volume?.low != null ? volume.low : volume;
        const tradeSide = p.tradeData?.tradeSide;
        const side = typeof tradeSide === 'number' ? (tradeSide === 1 ? 'BUY' : tradeSide === 2 ? 'SELL' : undefined) ?? tradeSide : tradeSide;
        return {
          ...p,
          symbolName: symbolName ?? p.symbolName,
          symbol: symbolName ?? p.symbol,
          volume: vol ?? p.volume,
          quantity: vol ?? p.quantity,
          tradeSide: side ?? p.tradeSide,
          side: side ?? p.side,
          positionId: typeof p.positionId === 'object' && p.positionId?.low != null ? p.positionId.low : p.positionId,
          id: typeof p.positionId === 'object' && p.positionId?.low != null ? p.positionId.low : p.positionId,
          stopLoss: p.stopLoss,
          avgPrice: p.price ?? p.avgPrice,
          averagePrice: p.price ?? p.averagePrice
        };
      });
    }

    const enrichedOrders = orders.map((o: any) => {
      const orderId = typeof o.orderId === 'object' && o.orderId?.low != null ? o.orderId.low : o.orderId;
      return { ...o, orderId: orderId != null ? String(orderId) : o.orderId, id: orderId ?? o.id };
    });

    return { positions: enrichedPositions, orders: enrichedOrders };
  }

  /**
   * Get open positions (uses ProtoOAReconcileReq; positions have tradeData.symbolId, we enrich with symbolName)
   */
  async getOpenPositions(): Promise<any[]> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const response = await this.connection.sendCommand('ProtoOAReconcileReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10)
      });

      const positions = response?.position || [];
      if (positions.length === 0) return positions;

      // Build symbolId -> symbolName map (ProtoOAPosition has tradeData.symbolId, initiator matches by symbolName)
      const symbolList = await this.connection.sendCommand('ProtoOASymbolsListReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10)
      });
      const symbols = symbolList?.symbol || [];
      const symbolIdToName = new Map<number, string>();
      for (const s of symbols) {
        const id = typeof s.symbolId === 'object' && s.symbolId?.low != null ? s.symbolId.low : s.symbolId;
        if (s.symbolName != null) symbolIdToName.set(id, s.symbolName);
      }

      return positions.map((p: any) => {
        const symbolId = p.tradeData?.symbolId;
        const id = typeof symbolId === 'object' && symbolId?.low != null ? symbolId.low : symbolId;
        const symbolName = id != null ? symbolIdToName.get(id) : undefined;
        const volume = p.tradeData?.volume;
        const vol = typeof volume === 'object' && volume?.low != null ? volume.low : volume;
        const tradeSide = p.tradeData?.tradeSide;
        // ProtoOATradeSide: BUY=1, SELL=2 (1-based enum). Do NOT use as 0-based array index.
        const side = typeof tradeSide === 'number' ? (tradeSide === 1 ? 'BUY' : tradeSide === 2 ? 'SELL' : undefined) ?? tradeSide : tradeSide;
        return {
          ...p,
          symbolName: symbolName ?? p.symbolName,
          symbol: symbolName ?? p.symbol,
          volume: vol ?? p.volume,
          quantity: vol ?? p.quantity,
          tradeSide: side ?? p.tradeSide,
          side: side ?? p.side,
          positionId: typeof p.positionId === 'object' && p.positionId?.low != null ? p.positionId.low : p.positionId,
          id: typeof p.positionId === 'object' && p.positionId?.low != null ? p.positionId.low : p.positionId,
          stopLoss: p.stopLoss,
          avgPrice: p.price ?? p.avgPrice,
          averagePrice: p.price ?? p.averagePrice
        };
      });
    } catch (error) {
      logger.error('Failed to get open positions', {
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Get open orders (uses ProtoOAReconcileReq; enriches orderId for monitor matching)
   */
  async getOpenOrders(): Promise<any[]> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const response = await this.connection.sendCommand('ProtoOAReconcileReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10)
      });

      const orders = response?.order || [];
      return orders.map((o: any) => {
        const orderId = typeof o.orderId === 'object' && o.orderId?.low != null ? o.orderId.low : o.orderId;
        return { ...o, orderId: orderId != null ? String(orderId) : o.orderId, id: orderId ?? o.id };
      });
    } catch (error) {
      logger.error('Failed to get open orders', {
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Get deal history (executions) within a time window.
   * Uses ProtoOADealListReq. Deals include orderId - useful to find if an order was filled.
   * Wrapped with rate limit retry (cTrader historical limit: 5 req/sec).
   */
  async getDealList(fromTimestamp: number, toTimestamp: number, maxRows: number = 1000): Promise<any[]> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    const maxWindow = 604800000; // 1 week
    if (toTimestamp - fromTimestamp > maxWindow) {
      toTimestamp = fromTimestamp + maxWindow;
    }

    try {
      return await withCTraderRateLimitRetry(
        async () => {
          const { protobufLongToNumber } = await import('../utils/protobufLong.js');
          const toNum = (v: any) => (typeof v === 'object' && v?.low != null ? protobufLongToNumber(v) : v);
          const allDeals: any[] = [];
          let currentTo = toTimestamp;
          let hasMore = true;

          while (hasMore) {
            const response = await this.connection!.sendCommand('ProtoOADealListReq', {
              ctidTraderAccountId: parseInt(this.config.accountId!, 10),
              fromTimestamp,
              toTimestamp: currentTo,
              maxRows
            });

            const deals = response?.deal || [];
            allDeals.push(...deals);
            hasMore = response?.hasMore === true && deals.length > 0;
            if (hasMore && deals.length > 0) {
              const oldestTs = Math.min(...deals.map((d: any) => Number(toNum(d.executionTimestamp ?? d.execution_timestamp) ?? 0)));
              currentTo = oldestTs - 1;
              if (currentTo < fromTimestamp) hasMore = false;
            } else {
              hasMore = false;
            }
          }

          const deals = allDeals;
          return deals.map((d: any) => {
            const orderId = typeof d.orderId === 'object' && d.orderId?.low != null ? d.orderId.low : d.orderId;
            const positionId = typeof d.positionId === 'object' && d.positionId?.low != null ? d.positionId.low : d.positionId;
            return {
              ...d,
              orderId: orderId != null ? String(orderId) : d.orderId,
              positionId: positionId != null ? String(positionId) : d.positionId,
              dealStatus: d.dealStatus ?? d.deal_status,
              executionPrice: d.executionPrice ?? d.execution_price
            };
          });
        },
        { label: 'getDealList' }
      );
    } catch (error) {
      logger.error('Failed to get deal list', {
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Get deals for a specific position within a time window.
   * Uses ProtoOADealListByPositionIdReq.
   * Wrapped with rate limit retry (cTrader historical limit: 5 req/sec).
   */
  async getDealListByPositionId(
    positionId: string,
    fromTimestamp: number,
    toTimestamp: number
  ): Promise<any[]> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    const maxWindow = 604800000; // 1 week
    if (toTimestamp - fromTimestamp > maxWindow) {
      toTimestamp = fromTimestamp + maxWindow;
    }

    try {
      return await withCTraderRateLimitRetry(
        async () => {
          const { protobufLongToNumber } = await import('../utils/protobufLong.js');
          const toNum = (v: any) => (typeof v === 'object' && v?.low != null ? protobufLongToNumber(v) : v);
          const allDeals: any[] = [];
          let currentFrom = fromTimestamp;
          let hasMore = true;

          while (hasMore) {
            const response = await this.connection!.sendCommand('ProtoOADealListByPositionIdReq', {
              ctidTraderAccountId: parseInt(this.config.accountId!, 10),
              positionId: parseInt(positionId, 10),
              fromTimestamp: currentFrom,
              toTimestamp
            });

            const deals = response?.deal || [];
            allDeals.push(...deals);
            hasMore = response?.hasMore === true && deals.length > 0;
            if (hasMore && deals.length > 0) {
              const lastTs = Math.max(...deals.map((d: any) => Number(toNum(d.executionTimestamp ?? d.execution_timestamp) ?? 0)));
              currentFrom = lastTs + 1;
              if (currentFrom >= toTimestamp) hasMore = false;
            } else {
              hasMore = false;
            }
          }

          const deals = allDeals;
          return deals.map((d: any) => {
            const orderId = typeof d.orderId === 'object' && d.orderId?.low != null ? d.orderId.low : d.orderId;
            const posId = typeof d.positionId === 'object' && d.positionId?.low != null ? d.positionId.low : d.positionId;
            return {
              ...d,
              orderId: orderId != null ? String(orderId) : d.orderId,
              positionId: posId != null ? String(posId) : d.positionId,
              dealStatus: d.dealStatus ?? d.deal_status,
              executionPrice: d.executionPrice ?? d.execution_price
            };
          });
        },
        { label: 'getDealListByPositionId' }
      );
    } catch (error) {
      logger.error('Failed to get deal list by position', {
        positionId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Resolve positionId from an entry orderId via deal history.
   * When an entry order fills, it creates a deal; the deal links orderId → positionId.
   * Use this to find the exact position created by our order (avoids symbol-based find
   * which can return the wrong position when multiple positions exist for the same symbol).
   */
  async getPositionIdByEntryOrderId(
    orderId: string,
    fromTimestamp?: number,
    toTimestamp?: number
  ): Promise<string | null> {
    const to = toTimestamp ?? Date.now();
    const from = fromTimestamp ?? to - 5 * 60 * 1000; // default: last 5 min
    const deals = await this.getDealList(from, to);
    const deal = deals.find((d: any) => String(d.orderId) === String(orderId));
    const posId = deal?.positionId;
    return posId != null ? String(posId) : null;
  }

  /**
   * Get closed orders (cancelled, filled, expired) within a time window.
   * Uses ProtoOAOrderListReq. Max window 1 week (604800000 ms).
   * Wrapped with rate limit retry (cTrader historical limit: 5 req/sec).
   */
  async getClosedOrders(fromTimestamp: number, toTimestamp: number): Promise<any[]> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    const maxWindow = 604800000; // 1 week
    if (toTimestamp - fromTimestamp > maxWindow) {
      toTimestamp = fromTimestamp + maxWindow;
    }

    try {
      return await withCTraderRateLimitRetry(
        async () => {
          const response = await this.connection!.sendCommand('ProtoOAOrderListReq', {
            ctidTraderAccountId: parseInt(this.config.accountId!, 10),
            fromTimestamp,
            toTimestamp
          });

          const orders = response?.order || [];
          return orders.map((o: any) => {
            const orderId = typeof o.orderId === 'object' && o.orderId?.low != null ? o.orderId.low : o.orderId;
            const status = o.orderStatus ?? o.order_status ?? 'unknown';
            const statusStr = typeof status === 'number'
              ? ['', 'ACCEPTED', 'FILLED', 'REJECTED', 'EXPIRED', 'CANCELLED'][status] || String(status)
              : String(status);
            return {
              ...o,
              orderId: orderId != null ? String(orderId) : o.orderId,
              id: orderId ?? o.id,
              orderStatus: statusStr,
              limitPrice: o.limitPrice ?? o.limit_price,
              executionPrice: o.executionPrice ?? o.execution_price
            };
          });
        },
        { label: 'getClosedOrders' }
      );
    } catch (error) {
      logger.error('Failed to get closed orders', {
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<void> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      await this.connection.sendCommand('ProtoOACancelOrderReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        orderId: parseInt(orderId, 10)
      });

      logger.info('Order cancelled on cTrader', {
        orderId,
        accountId: this.config.accountId,
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.error('Failed to cancel order', {
        orderId,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Modify position (set stop loss, take profit)
   */
  async modifyPosition(params: {
    positionId: string;
    stopLoss?: number;
    takeProfit?: number;
  }): Promise<void> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      await this.connection.sendCommand('ProtoOAAmendPositionSLTPReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        positionId: parseInt(params.positionId, 10),
        ...(params.stopLoss !== undefined && { stopLoss: params.stopLoss }),
        ...(params.takeProfit !== undefined && { takeProfit: params.takeProfit })
      });

      logger.info('Position modified on cTrader', params);
    } catch (error) {
      logger.error('Failed to modify position', {
        positionId: params.positionId,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Close position (full or partial).
   * Uses ProtoOAClosePositionReq - the proper API for closing, never opens new positions.
   * @param positionId - Position to close
   * @param volumeLots - Optional. If provided with symbol, does partial close. If omitted, fetches position and closes all.
   * @param symbol - Required when volumeLots provided (for volume conversion to API units)
   */
  async closePosition(positionId: string, volumeLots?: number, symbol?: string): Promise<void> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    const { protobufLongToNumber } = await import('../utils/protobufLong.js');

    try {
      let volumeInApiUnits: number;

      if (volumeLots != null && symbol != null) {
        const symbolInfo = await this.getSymbolInfo(symbol);
        const lotSize = typeof symbolInfo.lotSize === 'object' && symbolInfo.lotSize?.low !== undefined
          ? symbolInfo.lotSize.low
          : symbolInfo.lotSize ?? 100;
        const stepVolume = typeof symbolInfo.stepVolume === 'object' && symbolInfo.stepVolume?.low !== undefined
          ? symbolInfo.stepVolume.low
          : symbolInfo.stepVolume ?? lotSize;
        volumeInApiUnits = Math.max(1, Math.floor((volumeLots * lotSize) / stepVolume) * stepVolume);
      } else {
        const positions = await this.getOpenPositions();
        const position = positions.find((p: any) => {
          const pid = typeof p.positionId === 'object' && p.positionId?.low != null
            ? protobufLongToNumber(p.positionId)
            : p.positionId ?? p.id;
          return pid != null && String(pid) === String(positionId);
        });
        if (!position) {
          throw new Error(`Position ${positionId} not found for full close`);
        }
        const vol = position.volume ?? position.quantity;
        volumeInApiUnits = typeof vol === 'object' && vol?.low != null ? protobufLongToNumber(vol) ?? 0 : Number(vol) ?? 0;
        if (volumeInApiUnits <= 0) {
          throw new Error(`Position ${positionId} has no volume to close`);
        }
      }

      await this.connection.sendCommand('ProtoOAClosePositionReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        positionId: parseInt(positionId, 10),
        volume: volumeInApiUnits
      });

      logger.info('Position closed on cTrader', {
        positionId,
        volumeInApiUnits: volumeLots != null ? `${volumeLots} lots` : 'full',
        accountId: this.config.accountId,
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.error('Failed to close position', {
        positionId,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      throw error;
    }
  }

  /**
   * Get current price for a symbol
   * Subscribes to spot events and waits for the first spot event which contains current prices.
   * Concurrent calls for the same symbol share one subscription (coalesced).
   * @param side - When provided, returns ask for 'buy' and bid for 'sell' to improve fill probability
   *               on limit orders. When omitted, returns mid price (bid+ask)/2.
   */
  async getCurrentPrice(symbol: string, side?: 'buy' | 'sell'): Promise<number | null> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    if (!this.config.accountId) {
      throw new Error('Account ID is required to get current price');
    }

    const timeoutMs = this.config.spotPriceTimeoutMs ?? 8000;
    const maxRetries = this.config.spotPriceMaxRetries ?? 3;

    // Coalesce concurrent requests for same symbol - one subscription, all share result
    let promise = this.inFlightSpotRequests.get(symbol);
    if (!promise) {
      promise = this.fetchSpotPriceWithRetry(symbol, timeoutMs, maxRetries);
      this.inFlightSpotRequests.set(symbol, promise);
      promise.finally(() => this.inFlightSpotRequests.delete(symbol));
    }

    const result = await promise;
    if (!result) return null;

    if (side === 'buy') return result.ask;
    if (side === 'sell') return result.bid;
    return (result.bid + result.ask) / 2;
  }

  /**
   * Fetch spot bid/ask with retries and diagnostics.
   * Used internally by getCurrentPrice (coalesced per symbol).
   */
  private async fetchSpotPriceWithRetry(
    symbol: string,
    timeoutMs: number,
    maxRetries: number
  ): Promise<SpotPriceResult> {
    let lastReason: 'timeout' | 'subscribe_failed' | 'empty_spot_event' | 'symbol_lookup' | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.fetchSpotPriceOnce(symbol, timeoutMs);
      if (result && 'bid' in result && 'ask' in result) {
        return result;
      }
      const fail = result as { reason?: string; error?: string };
      lastReason = fail?.reason as typeof lastReason;
      lastError = fail?.error;
      if (attempt < maxRetries) {
        logger.debug('Retrying cTrader spot price fetch', { symbol, attempt, reason: lastReason });
      }
    }

    logger.warn('cTrader getCurrentPrice failed after retries', {
      symbol,
      attempts: maxRetries,
      reason: lastReason,
      error: lastError,
      exchange: 'ctrader'
    });
    return null;
  }

  /**
   * Single attempt to fetch spot price. Returns {bid,ask} or failure info.
   */
  private async fetchSpotPriceOnce(
    symbol: string,
    timeoutMs: number
  ): Promise<SpotPriceResult | { reason: string; error?: string }> {
    try {
      const symbolInfo = await this.getSymbolInfo(symbol);
      const symbolId = typeof symbolInfo.symbolId === 'object' && symbolInfo.symbolId.low !== undefined
        ? symbolInfo.symbolId.low
        : symbolInfo.symbolId;

      const connection = this.connection;
      if (!connection) return { reason: 'symbol_lookup', error: 'No connection' };

      const accountId = this.config.accountId;
      if (!accountId) return { reason: 'symbol_lookup', error: 'No account ID' };

      return new Promise<SpotPriceResult | { reason: string; error?: string }>((resolve) => {
        let listenerId: string | undefined;
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved && listenerId) {
            connection.removeEventListener(listenerId);
          }
          if (!resolved) {
            resolved = true;
            resolve({ reason: 'timeout', error: `No spot event within ${timeoutMs}ms` });
          }
        }, timeoutMs);

        const idResult = connection.on('ProtoOASpotEvent', (ctraderEvent: any) => {
          if (resolved) return;

          const event = ctraderEvent.descriptor || ctraderEvent;
          const eventSymbolId = typeof event.symbolId === 'object' && event.symbolId.low !== undefined
            ? event.symbolId.low
            : event.symbolId;

          if (eventSymbolId === symbolId) {
            resolved = true;
            clearTimeout(timeout);

            const id = idResult;
            if (typeof id === 'string') {
              connection.removeEventListener(id);
            }

            const bid = event.bid ? event.bid / 100000 : null;
            const ask = event.ask ? event.ask / 100000 : null;

            if (bid && ask) {
              resolve({ bid, ask });
            } else if (bid) {
              resolve({ bid, ask: bid });
            } else if (ask) {
              resolve({ bid: ask, ask });
            } else {
              resolve({ reason: 'empty_spot_event', error: 'Spot event had no bid or ask' });
            }
          }
        });

        const id = idResult;
        if (typeof id === 'string') {
          listenerId = id;
        }

        connection.sendCommand('ProtoOASubscribeSpotsReq', {
          ctidTraderAccountId: parseInt(accountId, 10),
          symbolId: [symbolId]
        }).catch((error) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            if (listenerId) {
              connection.removeEventListener(listenerId);
            }
            resolve({
              reason: 'subscribe_failed',
              error: serializeErrorForLog(error)
            });
          }
        });
      });
    } catch (error) {
      return {
        reason: 'symbol_lookup',
        error: serializeErrorForLog(error)
      };
    }
  }

  /**
   * Disconnect from cTrader OpenAPI
   */
  async disconnect(): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.close();
      } catch (error) {
        logger.warn('Error closing cTrader connection', {
          error: serializeErrorForLog(error)
        });
      }
      this.connection = null;
      this.connected = false;
      this.authenticated = false;
    }
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected && this.connection !== null;
  }
}
