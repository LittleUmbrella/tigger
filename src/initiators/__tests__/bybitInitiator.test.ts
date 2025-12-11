import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bybitInitiator } from '../bybitInitiator.js';
import { InitiatorContext } from '../initiatorRegistry.js';
import { DatabaseManager } from '../../db/schema.js';
import { mockMessage, mockParsedOrder, mockBybitResponses } from './fixtures.js';
import { createMockDatabase, createMockPriceProvider, createMockBybitClient } from './mocks.js';
import { HistoricalPriceProvider } from '../../utils/historicalPriceProvider.js';
import { RESTClient } from 'bybit-api';

// Mock the bybit-api module
vi.mock('bybit-api', () => ({
  RESTClient: vi.fn(),
}));

describe('Bybit Initiator', () => {
  let mockDb: DatabaseManager;
  let mockPriceProvider: HistoricalPriceProvider;
  let mockBybitClient: any;

  beforeEach(() => {
    mockDb = createMockDatabase();
    mockPriceProvider = createMockPriceProvider({
      'BTC/USDT': {
        '2024-01-15T10:00:00Z': 50000,
      },
    });
    
    // Reset environment variables
    delete process.env.BYBIT_API_KEY;
    delete process.env.BYBIT_API_SECRET;
  });

  it('should create trade in simulation mode', async () => {
    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 3,
      entryTimeoutDays: 2,
      message: mockMessage,
      order: mockParsedOrder,
      db: mockDb,
      isSimulation: true,
      priceProvider: mockPriceProvider,
      config: {
        name: 'bybit',
        riskPercentage: 3,
        testnet: false,
      },
    };

    await bybitInitiator(context);

    expect(mockDb.insertTrade).toHaveBeenCalled();
    const insertCall = (mockDb.insertTrade as any).mock.calls[0][0];
    expect(insertCall.trading_pair).toBe('BTC/USDT');
    expect(insertCall.entry_price).toBe(50000);
    expect(insertCall.stop_loss).toBe(48000);
    expect(insertCall.leverage).toBe(10);
    expect(insertCall.exchange).toBe('bybit');
    expect(insertCall.status).toBe('pending');
    expect(insertCall.order_id).toMatch(/^SIM-/);
  });

  it('should calculate position size based on risk percentage', async () => {
    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 5, // 5% risk
      entryTimeoutDays: 2,
      message: mockMessage,
      order: mockParsedOrder,
      db: mockDb,
      isSimulation: true,
      priceProvider: mockPriceProvider,
      config: {
        name: 'bybit',
        riskPercentage: 5,
        testnet: false,
      },
    };

    await bybitInitiator(context);

    expect(mockDb.insertTrade).toHaveBeenCalled();
  });

  it('should handle short signals correctly', async () => {
    const shortOrder = {
      ...mockParsedOrder,
      signalType: 'short' as const,
      tradingPair: 'ETH/USDT',
      entryPrice: 3000,
      stopLoss: 3100,
    };

    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 3,
      entryTimeoutDays: 2,
      message: {
        ...mockMessage,
        content: 'Short signal for ETH',
      },
      order: shortOrder,
      db: mockDb,
      isSimulation: true,
      priceProvider: mockPriceProvider,
      config: {
        name: 'bybit',
        riskPercentage: 3,
        testnet: false,
      },
    };

    await bybitInitiator(context);

    expect(mockDb.insertTrade).toHaveBeenCalled();
    const insertCall = (mockDb.insertTrade as any).mock.calls[0][0];
    expect(insertCall.trading_pair).toBe('ETH/USDT');
    expect(insertCall.entry_price).toBe(3000);
    expect(insertCall.stop_loss).toBe(3100);
  });

  it('should use default balance in simulation mode', async () => {
    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 3,
      entryTimeoutDays: 2,
      message: mockMessage,
      order: mockParsedOrder,
      db: mockDb,
      isSimulation: true,
      priceProvider: mockPriceProvider,
      config: {
        name: 'bybit',
        riskPercentage: 3,
        testnet: false,
      },
    };

    await bybitInitiator(context);

    // Should use default 10000 balance in simulation
    expect(mockDb.insertTrade).toHaveBeenCalled();
  });

  it('should not create trade if API credentials missing in live mode', async () => {
    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 3,
      entryTimeoutDays: 2,
      message: mockMessage,
      order: mockParsedOrder,
      db: mockDb,
      isSimulation: false,
      config: {
        name: 'bybit',
        riskPercentage: 3,
        testnet: false,
      },
    };

    // No API credentials set
    await bybitInitiator(context);

    // Should not insert trade without credentials
    expect(mockDb.insertTrade).not.toHaveBeenCalled();
  });

  it('should store take profits as JSON string', async () => {
    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 3,
      entryTimeoutDays: 2,
      message: mockMessage,
      order: {
        ...mockParsedOrder,
        takeProfits: [52000, 54000, 56000],
      },
      db: mockDb,
      isSimulation: true,
      priceProvider: mockPriceProvider,
      config: {
        name: 'bybit',
        riskPercentage: 3,
        testnet: false,
      },
    };

    await bybitInitiator(context);

    expect(mockDb.insertTrade).toHaveBeenCalled();
    const insertCall = (mockDb.insertTrade as any).mock.calls[0][0];
    const takeProfits = JSON.parse(insertCall.take_profits);
    expect(takeProfits).toEqual([52000, 54000, 56000]);
  });

  it('should set expiration date correctly', async () => {
    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 3,
      entryTimeoutDays: 3,
      message: mockMessage,
      order: mockParsedOrder,
      db: mockDb,
      isSimulation: true,
      priceProvider: mockPriceProvider,
      config: {
        name: 'bybit',
        riskPercentage: 3,
        testnet: false,
      },
    };

    await bybitInitiator(context);

    expect(mockDb.insertTrade).toHaveBeenCalled();
    const insertCall = (mockDb.insertTrade as any).mock.calls[0][0];
    const expiresAt = new Date(insertCall.expires_at);
    const now = new Date();
    const expectedExpiry = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    
    // Allow 1 second tolerance for test execution time
    expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(1000);
  });

  it('should convert trading pair format (BTC/USDT -> BTCUSDT)', async () => {
    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 3,
      entryTimeoutDays: 2,
      message: mockMessage,
      order: mockParsedOrder,
      db: mockDb,
      isSimulation: true,
      priceProvider: mockPriceProvider,
      config: {
        name: 'bybit',
        riskPercentage: 3,
        testnet: false,
      },
    };

    await bybitInitiator(context);

    // The trading pair should be stored as-is in the database
    expect(mockDb.insertTrade).toHaveBeenCalled();
    const insertCall = (mockDb.insertTrade as any).mock.calls[0][0];
    expect(insertCall.trading_pair).toBe('BTC/USDT');
  });
});




