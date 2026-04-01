import { describe, it, expect } from 'vitest';
import { ctraderDgfVipParser } from '../ctraderDgfVipParser.js';

describe('ctraderDgfVipParser', () => {
  it('parses single-line XAUUSD with SL: Solid break <price> (no @)', () => {
    const msg =
      'XAUUSD SELL NOW @ 4438 SL: Solid break 4446 TP: 4430 TP: 4422';
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.marketExecution).toBe(true);
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
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('EURNZD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(1.98373);
    expect(order!.takeProfits).toEqual([2.01364]);
  });

  it('parses Format 5 forex single-line without # before symbol', () => {
    const msg = 'Buy NOW EURNZD @ 2.00467 SL @ 1.99465 TP @ 2.02456';
    const order = ctraderDgfVipParser(msg);
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
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.stopLoss).toBe(4442);
  });

  it('parses TP labels with Unicode superscript ordinals (TP¹ TP² …)', () => {
    const msg =
      'XAUUSD BUY 4722 TP¹ 4708 TP² 4711 TP³ 4714 TP⁴ 4717 TP⁵ 4720 TP⁶ 4725 SL 4693';
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.stopLoss).toBe(4693);
    expect(order!.takeProfits).toEqual([4708, 4711, 4714, 4717, 4720, 4725]);
  });

  it('parses Format 6: emoji prefix, symbol before SELL, slash entry, TP¹ lines, emoji SL', () => {
    const msg = `🛡XAUUSD SELL 4782/4785

TP¹ 4779
TP² 4776
TP³ 4773
TP⁴ 4770
TP⁵ 4767
TP⁶ 4764

💣 SL 4791`;
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4791);
    expect(order!.takeProfits).toEqual([4779, 4776, 4773, 4770, 4767, 4764]);
  });

  it('parses dash entry range, Sl: label, Tp1: lines, and ignores footer text', () => {
    const msg = `🛡XAUUSD BUY 4718-4714

💣Sl: 4710

Tp1: 4728
Tp2: 4738
Tp3: 4748
Tp4: 4768

Use proper money management. Consistency is 🔑`;
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.stopLoss).toBe(4710);
    expect(order!.takeProfits).toEqual([4728, 4738, 4748, 4768]);
  });

  it('parses Format 7: pipe before side, TP arrow lines, Tp N — price', () => {
    const msg = `🛡XAUUSD | BUY  4713-4718

💣 SL: 4700

TP1 ➝ 4723
TP2 ➝ 4728
TP3 ➝ 4733
Tp 4 — 4738

Use proper money management. Consistency is 🔑`;
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.stopLoss).toBe(4700);
    expect(order!.takeProfits).toEqual([4723, 4728, 4733, 4738]);
  });

  it('parses Format 8 as limit: $XAUUSD long | RR header, Entry/SL/TP lines', () => {
    const msg = `$XAUUSD long | +8RR

Entry : 4720.00
SL : 4702.20
TP : 4800.00

 Use proper money management. Consistency is 🔑`;
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBe(4720);
    expect(order!.marketExecution).toBe(false);
    expect(order!.stopLoss).toBe(4702.2);
    expect(order!.takeProfits).toEqual([4800]);
  });
});
