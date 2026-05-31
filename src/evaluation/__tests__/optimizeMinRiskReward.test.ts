import { describe, expect, it } from 'vitest';
import {
  buildMinRiskRewardGrid,
  formatSweepMarkdownTable,
  type SweepRunSummary,
} from '../../scripts/optimize_min_risk_reward.js';

describe('buildMinRiskRewardGrid', () => {
  it('has 15 values from 0.5 to 2.5 with 0.15 steps plus 2.5', () => {
    const grid = buildMinRiskRewardGrid();
    expect(grid).toHaveLength(15);
    expect(grid[0]).toBe(0.5);
    expect(grid[13]).toBe(2.45);
    expect(grid[14]).toBe(2.5);
  });
});

describe('formatSweepMarkdownTable', () => {
  it('sorts by PnL descending', () => {
    const runs: SweepRunSummary[] = [
      {
        minRiskReward: 1.5,
        totalPnL: 100,
        maxDrawdownPct: 8,
        passed: true,
        filledTrades: 10,
        wins: 5,
        losses: 5,
        breakeven: 0,
        winRatePct: 50,
        totalMessages: 100,
        stopped: 5,
        closed: 5,
        worstLoss: -50,
        bestWin: 80,
        tradesFile: 'a.csv',
      },
      {
        minRiskReward: 1.0,
        totalPnL: 200,
        maxDrawdownPct: 10,
        passed: false,
        filledTrades: 12,
        wins: 6,
        losses: 6,
        breakeven: 0,
        winRatePct: 50,
        totalMessages: 100,
        stopped: 6,
        closed: 6,
        worstLoss: -55,
        bestWin: 90,
        tradesFile: 'b.csv',
      },
    ];
    const md = formatSweepMarkdownTable(runs);
    expect(md.indexOf('1.00')).toBeLessThan(md.indexOf('1.50'));
    expect(md).toContain('$200.00');
  });
});
