import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CTraderClient } from '../../../clients/ctraderClient.js';
import type { DatabaseManager } from '../../../db/schema.js';
import type { AccountConfig } from '../../../types/config.js';
import { getTickTpService, registerTickCloseWatch, startTickTpServices } from '../tickTpServiceManager.js';
import type { TickTpWatch } from '../types.js';

const baseWatch = (overrides: Partial<TickTpWatch> = {}): TickTpWatch => ({
  tradeId: 77,
  positionId: '99001',
  channel: 'alerts',
  messageId: 'msg-77',
  accountName: 'ctrader_live_tick_close',
  symbol: 'XAUUSD',
  symbolId: 42,
  direction: 'long',
  remainingVolumeLots: 0.02,
  closingInFlight: false,
  levels: [{ index: 1, price: 2450, volumeLots: 0.01, status: 'pending' }],
  ...overrides,
});

describe('tickTpServiceManager', () => {
  afterEach(async () => {
    const stop = await startTickTpServices({
      accounts: [],
      db: {
        getActiveTrades: vi.fn().mockResolvedValue([]),
      } as unknown as DatabaseManager,
      getCTraderClient: vi.fn(async () => undefined),
      isSimulation: false,
    });
    await stop();
  });

  it('registerTickCloseWatch stores watch in account service registry', async () => {
    const onSpotQuote = vi.fn(() => vi.fn());
    const addPersistentSpotSubscription = vi.fn(async () => undefined);
    const removePersistentSpotSubscription = vi.fn(async () => undefined);

    const client = {
      onSpotQuote,
      addPersistentSpotSubscription,
      removePersistentSpotSubscription,
    } as unknown as CTraderClient;

    const db = {
      getActiveTrades: vi.fn().mockResolvedValue([]),
    } as unknown as DatabaseManager;

    const accounts: AccountConfig[] = [
      {
        name: 'ctrader_live_tick_close',
        exchange: 'ctrader',
        ctraderTpStrategy: 'tick-close',
      },
    ];

    const stop = await startTickTpServices({
      accounts,
      db,
      getCTraderClient: vi.fn(async () => client),
      isSimulation: false,
    });

    const watch = baseWatch();
    registerTickCloseWatch('ctrader_live_tick_close', watch);

    const service = getTickTpService('ctrader_live_tick_close');
    expect(service?.registry.getByTradeId(watch.tradeId)).toBe(watch);
    expect(addPersistentSpotSubscription).toHaveBeenCalledWith(watch.symbolId);

    await stop();
    expect(removePersistentSpotSubscription).toHaveBeenCalledWith(watch.symbolId);
  });
});
