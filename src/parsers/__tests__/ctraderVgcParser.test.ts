import { describe, it, expect } from 'vitest';
import { ctraderVgcParser } from '../ctraderVgcParser.js';

describe('ctraderVgcParser', () => {
  it('parses Trading Strategy BUY ZONE: limit entry; trailing OPEN resolved like DGF VIP (mean gap extrapolation)', () => {
    const msg =
      'XAUUSD Trading Strategy 11 ✅ Trade Setup #11 – April 8, 2026 🔷 BUY ZONE XAUUSD: 4736 – 4738 🔺 SL: 4727 🔸 TP: 4743 – 4750 – 4760 – OPEN Be careful trading with your capital @Abdul_Shakourm';
    const order = ctraderVgcParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBe(4738);
    expect(order!.entryTargets).toEqual([4736, 4738]);
    expect(order!.stopLoss).toBe(4727);
    // Mean gap (4750-4743 + 4760-4750) / 2 = 8.5 → fourth TP = 4760 + 8.5
    expect(order!.takeProfits).toEqual([4743, 4750, 4760, 4768.5]);
    expect(order!.marketExecution).toBeUndefined();
  });

  it('respects entryPriceStrategy average for the zone', () => {
    const msg =
      'BUY ZONE XAUUSD: 4736 – 4738 SL: 4727 TP: 4743 – 4750 – 4760 – OPEN';
    const order = ctraderVgcParser(msg, { entryPriceStrategy: 'average' });
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBeCloseTo((4736 + 4738) / 2, 10);
  });

  it('parses four numeric TP levels when present', () => {
    const msg = 'BUY ZONE XAUUSD: 100 – 101 SL: 99 TP: 102 – 103 – 104 – 105';
    const order = ctraderVgcParser(msg);
    expect(order).not.toBeNull();
    expect(order!.takeProfits).toEqual([102, 103, 104, 105]);
  });

  it('falls back to ctraderFtgParser for non-VGC-layout messages', () => {
    const msg = `#XAUUSD
BUY
SL: 4534.72
TP: 4608.96`;
    const order = ctraderVgcParser(msg);
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.takeProfits).toEqual([4608.96]);
  });

  it('parses FTG-style single-line message with TP.OPEN and SL checkmark decoration', () => {
    const msg =
      'XAUUSD sell now 4756//4759 TP 4753 TP 4750 TP 4747 TP 4744 TP 4741 TP 4740 TP.OPEN SL✓4766 ✔️';
    const order = ctraderVgcParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4766);
    expect(order!.takeProfits).toEqual([4753, 4750, 4747, 4744, 4741, 4740]);
  });
});
