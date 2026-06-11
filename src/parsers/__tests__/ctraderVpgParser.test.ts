import { describe, it, expect } from 'vitest';
import { ctraderVpgParser } from '../ctraderVpgParser.js';

describe('ctraderVpgParser', () => {
  it('parses Format 1 via FTG fallback (slash entry, numbered TPs)', () => {
    const msg = '$XAUUSD SELL 4107/ 4109 SL: 4116 TP 1:4100 TP 2:4095 TP 3:4090';
    const order = ctraderVpgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('short');
    expect(order!.stopLoss).toBe(4116);
    expect(order!.takeProfits).toEqual([4100, 4095, 4090]);
  });

  it('parses Format 2 via DGF VIP fallback (emoji header, Entry range)', () => {
    const msg =
      '📢 XAUUSD | BUY SIGNAL 🟢 Entry: 4089-4094 🛑 SL: 4080 🎯 TP Levels: TP1 ➝ 4098 TP2➝ 4103 TP3 ➝ 4108 TP 4—4113';
    const order = ctraderVpgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBe(4094);
    expect(order!.stopLoss).toBe(4080);
    expect(order!.takeProfits).toEqual([4098, 4103, 4108, 4113]);
  });

  it('parses Format 3 (underscore entry, STOP LOSS, superscript TPs)', () => {
    const msg =
      '#XAUUSD BUYING 4072_4068 STOP LOSS 4063 TP¹: 4075 TP²: 4078 TP³: 4082 TP⁴: 4085 TP⁵: 4092 TP⁶: 4100';
    const order = ctraderVpgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBe(4072);
    expect(order!.entryTargets).toEqual([4068, 4072]);
    expect(order!.stopLoss).toBe(4063);
    expect(order!.takeProfits).toEqual([4075, 4078, 4082, 4085, 4092, 4100]);
  });

  it('parses Format 4 (dot slash entry, bullet superscript TPs)', () => {
    const msg =
      '🎓 GOLD BUY .4147/4144 TP ¹• 4150 TP ²• 4153 TP ³• 4156 TP ⁴• 4159 TP ⁵• 4162 TP ⁶• 4165 ♦️ SL ° 4137';
    const order = ctraderVpgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBe(4147);
    expect(order!.stopLoss).toBe(4137);
    expect(order!.takeProfits).toEqual([4150, 4153, 4156, 4159, 4162, 4165]);
  });

  it('returns null for TP hit updates', () => {
    const msg = '$XAUUSD TP3. DONE ✅ 170+ PIPS PROFIT 🎯✅';
    expect(ctraderVpgParser(msg)).toBeNull();
  });
});
