import { logger } from '../utils/logger.js';
import { CTraderConnection } from '@reiryoku/ctrader-layer';

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
 * cTrader OpenAPI client using @reiryoku/ctrader-layer
 * 
 * This uses the community-maintained cTrader Layer package which handles
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
        await this.connection.sendCommand('ProtoOAAccountAuthReq', {
          accessToken: this.config.accessToken,
          accountId: parseInt(this.config.accountId, 10)
        });

        this.authenticated = true;
        logger.info('Trading account authenticated', {
          accountId: this.config.accountId
        });
      }
    } catch (error) {
      logger.error('Failed to authenticate with cTrader OpenAPI', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get account information
   */
  async getAccountInfo(): Promise<any> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const response = await this.connection.sendCommand('ProtoOAGetAccountListReq', {});
      // The response should contain account information
      return response;
    } catch (error) {
      logger.error('Failed to get account info', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get symbol information
   */
  async getSymbolInfo(symbol: string): Promise<any> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      // First get the symbol ID from symbol name
      const symbolListResponse = await this.connection.sendCommand('ProtoOASymbolsListReq', {
        accountId: parseInt(this.config.accountId!, 10)
      });

      // Find the symbol in the list
      const symbols = symbolListResponse?.symbol || [];
      const symbolInfo = symbols.find((s: any) => s.symbolName === symbol);
      
      if (!symbolInfo) {
        throw new Error(`Symbol ${symbol} not found`);
      }

      return symbolInfo;
    } catch (error) {
      logger.error('Failed to get symbol info', {
        symbol,
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
      
      const response = await this.connection.sendCommand('ProtoOANewOrderReq', {
        accountId: parseInt(this.config.accountId!, 10),
        symbolId: symbolInfo.symbolId,
        orderType: 'MARKET',
        tradeSide: params.tradeSide === 'BUY' ? 'BUY' : 'SELL',
        volume: params.volume
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
        params,
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
      
      const response = await this.connection.sendCommand('ProtoOANewOrderReq', {
        accountId: parseInt(this.config.accountId!, 10),
        symbolId: symbolInfo.symbolId,
        orderType: 'LIMIT',
        tradeSide: params.tradeSide === 'BUY' ? 'BUY' : 'SELL',
        volume: params.volume,
        limitPrice: params.price
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
        price: params.price
      });

      return orderId.toString();
    } catch (error) {
      logger.error('Failed to place limit order', {
        params,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get open positions
   */
  async getOpenPositions(): Promise<any[]> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const response = await this.connection.sendCommand('ProtoOAGetPositionsReq', {
        accountId: parseInt(this.config.accountId!, 10)
      });

      return response?.position || [];
    } catch (error) {
      logger.error('Failed to get open positions', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<any[]> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const response = await this.connection.sendCommand('ProtoOAGetOrdersReq', {
        accountId: parseInt(this.config.accountId!, 10)
      });

      return response?.order || [];
    } catch (error) {
      logger.error('Failed to get open orders', {
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
        accountId: parseInt(this.config.accountId!, 10),
        orderId: parseInt(orderId, 10)
      });

      logger.info('Order cancelled on cTrader', { orderId });
    } catch (error) {
      logger.error('Failed to cancel order', {
        orderId,
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
      await this.connection.sendCommand('ProtoOAUpdateStopLossTakeProfitReq', {
        accountId: parseInt(this.config.accountId!, 10),
        positionId: parseInt(params.positionId, 10),
        ...(params.stopLoss !== undefined && { stopLoss: params.stopLoss }),
        ...(params.takeProfit !== undefined && { takeProfit: params.takeProfit })
      });

      logger.info('Position modified on cTrader', params);
    } catch (error) {
      logger.error('Failed to modify position', {
        params,
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
        accountId: parseInt(this.config.accountId!, 10),
        positionId: parseInt(positionId, 10)
      });

      logger.info('Position closed on cTrader', { positionId });
    } catch (error) {
      logger.error('Failed to close position', {
        positionId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get current price for a symbol
   */
  async getCurrentPrice(symbol: string): Promise<number | null> {
    if (!this.authenticated || !this.connection) {
      throw new Error('Not authenticated with cTrader OpenAPI');
    }

    try {
      const symbolInfo = await this.getSymbolInfo(symbol);
      
      // Request tick data for the symbol
      const response = await this.connection.sendCommand('ProtoOASymbolsForConversionReq', {
        accountId: parseInt(this.config.accountId!, 10),
        firstSymbolId: symbolInfo.symbolId,
        secondSymbolId: symbolInfo.symbolId
      });

      // Try to get price from symbol tick data
      // The actual response structure depends on cTrader API
      const tickData = await this.connection.sendCommand('ProtoOASubscribeSpotsReq', {
        accountId: parseInt(this.config.accountId!, 10),
        symbolId: [symbolInfo.symbolId]
      });

      // Extract bid/ask prices from tick data
      // This is a simplified version - actual implementation may vary
      const bid = tickData?.bid || symbolInfo?.bid || null;
      const ask = tickData?.ask || symbolInfo?.ask || null;
      
      if (bid && ask) {
        return (bid + ask) / 2; // Return mid price
      } else if (bid) {
        return bid;
      } else if (ask) {
        return ask;
      }

      return null;
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
