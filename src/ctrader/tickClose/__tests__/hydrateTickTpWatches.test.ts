import { describe, expect, it } from 'vitest';
import type { Order, Trade } from '../../../db/schema.js';
import {
  buildIntermediateTpLevels,
  buildWatchFromTrade,
  filledTpIndicesFromOrders,
} from '../hydrateTickTpWatches.js';

const baseTrade = (overrides: Partial<Trade> = {}): Trade => ({
  id: 101,
  message_id: 'msg-101',
  channel: 'alerts',
  trading_pair: 'XAU/USD',
  leverage: 10,
  entry_price: 2500,
  stop_loss: 2480,
  take_profits: JSON.stringify([2510, 2520, 2530]),
  risk_percentage: 1,
  exchange: 'ctrader',
  account_name: 'ctrader_live_5',
  status: 'filled',
  stop_loss_breakeven: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-02T00:00:00Z',
  direction: 'long',
  position_id: '9001',
  ...overrides,
});

const baseOrder = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  trade_id: 101,
  order_type: 'take_profit',
  price: 2510,
  status: 'filled',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('buildIntermediateTpLevels', () => {
  it('builds two intermediate levels for three TP prices', () => {
    const levels = buildIntermediateTpLevels(
      [2510, 2520, 2530],
      0.03,
      0.01,
      0.01,
      undefined,
      2,
      new Set<number>()
    );

    expect(levels).toHaveLength(2);
    expect(levels.map((level) => level.index)).toEqual([1, 2]);
    expect(levels.map((level) => level.price)).toEqual([2510, 2520]);
  });
});

describe('buildWatchFromTrade', () => {
  it('marks a filled intermediate level and reduces remaining volume', () => {
    const watch = buildWatchFromTrade({
      trade: baseTrade(),
      symbolId: 42,
      totalVolumeLots: 0.03,
      filledTpIndices: new Set([1]),
      volumeStep: 0.01,
      minVolume: 0.01,
      maxVolume: undefined,
      decimalPrecision: 2,
    });

    expect(watch).not.toBeNull();
    expect(watch?.levels).toHaveLength(2);
    expect(watch?.levels[0].index).toBe(1);
    expect(watch?.levels[0].status).toBe('filled');
    expect(watch?.levels[1].status).toBe('pending');
    expect(watch?.remainingVolumeLots).toBeCloseTo(0.02, 8);
  });

  it('returns null for single TP positions', () => {
    const watch = buildWatchFromTrade({
      trade: baseTrade({ take_profits: JSON.stringify([2510]) }),
      symbolId: 42,
      totalVolumeLots: 0.03,
      filledTpIndices: new Set<number>(),
      volumeStep: 0.01,
      minVolume: 0.01,
      maxVolume: undefined,
      decimalPrecision: 2,
    });

    expect(watch).toBeNull();
  });
});

describe('filledTpIndicesFromOrders', () => {
  it('collects filled take_profit tp_index values', () => {
    const filled = filledTpIndicesFromOrders([
      baseOrder({ id: 1, tp_index: 1, status: 'filled', order_type: 'take_profit' }),
      baseOrder({ id: 2, tp_index: 2, status: 'pending', order_type: 'take_profit' }),
      baseOrder({ id: 3, tp_index: 3, status: 'filled', order_type: 'entry' }),
      baseOrder({ id: 4, tp_index: undefined, status: 'filled', order_type: 'take_profit' }),
    ]);

    expect([...filled]).toEqual([1]);
  });
});
