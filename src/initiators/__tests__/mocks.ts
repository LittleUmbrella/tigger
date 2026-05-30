import { vi } from 'vitest';
import { DatabaseManager } from '../../db/schema.js';
import { HistoricalPriceProvider } from '../../utils/historicalPriceProvider.js';

/**
 * Mock database manager for testing
 */
export function createMockDatabase(): DatabaseManager {
  const messages: any[] = [];
  const trades: any[] = [];
  const orders: any[] = [];
  const locks = new Set<string>();
  let messageIdCounter = 1;
  let tradeIdCounter = 1;
  let orderIdCounter = 1;

  return {
    insertMessage: vi.fn((msg: any) => {
      const id = messageIdCounter++;
      messages.push({ ...msg, id, created_at: new Date().toISOString(), parsed: false });
      return id;
    }),
    getUnparsedMessages: vi.fn((channel?: string) => {
      const unparsed = messages.filter(m => !m.parsed);
      return channel ? unparsed.filter(m => m.channel === channel) : unparsed;
    }),
    getMessagesByChannel: vi.fn((channel: string) => {
      return messages.filter(m => m.channel === channel);
    }),
    markMessageParsed: vi.fn((id: number) => {
      const msg = messages.find(m => m.id === id);
      if (msg) msg.parsed = true;
    }),
    insertTrade: vi.fn((trade: any) => {
      const id = tradeIdCounter++;
      trades.push({
        ...trade,
        id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return id;
    }),
    getActiveTrades: vi.fn(() => {
      return trades.filter(t => ['pending', 'active', 'filled'].includes(t.status));
    }),
    getClosedTrades: vi.fn(() => {
      return trades.filter(t => ['closed', 'stopped', 'cancelled', 'completed'].includes(t.status));
    }),
    getTradesByStatus: vi.fn((status: string) => {
      return trades.filter(t => t.status === status);
    }),
    getTradesByMessageId: vi.fn((messageId: string, channel: string) => {
      return trades.filter(t => t.message_id === messageId && t.channel === channel);
    }),
    getMessagesPendingForInitiator: vi.fn(
      async (channel: string, scope: string, exchange: string) => {
        const pending = messages.filter(
          (m) =>
            m.channel === channel &&
            !m.parsed &&
            !locks.has(`${m.message_id}:${channel}:${scope}`) &&
            !trades.some(
              (t) =>
                t.message_id === m.message_id && t.channel === channel && t.exchange === exchange,
            ),
        );
        return pending;
      },
    ),
    hasTradeInitiationLock: vi.fn(async (messageId: string, channel: string, scope: string) =>
      locks.has(`${messageId}:${channel}:${scope}`),
    ),
    acquireTradeInitiationLock: vi.fn(async (messageId: string, channel: string, scope: string) => {
      const key = `${messageId}:${channel}:${scope}`;
      if (locks.has(key)) return false;
      locks.add(key);
      return true;
    }),
    releaseTradeInitiationLock: vi.fn(async (messageId: string, channel: string, scope: string) => {
      locks.delete(`${messageId}:${channel}:${scope}`);
    }),
    insertOrder: vi.fn((order: any) => {
      const id = orderIdCounter++;
      orders.push({
        ...order,
        id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return id;
    }),
    getOrdersByTradeId: vi.fn((tradeId: number) => {
      return orders.filter(o => o.trade_id === tradeId);
    }),
    getOrdersByStatus: vi.fn((status: string) => {
      return orders.filter(o => o.status === status);
    }),
    updateOrder: vi.fn((id: number, updates: any) => {
      const order = orders.find(o => o.id === id);
      if (order) {
        Object.assign(order, updates);
        order.updated_at = new Date().toISOString();
      }
    }),
    updateTrade: vi.fn((id: number, updates: any) => {
      const trade = trades.find(t => t.id === id);
      if (trade) {
        Object.assign(trade, updates);
        trade.updated_at = new Date().toISOString();
      }
    }),
    close: vi.fn(),
  } as any as DatabaseManager;
}

/**
 * Mock historical price provider
 */
export function createMockPriceProvider(priceData: Record<string, Record<string, number>>) {
  let currentTime = new Date('2024-01-15T10:00:00Z');
  
  return {
    getCurrentPrice: vi.fn((tradingPair: string): number | null => {
      const pairData = priceData[tradingPair];
      if (!pairData) return null;
      
      // Find the closest time <= currentTime
      const times = Object.keys(pairData).sort();
      const closestTime = times
        .filter(time => new Date(time) <= currentTime)
        .pop();
      
      return closestTime ? pairData[closestTime] : null;
    }),
    getCurrentTime: vi.fn(() => {
      const dayjs = require('dayjs');
      return dayjs(currentTime);
    }),
    setCurrentTime: vi.fn((time: any) => {
      // Accept both Date and dayjs.Dayjs
      currentTime = time instanceof Date ? time : time.toDate();
    }),
    advanceTime: vi.fn((ms: number) => {
      currentTime = new Date(currentTime.getTime() + ms);
    }),
    prefetchPriceData: vi.fn().mockResolvedValue(undefined),
  } as any as HistoricalPriceProvider;
}

/**
 * Mock Bybit RestClientV5
 */
export function createMockBybitClient(mockResponses: Record<string, any>) {
  return {
    getWalletBalance: vi.fn().mockResolvedValue(mockResponses.walletBalance),
    submitOrder: vi.fn().mockResolvedValue(mockResponses.submitOrder),
    setLeverage: vi.fn().mockResolvedValue(mockResponses.setLeverage),
    getTickers: vi.fn().mockResolvedValue(mockResponses.getTickers),
    getOpenOrders: vi.fn().mockResolvedValue(mockResponses.getOpenOrders),
    getOrderHistory: vi.fn().mockResolvedValue(mockResponses.getOrderHistory),
    getPositionInfo: vi.fn().mockResolvedValue(mockResponses.getPositionInfo),
    cancelOrder: vi.fn().mockResolvedValue({ retCode: 0 }),
    setTradingStop: vi.fn().mockResolvedValue({ retCode: 0 }),
    getClosedPnL: vi.fn().mockResolvedValue({
      retCode: 0,
      result: { list: [] },
    }),
    getExecutionList: vi.fn().mockResolvedValue({
      retCode: 0,
      result: { list: [] },
    }),
  };
}

