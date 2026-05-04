import { describe, it, expect } from 'vitest';
import { cmpDcaSignalParser } from '../cmpDcaSignalParser.js';

describe('cmpDcaSignalParser', () => {
  const sampleLong = `Long: ID/USDT 
(20x-50x Leverage)
Entry at CMP: 0.03155
DCA: 0.03070
-------------
TP ➊: 0.03295
TP ➋: 0.03540
TP ➌: 0.03790
-------------
SL: H4 candle close below 0.02975
-------------
1% risk at CMP & 2% at DCA`;

  it('parses long with circled TPs and textual SL below; CMP/DCA omitted from ParsedOrder entry', () => {
    const order = cmpDcaSignalParser(sampleLong);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('IDUSDT');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.entryTargets).toBeUndefined();
    expect(order!.takeProfits).toEqual([0.03295, 0.0354, 0.0379]);
    expect(order!.stopLoss).toBe(0.02975);
    expect(order!.leverage).toBe(20);
  });

  it('parses compact single-line Discord body (no newlines)', () => {
    const content =
      'Long: ID/USDT (20x-50x Leverage) Entry at CMP: 0.03155 DCA: 0.03070 ------------- TP ➊: 0.03295 TP ➋: 0.03540 TP ➌: 0.03790 ------------- SL: H4 candle close below 0.02975 ------------- 1% risk at CMP & 2% at DCA';
    const order = cmpDcaSignalParser(content);
    expect(order).not.toBeNull();
    expect(order!.takeProfits).toEqual([0.03295, 0.0354, 0.0379]);
    expect(order!.stopLoss).toBe(0.02975);
  });

  it('parses Entry: low - high (CMP) as CMP-style; still no entryPrice (pseudo-market)', () => {
    const content =
      'Long: RESOLV/USDT (20x-50x Leverage) Entry: 0.02890 - 0.03004 (CMP) DCA: 0.02800 ------------- TP ➊: 0.03150 TP ➋: 0.03270 TP ➌: 0.03700 ------------- SL: H4 candle close below 0.02740';
    const order = cmpDcaSignalParser(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('RESOLVUSDT');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.takeProfits).toEqual([0.0315, 0.0327, 0.037]);
    expect(order!.stopLoss).toBe(0.0274);
    expect(order!.leverage).toBe(20);
  });

  it('parses short with numeric SL and TP1 numbering', () => {
    const content = `Short: BTC/USDT
(5x Leverage)
Entry at CMP: 95000
SL: 96800

TP 1: 93000`;
    const order = cmpDcaSignalParser(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('BTCUSDT');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(96800);
    expect(order!.takeProfits).toEqual([93000]);
    expect(order!.leverage).toBe(5);
  });
});
