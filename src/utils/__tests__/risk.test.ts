import { describe, expect, it } from 'vitest';
import type { Trade } from '../../db/schema.js';
import {
  buildDailyPnLMap,
  calculatePotentialLoss,
  getChannelMaxPortfolioRiskViolation,
  getUtcTodayString,
  projectRunningBalanceAndPeak,
  projectTodayRealizedPnLAndPeak,
} from '../risk.js';

const trade = (partial: Partial<Trade> & Pick<Trade, 'pnl' | 'exit_filled_at' | 'status'>): Trade => ({
  id: 1,
  message_id: '1',
  channel: 'ch',
  trading_pair: 'BTC/USDT',
  leverage: 10,
  entry_price: 100,
  stop_loss: 95,
  take_profits: '[]',
  risk_percentage: 1,
  exchange: 'bybit',
  stop_loss_breakeven: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  expires_at: '2026-12-31T00:00:00.000Z',
  ...partial,
});

describe('calculatePotentialLoss', () => {
  it('computes |entry - SL| × quantity', () => {
    expect(calculatePotentialLoss(100, 95, 2)).toBe(10);
  });

  it('returns Infinity when SL missing', () => {
    expect(calculatePotentialLoss(100, 0, 1)).toBe(Infinity);
  });
});

describe('getChannelMaxPortfolioRiskViolation', () => {
  const base = {
    maxRiskPercent: 10,
    existingWorstCaseLoss: 0,
    entryPrice: 100,
    stopLoss: 95,
    quantity: 1,
    referenceBalance: 1000,
  };

  it('allows trade within cap', () => {
    expect(getChannelMaxPortfolioRiskViolation(base)).toBeUndefined();
  });

  it('blocks when existing exposure exceeds limit', () => {
    const violation = getChannelMaxPortfolioRiskViolation({
      ...base,
      existingWorstCaseLoss: 150,
    });
    expect(violation).toContain('already exceeds max risk');
  });

  it('blocks when new trade would push over limit', () => {
    const violation = getChannelMaxPortfolioRiskViolation({
      ...base,
      existingWorstCaseLoss: 90,
      quantity: 5,
    });
    expect(violation).toContain('would exceed max risk');
  });
});

describe('buildDailyPnLMap', () => {
  it('aggregates PnL by UTC exit date', () => {
    const map = buildDailyPnLMap([
      trade({ pnl: 10, exit_filled_at: '2026-05-20T12:00:00.000Z', status: 'closed' }),
      trade({ pnl: -3, exit_filled_at: '2026-05-20T18:00:00.000Z', status: 'closed' }),
      trade({ pnl: 5, exit_filled_at: '2026-05-21T01:00:00.000Z', status: 'closed' }),
    ]);
    expect(map.get('2026-05-20')).toBe(7);
    expect(map.get('2026-05-21')).toBe(5);
  });
});

describe('projectTodayRealizedPnLAndPeak', () => {
  it('computes cumulative peak for today only', () => {
    const { realizedPnL, realizedPeakPnL } = projectTodayRealizedPnLAndPeak(
      [
        trade({ pnl: 10, exit_filled_at: '2026-05-24T10:00:00.000Z', status: 'closed' }),
        trade({ pnl: -4, exit_filled_at: '2026-05-24T11:00:00.000Z', status: 'closed' }),
        trade({ pnl: 100, exit_filled_at: '2026-05-23T11:00:00.000Z', status: 'closed' }),
      ],
      '2026-05-24'
    );
    expect(realizedPnL).toBe(6);
    expect(realizedPeakPnL).toBe(10);
  });
});

describe('projectRunningBalanceAndPeak', () => {
  it('tracks balance and high-water mark', () => {
    const { currentBalance, peakBalance } = projectRunningBalanceAndPeak(
      [
        trade({ pnl: 50, exit_filled_at: '2026-01-02T00:00:00.000Z', status: 'closed' }),
        trade({ pnl: -30, exit_filled_at: '2026-01-03T00:00:00.000Z', status: 'closed' }),
      ],
      1000
    );
    expect(currentBalance).toBe(1020);
    expect(peakBalance).toBe(1050);
  });
});

describe('getUtcTodayString', () => {
  it('returns YYYY-MM-DD', () => {
    expect(getUtcTodayString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
