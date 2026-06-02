import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ctraderInitiator } from '../ctraderInitiator.js';
import { createMockDatabase, createMockPriceProvider } from './mocks.js';
import { mockMessage } from './fixtures.js';
import type { InitiatorContext } from '../initiatorRegistry.js';
import { getCachedCTraderSymbolInfo } from '../../utils/ctraderSymbolInfoCache.js';

vi.mock('../../utils/ctraderSymbolInfoCache.js', () => ({
  getCachedCTraderSymbolInfo: vi.fn(),
}));

describe('ctraderInitiator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches cTrader symbol info for XAUUSD sizing even when validation is skipped', async () => {
    const db = createMockDatabase();
    const priceProvider = createMockPriceProvider({
      XAUUSD: {
        '2024-01-15T10:00:00Z': 4520,
      },
    });
    const pooledClient = {};

    vi.mocked(getCachedCTraderSymbolInfo).mockResolvedValue({
      symbolId: 1,
      symbolName: 'XAUUSD',
      digits: 2,
      pipSize: 0.01,
      volumePrecision: 2,
      minVolume: 100,
      maxVolume: 1000000,
      stepVolume: 100,
      lotSize: 10000,
    } as any);

    const context: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 1,
      entryTimeoutMinutes: 60,
      message: mockMessage,
      order: {
        tradingPair: 'XAUUSD',
        leverage: 10,
        entryPrice: 4520,
        stopLoss: 4532,
        takeProfits: [4512],
        signalType: 'short',
      },
      db,
      isSimulation: true,
      priceProvider,
      config: {
        name: 'ctrader',
        riskPercentage: 1,
      },
      getCTraderClient: vi.fn().mockResolvedValue(pooledClient as any),
    };

    await ctraderInitiator(context);

    expect(getCachedCTraderSymbolInfo).toHaveBeenCalledWith(
      pooledClient,
      'default',
      'XAUUSD',
    );
    expect(db.insertTrade).toHaveBeenCalled();
  });
});
