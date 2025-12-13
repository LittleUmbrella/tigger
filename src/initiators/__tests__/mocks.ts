import { vi } from 'vitest';
import { DatabaseManager } from '../../db/schema.js';
import { HistoricalPriceProvider } from '../../utils/historicalPriceProvider.js';

/**
 * Mock database manager for testing
 */
export function createMockDatabase(): DatabaseManager {
  const messages: any[] = [];
  const trades: any[] = [];
  let messageIdCounter = 1;
  let tradeIdCounter = 1;

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

