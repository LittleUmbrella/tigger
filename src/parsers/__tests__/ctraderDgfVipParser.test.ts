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

  it('parses single-line XAUUSD BUY NOW with dash entry range and Tp labels', () => {
    const msg =
      '🛡XAUUSD BUY NOW 4650-4646 💣 Sl: 4642 Tp1: 4660 Tp2: 4670 Tp3: 4680 Tp4: 4700 Use proper money management. Consistency is 🔑';
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.marketExecution).toBe(true);
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4642);
    expect(order!.takeProfits).toEqual([4660, 4670, 4680, 4700]);
  });

  it('parses single-line XAUUSD BUY with "Stop Loss:" label', () => {
    const msg =
      '🛡XAUUSD BUY 4795-4805 TP1: 4810 TP2: 4815 TP3: 4820 💣Stop Loss: 4780 Use proper money management. Consistency is 🔑';
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.marketExecution).toBe(true);
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4780);
    expect(order!.takeProfits).toEqual([4810, 4815, 4820]);
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

  it('parses Format 8 limit on one line (Entry / SL / TP)', () => {
    const msg =
      '$XAUUSD long | +8RR Entry : 4720.00 / SL : 4702.20 / TP : 4800.00';
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBe(4720);
    expect(order!.stopLoss).toBe(4702.2);
    expect(order!.takeProfits).toEqual([4800]);
  });

  it('parses XAUUSD : BUY (colon before side) with dash entry, emoji SL, Tp labels', () => {
    const msg =
      '🛡XAUUSD : BUY 4750-4740 TP1: 4765 TP2: 4770 TP3: 4775 💣SL 4730 Use proper money management. Consistency is 🔑';
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.stopLoss).toBe(4730);
    expect(order!.takeProfits).toEqual([4765, 4770, 4775]);
  });

  it('parses Format 9 as limit: emoji, XAUUSD | SELL SIGNAL, Entry range, TP arrows', () => {
    const msg =
      '📢 XAUUSD | SELL SIGNAL 🟢 Entry: 4705-4700 💣 SL: 4715 TP1 ➝ 4695 TP2 ➝ 4690 TP3 ➝ 4685 Tp 4 — 4680 Use proper money management. Consistency is 🔑';
    const order = ctraderDgfVipParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBe(4700);
    expect(order!.marketExecution).toBe(false);
    expect(order!.stopLoss).toBe(4715);
    expect(order!.takeProfits).toEqual([4695, 4690, 4685, 4680]);
  });
});
