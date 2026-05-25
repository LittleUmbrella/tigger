import { describe, expect, it } from 'vitest';
import type { Trade } from '../../db/schema.js';
import {
  classifyCtraderCloseFromExitAndPnl,
  classifyCtraderCloseFromDb,
  collectSignalTakeProfitLevels,
} from '../ctraderCloseClassification.js';

const baseTrade = (overrides: Partial<Trade>): Trade =>
  ({
    id: 1,
    message_id: '14654',
    channel: '2845421508',
    exchange: 'ctrader',
    account_name: 'ctrader_demo_2_100',
    trading_pair: 'XAUUSD',
    direction: 'short',
    entry_price: 4575.28,
    stop_loss: 4580,
    take_profits: '[4550.91]',
    status: 'stopped',
    exit_price: 4565.68,
    pnl: 792.92,
    ...overrides,
  }) as Trade;

describe('collectSignalTakeProfitLevels', () => {
  it('merges TP prices from all legs', () => {
    const levels = collectSignalTakeProfitLevels([
      baseTrade({ take_profits: '[4565.91]', id: 1 }),
      baseTrade({ take_profits: '[4550.91]', id: 2 }),
    ]);
    expect(levels).toEqual([4550.91, 4565.91]);
  });
});

describe('classifyCtraderCloseFromExitAndPnl', () => {
  it('classifies TP2 leg closed at TP1 price as take_profit when signal TPs include TP1', () => {
    const leg = baseTrade({ take_profits: '[4550.91]' });
    const signalTps = [4550.91, 4565.91];
    expect(classifyCtraderCloseFromExitAndPnl(leg, 4565.68, 792.92, signalTps)).toBe(
      'take_profit'
    );
  });

  it('positive PnL overrides leg-only exit classification when nearer SL than leg TP2', () => {
    const leg = baseTrade({ take_profits: '[4550.91]' });
    expect(classifyCtraderCloseFromExitAndPnl(leg, 4565.68, 792.92, [])).toBe('take_profit');
  });

  it('negative PnL at SL remains stop_loss', () => {
    const leg = baseTrade({
      take_profits: '[4550.91]',
      exit_price: 4580,
      pnl: -50,
    });
    expect(classifyCtraderCloseFromExitAndPnl(leg, 4580, -50, [4550.91, 4565.91])).toBe(
      'stop_loss'
    );
  });

  it('uses PnL when exit price is missing', () => {
    const leg = baseTrade({ take_profits: '[4550.91]' });
    expect(classifyCtraderCloseFromExitAndPnl(leg, undefined, 792.92)).toBe('take_profit');
  });
});

describe('classifyCtraderCloseFromDb', () => {
  it('reclassifies stopped sibling as take_profit for breakeven counting', () => {
    const tp1Leg = baseTrade({ id: 1151, take_profits: '[4565.91]', status: 'active' });
    const tp2Leg = baseTrade({
      id: 1152,
      take_profits: '[4550.91]',
      status: 'stopped',
      exit_price: 4565.68,
      pnl: 792.92,
    });
    const signalTps = collectSignalTakeProfitLevels([tp1Leg, tp2Leg]);
    expect(classifyCtraderCloseFromDb(tp2Leg, signalTps)).toBe('take_profit');
  });
});
