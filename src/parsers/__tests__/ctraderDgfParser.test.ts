import { describe, it, expect } from 'vitest';
import { ctraderDgfParser } from '../ctraderDgfParser.js';

describe('ctraderDgfParser', () => {
  it('parses single-line XAUUSD with SL: Solid break <price> (no @)', () => {
    const msg =
      'XAUUSD SELL NOW @ 4438 SL: Solid break 4446 TP: 4430 TP: 4422';
    const order = ctraderDgfParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4446);
    expect(order!.takeProfits).toEqual([4430, 4422]);
  });

  it('parses Format 5 forex with # before symbol', () => {
    const msg = `Buy NOW #EURNZD @ 1.99376

SL @ 1.98373

TP @ 2.01364`;
    const order = ctraderDgfParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('EURNZD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(1.98373);
    expect(order!.takeProfits).toEqual([2.01364]);
  });

  it('parses Format 5 forex single-line without # before symbol', () => {
    const msg = 'Buy NOW EURNZD @ 2.00467 SL @ 1.99465 TP @ 2.02456';
    const order = ctraderDgfParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('EURNZD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(1.99465);
    expect(order!.takeProfits).toEqual([2.02456]);
  });

  it('still parses multi-line Solid break @ price', () => {
    const msg = `XAUUSD BUY NOW @ 4450

SL: Solid break @ 4442

TP: 4458
TP: 4466`;
    const order = ctraderDgfParser(msg);
    expect(order).not.toBeNull();
    expect(order!.stopLoss).toBe(4442);
  });
});
