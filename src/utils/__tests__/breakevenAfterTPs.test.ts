import { describe, expect, it } from 'vitest';
import {
  computeDynamicBreakevenAfterTPs,
  getTakeProfitLevelCount,
  resolveBreakevenAfterTPs,
} from '../breakevenAfterTPs.js';
import type { Trade } from '../../db/schema.js';

const baseTrade = (take_profits: string): Trade => ({
  id: 1,
  message_id: '1',
  channel: 'ch',
  trading_pair: 'XAUUSD',
  leverage: 20,
  entry_price: 100,
  stop_loss: 90,
  take_profits,
  risk_percentage: 1,
  exchange: 'ctrader',
  status: 'active',
  stop_loss_breakeven: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  expires_at: '2026-12-31T00:00:00.000Z',
});

describe('computeDynamicBreakevenAfterTPs', () => {
  it('returns 1 for fewer than 5 TPs', () => {
    expect(computeDynamicBreakevenAfterTPs(1)).toBe(1);
    expect(computeDynamicBreakevenAfterTPs(4)).toBe(1);
  });

  it('returns 2 at 5–9 TPs and scales by blocks of 5', () => {
    expect(computeDynamicBreakevenAfterTPs(5)).toBe(2);
    expect(computeDynamicBreakevenAfterTPs(9)).toBe(2);
    expect(computeDynamicBreakevenAfterTPs(10)).toBe(3);
    expect(computeDynamicBreakevenAfterTPs(15)).toBe(4);
  });
});

describe('resolveBreakevenAfterTPs', () => {
  it('uses dynamic rule when enabled', () => {
    expect(resolveBreakevenAfterTPs(10, { dynamicBreakevenAfterTPs: true })).toBe(3);
  });

  it('falls back to breakevenAfterTPs or 1', () => {
    expect(resolveBreakevenAfterTPs(10, { breakevenAfterTPs: 2 })).toBe(2);
    expect(resolveBreakevenAfterTPs(10, {})).toBe(1);
  });
});

describe('getTakeProfitLevelCount', () => {
  it('counts JSON array length', () => {
    expect(getTakeProfitLevelCount(baseTrade('[1,2,3]'))).toBe(3);
  });

  it('returns 0 for invalid JSON', () => {
    expect(getTakeProfitLevelCount(baseTrade('not-json'))).toBe(0);
  });
});
