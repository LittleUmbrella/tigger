import { logger } from '../utils/logger.js';
import { CTraderConnection } from '../lib/ctrader/CTraderConnection.js';

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
}

/**
 * cTrader OpenAPI client using local implementation
 * 
 * Uses our local CTraderConnection implementation which handles
 * the low-level protocol communication (Protobuf over TCP/WebSocket).
 */
export class CTraderClient {
  private config: CTraderClientConfig;
  private connection: CTraderConnection | null = null;
  private connected: boolean = false;
  private authenticated: boolean = false;

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
        error: error instanceof Error ? error.message : String(error)
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
        error: error instanceof Error ? error.message : String(error),
        errorString: String(error),
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
        error: error instanceof Error ? error.message : String(error),
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
        error: error instanceof Error ? error.message : String(error),
        errorString: String(error),
        errorJson: error && typeof error === 'object' ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : undefined
      });
      throw error;
    }
  }

  /**
   * Get symbol information including full volume fields (lotSize, stepVolume, minVolume, maxVolume)
   * Uses ProtoOASymbolsListReq to resolve symbol name -> symbolId, then ProtoOASymbolByIdReq
   * for the full ProtoOASymbol (LightSymbol lacks volume fields).
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
      const lightSymbol = symbols.find((s: any) => s.symbolName === symbol);

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
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Place a market order
   */
  async placeMarketOrder(params: {
    symbol: string;
    volume: number;
    tradeSide: 'BUY' | 'SELL';
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
      const response = await this.connection.sendCommand('ProtoOANewOrderReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        symbolId,
        orderType: 'MARKET',
        tradeSide: params.tradeSide === 'BUY' ? 'BUY' : 'SELL',
        volume: volumeInApiUnits
      });

      const orderId = response?.orderId || response?.order?.orderId;
      if (!orderId) {
        throw new Error('No order ID returned from cTrader');
      }

      logger.info('Market order placed on cTrader', {
        orderId,
        symbol: params.symbol,
        tradeSide: params.tradeSide,
        volume: params.volume
      });

      return orderId.toString();
    } catch (error) {
      logger.error('Failed to place market order', {
        symbol: params.symbol,
        tradeSide: params.tradeSide,
        volume: params.volume,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Place a limit order
   */
  async placeLimitOrder(params: {
    symbol: string;
    volume: number;
    tradeSide: 'BUY' | 'SELL';
    price: number;
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
      const response = await this.connection.sendCommand('ProtoOANewOrderReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        symbolId,
        orderType: 'LIMIT',
        tradeSide: params.tradeSide === 'BUY' ? 'BUY' : 'SELL',
        volume: volumeInApiUnits,
        limitPrice: params.price,
        timeInForce: 'GOOD_TILL_CANCEL' // Keep order on book until filled or manually cancelled (default may vary by broker)
      });

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
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
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
        const side = typeof tradeSide === 'number' ? ['BUY', 'SELL'][tradeSide] ?? tradeSide : tradeSide;
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
        error: error instanceof Error ? error.message : String(error)
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
        error: error instanceof Error ? error.message : String(error)
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
        error: error instanceof Error ? error.message : String(error)
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
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Close position
   */
  async closePosition(positionId: string): Promise<void> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      await this.connection.sendCommand('ProtoOAClosePositionReq', {
        ctidTraderAccountId: parseInt(this.config.accountId!, 10),
        positionId: parseInt(positionId, 10)
      });

      logger.info('Position closed on cTrader', {
        positionId,
        accountId: this.config.accountId,
        exchange: 'ctrader'
      });
    } catch (error) {
      logger.error('Failed to close position', {
        positionId,
        accountId: this.config.accountId,
        exchange: 'ctrader',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get current price for a symbol
   * Subscribes to spot events and waits for the first spot event which contains current prices
   */
  async getCurrentPrice(symbol: string): Promise<number | null> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    if (!this.config.accountId) {
      throw new Error('Account ID is required to get current price');
    }

    try {
      const symbolInfo = await this.getSymbolInfo(symbol);
      const symbolId = typeof symbolInfo.symbolId === 'object' && symbolInfo.symbolId.low !== undefined
        ? symbolInfo.symbolId.low
        : symbolInfo.symbolId;

      // Set up listener BEFORE subscribing (spot events can arrive immediately after subscription)
      const connection = this.connection;
      if (!connection) {
        return null;
      }

      const accountId = this.config.accountId;
      if (!accountId) {
        return null;
      }

      return new Promise<number | null>((resolve) => {
        let listenerId: string | undefined;
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved && listenerId) {
            connection.removeEventListener(listenerId);
          }
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }, 5000); // 5 second timeout

        // Listen for spot events using the connection's on method
        // Pass the payload name, not the type number
        // The event is wrapped in a CTraderEvent with descriptor containing the actual data
        const idResult = connection.on('ProtoOASpotEvent', (ctraderEvent: any) => {
          if (resolved) return;
          
          // Extract the actual event data from the descriptor
          const event = ctraderEvent.descriptor || ctraderEvent;
          const eventSymbolId = typeof event.symbolId === 'object' && event.symbolId.low !== undefined
            ? event.symbolId.low
            : event.symbolId;
          
          if (eventSymbolId === symbolId) {
            resolved = true;
            clearTimeout(timeout);
            
            // Remove the listener
            if (typeof id === 'string') {
              connection.removeEventListener(id);
            }
            
            // Prices are in 1/100_000 of unit (e.g., 1.23 -> 123000)
            const bid = event.bid ? event.bid / 100000 : null;
            const ask = event.ask ? event.ask / 100000 : null;
            
            if (bid && ask) {
              resolve((bid + ask) / 2); // Return mid price
            } else if (bid) {
              resolve(bid);
            } else if (ask) {
              resolve(ask);
            } else {
              resolve(null);
            }
          }
        });

        // Store listenerId for cleanup on timeout
        const id = idResult;
        if (typeof id === 'string') {
          listenerId = id;
        }

        // Now subscribe to spot events (listener is already set up)
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
            resolve(null);
          }
        });
      });
    } catch (error) {
      logger.debug('Failed to get current price', {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
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
          error: error instanceof Error ? error.message : String(error)
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
