import { describe, expect, it, beforeEach } from 'vitest';
import { TickTpRegistry } from '../tickTpRegistry.js';
import type { TickTpWatch } from '../types.js';

const baseWatch = (overrides: Partial<TickTpWatch> = {}): TickTpWatch => ({
  tradeId: 1,
  positionId: '100',
  channel: 'ch',
  messageId: 'msg1',
  accountName: 'ctrader_live_5',
  symbol: 'XAUUSD',
  symbolId: 42,
  direction: 'long',
  remainingVolumeLots: 0.03,
  closingInFlight: false,
  levels: [
    { index: 1, price: 2650, volumeLots: 0.01, status: 'pending' },
    { index: 2, price: 2660, volumeLots: 0.01, status: 'pending' },
  ],
  ...overrides,
});

describe('TickTpRegistry', () => {
  let registry: TickTpRegistry;

  beforeEach(() => {
    registry = new TickTpRegistry();
  });

  it('registers and retrieves by tradeId and symbolId', () => {
    const w = baseWatch();
    registry.register(w);
    expect(registry.getByTradeId(1)).toBe(w);
    expect(registry.getBySymbolId(42)).toEqual([w]);
  });

  it('getFilledTpCount counts filled levels only', () => {
    const w = baseWatch({
      levels: [
        { index: 1, price: 2650, volumeLots: 0.01, status: 'filled' },
        { index: 2, price: 2660, volumeLots: 0.01, status: 'pending' },
      ],
    });
    registry.register(w);
    expect(registry.getFilledTpCount(1)).toBe(1);
  });

  it('unregister removes from both indexes', () => {
    registry.register(baseWatch());
    registry.unregister(1);
    expect(registry.getByTradeId(1)).toBeUndefined();
    expect(registry.getBySymbolId(42)).toEqual([]);
  });

  it('symbolId index holds multiple watches', () => {
    registry.register(baseWatch({ tradeId: 1 }));
    registry.register(baseWatch({ tradeId: 2, positionId: '101' }));
    expect(registry.getBySymbolId(42)).toHaveLength(2);
  });
});
