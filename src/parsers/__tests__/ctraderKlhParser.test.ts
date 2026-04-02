import { describe, it, expect } from 'vitest';
import { ctraderKlhParser } from '../ctraderKlhParser.js';

describe('ctraderKlhParser', () => {
  it('parses multi-line format (line-leading TP / SL)', () => {
    const msg = `#XAUUSD SELL NOW 4520/4522
TP: 4515
TP: 4510
SL : 4530`;
    const order = ctraderKlhParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('short');
    expect(order!.stopLoss).toBe(4530);
    expect(order!.takeProfits).toEqual([4515, 4510]);
  });

  it('parses single-line format with inline TP and SL', () => {
    const msg =
      '#XAUUSD BUY NOW 4788/4786 TP: 4793 TP: 4798 TP: 4803 TP: 4808 SL : 4778';
    const order = ctraderKlhParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.stopLoss).toBe(4778);
    expect(order!.takeProfits).toEqual([4793, 4798, 4803, 4808]);
  });
});
