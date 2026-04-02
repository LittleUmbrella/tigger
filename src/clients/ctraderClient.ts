import { logger } from '../utils/logger.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';
import { withCTraderRateLimitRetry } from '../utils/ctraderRateLimitRetry.js';
import { CTraderConnection } from '../lib/ctrader/CTraderConnection.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';

/** Normalize cTrader proto int64 positionId to string, or null if missing */
export const normalizeCtraderPositionIdField = (raw: unknown): string | null => {
  if (raw == null || raw === '' || raw === 0) return null;
  const n =
    typeof raw === 'number' && !isNaN(raw) ? raw : protobufLongToNumber(raw);
  if (n == null || !isFinite(n) || n <= 0) return null;
  return String(Math.trunc(n));
};

/**
 * ProtoOAOrder has optional positionId (field 19); deals also carry positionId.
 * Prefer order-level id — deal list may be empty in OrderDetailsRes while positionId is set on the order.
 */
export const extractPositionIdFromCtraderOrderDetails = (
  order: any,
  deals: any[] | undefined | null
): string | null => {
  if (!order) return null;
  const fromOrder = normalizeCtraderPositionIdField(order.positionId ?? order.position_id);
  if (fromOrder) return fromOrder;
  for (const d of deals ?? []) {
    const pid = normalizeCtraderPositionIdField(d?.positionId ?? d?.position_id);
    if (pid) return pid;
  }
  return null;
};

export const isCtraderOrderStatusFilled = (order: any): boolean => {
  if (!order) return false;
  const s = order.orderStatus ?? order.order_status;
  return s === 2 || s === 'FILLED' || s === 'ORDER_STATUS_FILLED';
};

export const getCtraderOrderExecutionPrice = (order: any): number | undefined => {
  if (!order) return undefined;
  const ex = order.executionPrice ?? order.execution_price;
  if (typeof ex === 'number' && isFinite(ex) && ex > 0) return ex;
  if (typeof ex === 'string') {
    const p = parseFloat(ex);
    return isFinite(p) && p > 0 ? p : undefined;
  }
  return undefined;
};

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
  /**
   * Broker symbol metadata (id, volumes, etc.) rarely changes for an account; long TTL avoids repeat SymbolsList/SymbolById
   * traffic. Cleared on disconnect.
   */
  private symbolInfoCache = new Map<string, { expiresAt: number; data: any }>();
  private static readonly SYMBOL_INFO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 25_000;
  private reconnecting: boolean = false;

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
    if (this.connected && this.connection?.isConnected()) {
      return;
    }

    this.stopHeartbeat();

    try {
      this.connection = new CTraderConnection({
        host: this.config.host!,
        port: this.config.port!
      });

      this.connection.onClose = () => {
        logger.warn('cTrader connection lost — marking client disconnected for auto-reconnect', {
          accountId: this.config.accountId,
          exchange: 'ctrader'
        });
        this.connected = false;
        this.authenticated = false;
        this.stopHeartbeat();
      };

      await this.connection.open();
      this.connected = true;
      this.startHeartbeat();
      
      logger.info('Connected to cTrader OpenAPI', {
        host: this.config.host,
        port: this.config.port,
        environment: this.config.environment
      });
    } catch (error) {
      this.connected = false;
      this.authenticated = false;
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
      await this.connection.sendCommand('ProtoOAApplicationAuthReq', {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret
      });

      logger.info('Application authenticated with cTrader OpenAPI');

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

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.connection?.isConnected()) {
        this.connection.sendHeartbeat();
      } else if (this.connected) {
        logger.warn('Heartbeat detected dead socket — marking disconnected', {
          accountId: this.config.accountId,
          exchange: 'ctrader'
        });
        this.connected = false;
        this.authenticated = false;
        this.stopHeartbeat();
      }
    }, CTraderClient.HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Ensure connection is alive and authenticated; reconnect if needed.
   * Throws if reconnection fails — callers should catch and handle gracefully.
   */
  async ensureConnected(): Promise<void> {
    const socketAlive = this.connection?.isConnected() ?? false;
    if (this.authenticated && socketAlive) return;

    if (this.reconnecting) {
      throw new Error('cTrader reconnection already in progress');
    }
    this.reconnecting = true;
    try {
      logger.info('cTrader auto-reconnecting', {
        accountId: this.config.accountId,
        wasConnected: this.connected,
        wasAuthenticated: this.authenticated,
        socketAlive,
        exchange: 'ctrader'
      });

      if (this.connection) {
        try { this.connection.close(); } catch { /* already dead */ }
        this.connection = null;
      }
      this.connected = false;
      this.authenticated = false;

      await this.connect();
      await this.authenticate();

      logger.info('cTrader auto-reconnect successful', {
        accountId: this.config.accountId,
        exchange: 'ctrader'
      });
    } finally {
      this.reconnecting = false;
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
    await this.ensureConnected();
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    if (!this.config.accountId) {
      throw new Error('Account ID is required to get symbol info');
    }

    const now = Date.now();
    const cached = this.symbolInfoCache.get(symbol);
    if (cached && cached.expiresAt > now) {
      return cached.data;
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
      this.symbolInfoCache.set(symbol, {
        expiresAt: now + CTraderClient.SYMBOL_INFO_CACHE_TTL_MS,
        data: result
      });
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
   * Get order details and related deals by order ID. Direct lookup - no time window needed.
   * Uses ProtoOAOrderDetailsReq.
   */
  async getOrderDetails(orderId: string): Promise<{ order: any; deals: any[] } | null> {
    await this.ensureConnected();
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }
    try {
      const response = await this.connection.sendCommand('ProtoOAOrderDetailsReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        orderId: parseInt(orderId, 10)
      });
      const order = response?.order;
      const deals = response?.deal || [];
      if (!order) return null;
      return {
        order,
        deals: deals.map((d: any) => {
          const oid = typeof d.orderId === 'object' && d.orderId?.low != null ? d.orderId.low : d.orderId;
          const pid = typeof d.positionId === 'object' && d.positionId?.low != null ? d.positionId.low : d.positionId;
          return { ...d, orderId: oid != null ? String(oid) : d.orderId, positionId: pid != null ? String(pid) : d.positionId };
        })
      };
    } catch (error: any) {
      const code = error?.errorCode ?? error?.error_code;
      if (code === 'ORDER_NOT_FOUND' || (typeof code === 'string' && code.includes('ORDER_NOT_FOUND'))) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Resolve positionId from an entry orderId.
   * Prefers ProtoOAOrderDetailsReq (order.positionId and related deals).
   * Falls back to getDealList when position id is absent from order details.
   */
  async getPositionIdByEntryOrderId(
    orderId: string,
    fromTimestamp?: number,
    toTimestamp?: number,
    options?: {
      allowDealListFallback?: boolean;
      /** When provided, skips a second ProtoOAOrderDetailsReq (same payload as getOrderDetails). */
      prefetchedDetails?: { order: any; deals: any[] } | null;
    }
  ): Promise<string | null> {
    const allowDealListFallback = options?.allowDealListFallback !== false;
    const details =
      options?.prefetchedDetails != null
        ? options.prefetchedDetails
        : await this.getOrderDetails(orderId);
    if (details?.order) {
      const fromDetails = extractPositionIdFromCtraderOrderDetails(details.order, details.deals);
      if (fromDetails) return fromDetails;
    }
    if (!allowDealListFallback) return null;

    const to = toTimestamp ?? Date.now();
    const from = fromTimestamp ?? to - 24 * 60 * 60 * 1000;
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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
   * Modify position (set stop loss, take profit).
   *
   * ProtoOAAmendPositionSLTPReq removes SL/TP when the field is absent from
   * the message. To avoid accidentally wiping the TP when only updating SL
   * (or vice-versa), this method:
   *  1. Fetches the current position to get existing SL/TP
   *  2. Falls back to caller-provided `knownStopLoss`/`knownTakeProfit` (from DB)
   *  3. If the missing field still can't be resolved, aborts without modifying
   */
  async modifyPosition(params: {
    positionId: string;
    stopLoss?: number;
    takeProfit?: number;
    /** Fallback SL from DB — used when exchange position lookup fails */
    knownStopLoss?: number;
    /** Fallback TP from DB — used when exchange position lookup fails */
    knownTakeProfit?: number;
  }): Promise<void> {
    await this.ensureConnected();
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    let effectiveStopLoss = params.stopLoss;
    let effectiveTakeProfit = params.takeProfit;

    if (effectiveStopLoss === undefined || effectiveTakeProfit === undefined) {
      let resolvedFromExchange = false;
      try {
        const response = await this.connection.sendCommand('ProtoOAReconcileReq', {
          ctidTraderAccountId: parseInt(this.config.accountId!, 10)
        });
        const positions: any[] = response?.position || [];
        const posIdNum = parseInt(params.positionId, 10);
        const current = positions.find((p: any) => {
          const pid = typeof p.positionId === 'object' && p.positionId?.low != null
            ? p.positionId.low
            : p.positionId;
          return pid === posIdNum || String(pid) === params.positionId;
        });
        if (current) {
          resolvedFromExchange = true;
          if (effectiveStopLoss === undefined) {
            const sl = typeof current.stopLoss === 'number' ? current.stopLoss : parseFloat(current.stopLoss);
            if (isFinite(sl) && sl > 0) effectiveStopLoss = sl;
          }
          if (effectiveTakeProfit === undefined) {
            const tp = typeof current.takeProfit === 'number' ? current.takeProfit : parseFloat(current.takeProfit);
            if (isFinite(tp) && tp > 0) effectiveTakeProfit = tp;
          }
        }
      } catch (error) {
        logger.warn('Failed to fetch position from exchange for SL/TP preservation', {
          positionId: params.positionId,
          accountId: this.config.accountId,
          exchange: 'ctrader',
          error: serializeErrorForLog(error)
        });
      }

      if (!resolvedFromExchange) {
        if (effectiveStopLoss === undefined && params.knownStopLoss != null && isFinite(params.knownStopLoss) && params.knownStopLoss > 0) {
          effectiveStopLoss = params.knownStopLoss;
        }
        if (effectiveTakeProfit === undefined && params.knownTakeProfit != null && isFinite(params.knownTakeProfit) && params.knownTakeProfit > 0) {
          effectiveTakeProfit = params.knownTakeProfit;
        }
      }

      logger.debug('Resolved SL/TP for position amend', {
        positionId: params.positionId,
        requestedSl: params.stopLoss,
        requestedTp: params.takeProfit,
        effectiveStopLoss,
        effectiveTakeProfit,
        source: resolvedFromExchange ? 'exchange' : 'db-fallback'
      });

      if (effectiveStopLoss === undefined || effectiveTakeProfit === undefined) {
        logger.warn('Aborting position modify — cannot resolve both SL and TP; would wipe the missing field', {
          positionId: params.positionId,
          accountId: this.config.accountId,
          exchange: 'ctrader',
          effectiveStopLoss,
          effectiveTakeProfit,
          requestedSl: params.stopLoss,
          requestedTp: params.takeProfit,
          knownSl: params.knownStopLoss,
          knownTp: params.knownTakeProfit
        });
        return;
      }
    }

    try {
      await this.connection.sendCommand('ProtoOAAmendPositionSLTPReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        positionId: parseInt(params.positionId, 10),
        ...(effectiveStopLoss !== undefined && effectiveStopLoss > 0 && { stopLoss: effectiveStopLoss }),
        ...(effectiveTakeProfit !== undefined && effectiveTakeProfit > 0 && { takeProfit: effectiveTakeProfit })
      });

      logger.info('Position modified on cTrader', {
        positionId: params.positionId,
        stopLoss: effectiveStopLoss,
        takeProfit: effectiveTakeProfit,
        preservedExistingSl: params.stopLoss === undefined && effectiveStopLoss !== undefined,
        preservedExistingTp: params.takeProfit === undefined && effectiveTakeProfit !== undefined
      });
    } catch (error) {
      logger.error('Failed to modify position', {
        positionId: params.positionId,
        stopLoss: effectiveStopLoss,
        takeProfit: effectiveTakeProfit,
        requestedStopLoss: params.stopLoss,
        requestedTakeProfit: params.takeProfit,
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
    await this.ensureConnected();
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
    await this.ensureConnected();
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

    const fallback = await this.getCurrentPriceFromLatestTrendbar(symbol);
    if (fallback) {
      logger.warn('cTrader getCurrentPrice: spot stream failed; using M1 close fallback', {
        symbol,
        attempts: maxRetries,
        reason: lastReason,
        exchange: 'ctrader'
      });
      return fallback;
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
   * Drop server-side spot subscription so the next SubscribeSpots gets a fresh snapshot event.
   * Safe to call when not subscribed (errors ignored).
   */
  private async tryUnsubscribeSpots(symbolId: number): Promise<void> {
    if (!this.connection || !this.config.accountId) return;
    const accountIdNum = parseInt(this.config.accountId, 10);
    if (isNaN(accountIdNum)) return;
    try {
      await this.connection.sendCommand('ProtoOAUnsubscribeSpotsReq', {
        ctidTraderAccountId: accountIdNum,
        symbolId: [symbolId]
      });
    } catch {
      // Not subscribed or broker-specific — ignore
    }
  }

  /** Last-resort mid price from recent M1 bars (bid=ask=close); spread is lost vs live spot. */
  private async getCurrentPriceFromLatestTrendbar(symbol: string): Promise<SpotPriceResult | null> {
    try {
      const now = Date.now();
      const bars = await this.getTrendbars({
        symbol,
        fromTimestamp: now - 20 * 60 * 1000,
        toTimestamp: now,
        period: 'M1'
      });
      if (bars.length === 0) return null;
      const close = bars[bars.length - 1]?.price;
      if (close == null || !Number.isFinite(close) || close <= 0) return null;
      return { bid: close, ask: close };
    } catch (error) {
      logger.debug('cTrader trendbar fallback failed', {
        symbol,
        exchange: 'ctrader',
        error: serializeErrorForLog(error)
      });
      return null;
    }
  }

  /**
   * Single attempt to fetch spot price. Returns {bid,ask} or failure info.
   *
   * Important: if we leave an active spot subscription on the server, the next SubscribeSpots returns
   * ALREADY_SUBSCRIBED and cTrader may not replay the last quote — only new ticks. Quiet symbols (e.g. XAUUSD)
   * can then time out. We unsubscribe before each subscribe so the first post-subscribe event always carries
   * the latest snapshot (per Open API docs).
   */
  private async fetchSpotPriceOnce(
    symbol: string,
    timeoutMs: number
  ): Promise<SpotPriceResult | { reason: string; error?: string }> {
    const isAlreadySubscribedError = (error: unknown): boolean => {
      const obj = error as { errorCode?: unknown; error_code?: unknown } | null;
      if (!obj || typeof obj !== 'object') return false;
      const code = obj.errorCode ?? obj.error_code;
      if (code === 113) return true;
      const s = code != null ? String(code) : '';
      return s === 'ALREADY_SUBSCRIBED' || s === '113';
    };

    try {
      const symbolInfo = await this.getSymbolInfo(symbol);
      const symbolId = protobufLongToNumber(symbolInfo.symbolId);
      if (symbolId == null || !Number.isFinite(symbolId)) {
        return { reason: 'symbol_lookup', error: 'Invalid symbolId' };
      }

      const connection = this.connection;
      if (!connection) return { reason: 'symbol_lookup', error: 'No connection' };

      const accountId = this.config.accountId;
      if (!accountId) return { reason: 'symbol_lookup', error: 'No account ID' };

      const accountIdNum = parseInt(accountId, 10);
      if (isNaN(accountIdNum)) {
        return { reason: 'symbol_lookup', error: 'Invalid account ID' };
      }

      let listenerId: string | undefined;

      const spotWait = new Promise<
        { bid: number; ask: number } | { reason: 'empty_spot_event'; error: string }
      >((resolve) => {
        let settled = false;
        const id = connection.on('ProtoOASpotEvent', (ctraderEvent: any) => {
          if (settled) return;

          const event = ctraderEvent.descriptor || ctraderEvent;
          const eventSymbolId = protobufLongToNumber(event.symbolId);
          if (eventSymbolId !== symbolId) return;

          const bid = event.bid ? event.bid / CTRADER_PRICE_SCALE : null;
          const ask = event.ask ? event.ask / CTRADER_PRICE_SCALE : null;

          if (bid && ask) {
            settled = true;
            if (typeof id === 'string') connection.removeEventListener(id);
            resolve({ bid, ask });
          } else if (bid) {
            settled = true;
            if (typeof id === 'string') connection.removeEventListener(id);
            resolve({ bid, ask: bid });
          } else if (ask) {
            settled = true;
            if (typeof id === 'string') connection.removeEventListener(id);
            resolve({ bid: ask, ask });
          } else {
            settled = true;
            if (typeof id === 'string') connection.removeEventListener(id);
            resolve({ reason: 'empty_spot_event', error: 'Spot event had no bid or ask' });
          }
        });
        listenerId = typeof id === 'string' ? id : undefined;
      });

      await this.tryUnsubscribeSpots(symbolId);

      try {
        await connection.sendCommand('ProtoOASubscribeSpotsReq', {
          ctidTraderAccountId: accountIdNum,
          symbolId: [symbolId]
        });
      } catch (error) {
        if (!isAlreadySubscribedError(error)) {
          if (listenerId) connection.removeEventListener(listenerId);
          return { reason: 'subscribe_failed', error: serializeErrorForLog(error) };
        }
        await this.tryUnsubscribeSpots(symbolId);
        try {
          await connection.sendCommand('ProtoOASubscribeSpotsReq', {
            ctidTraderAccountId: accountIdNum,
            symbolId: [symbolId]
          });
        } catch (e2) {
          if (listenerId) connection.removeEventListener(listenerId);
          return { reason: 'subscribe_failed', error: serializeErrorForLog(e2) };
        }
      }

      const timeoutRace = new Promise<{ reason: 'timeout'; error: string }>((resolve) => {
        setTimeout(
          () => resolve({ reason: 'timeout', error: `No spot event within ${timeoutMs}ms` }),
          timeoutMs
        );
      });

      const outcome = await Promise.race([spotWait, timeoutRace]);

      if ('reason' in outcome && outcome.reason === 'timeout' && listenerId) {
        connection.removeEventListener(listenerId);
      }

      void this.tryUnsubscribeSpots(symbolId);

      if ('bid' in outcome && outcome.bid != null && 'ask' in outcome && outcome.ask != null) {
        return outcome as SpotPriceResult;
      }
      return outcome as { reason: string; error?: string };
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
    this.stopHeartbeat();
    if (this.connection) {
      try {
        this.connection.onClose = undefined;
        this.connection.close();
      } catch (error) {
        logger.warn('Error closing cTrader connection', {
          error: serializeErrorForLog(error)
        });
      }
      this.connection = null;
      this.connected = false;
      this.authenticated = false;
      this.symbolInfoCache.clear();
    }
  }

  /**
   * Check if client is connected (checks actual socket, not just cached flag)
   */
  isConnected(): boolean {
    return this.connected && (this.connection?.isConnected() ?? false);
  }
}
