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

  it('parses Entry: low - high CMP without parens; Lev abbreviation; textual SL above (short)', () => {
    const content =
      'Short: ONDO/USDT (20x-50x Lev) Entry: 0.4085 - 0.3985 CMP DCA: 0.4285 ------------- TP ➊: 0.3785 TP ➋: 0.3540 TP ➌: 0.3245 ------------- SL: H4 candle close above 0.4410 ------------- 1% risk at CMP & 2% at DCA';
    const order = cmpDcaSignalParser(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('ONDOUSDT');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.takeProfits).toEqual([0.3785, 0.354, 0.3245]);
    expect(order!.stopLoss).toBe(0.441);
    expect(order!.leverage).toBe(20);
  });

  it('parses Entry: price (CMP) single-line short (PROMPT-style)', () => {
    const content =
      'Short: PROMPT/USDT Entry: 0.03670 (CMP) DCA: 0.03900 ------------- TP ➊: 0.03510 TP ➋: 0.03290 TP ➌: 0.03044 ------------- SL: H4 candle close above 0.04044';
    const order = cmpDcaSignalParser(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('PROMPTUSDT');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.takeProfits).toEqual([0.0351, 0.0329, 0.03044]);
    expect(order!.stopLoss).toBe(0.04044);
    expect(order!.leverage).toBe(20);
  });

  it('parses Entry: price cmp without parens (message 1512120394390311216)', () => {
    const content =
      'Short: ENA/USDT (20x leverage) Entry: 0.09810 cmp DCA: 0.10512 ------------- TP ➊: 0.09190 TP ➋: 0.08715 TP ➌: 0.08030 ------------- SL: H4 candle close above 0.10825';
    const order = cmpDcaSignalParser(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('ENAUSDT');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.takeProfits).toEqual([0.0919, 0.08715, 0.0803]);
    expect(order!.stopLoss).toBe(0.10825);
    expect(order!.leverage).toBe(20);
  });

  it('rejects Entry: price (CMP) when TPs are order-of-magnitude typos (message 1506948389177397329)', () => {
    const content =
      'Short: PROMPT/USDT Entry: 0.03670 (CMP) DCA: 0.03900 ------------- TP ➊: 0.003510 TP ➋: 0.003290 TP ➌: 0.003044 ------------- SL: H4 candle close above 0.04044';
    expect(cmpDcaSignalParser(content)).toBeNull();
  });

  it('parses Limit Entry range as limit signal with entryPrice (message 1506307353723666494)', () => {
    const content =
      'Short: EPIC/USDT — 20x/50x Lev Limit Entry: 0.3144 - 0.3272 DCA: 0.3434 ------------- TP ➊: 0.2890 TP ➋: 0.2664 TP ➌: 0.2452 SL: H4 candle close above 0.3575 ------------- Confluences: TL breakdown confirmed, daily FVG resistance, & weekly pin bar reversal.';
    const order = cmpDcaSignalParser(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('EPICUSDT');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBe(0.3144);
    expect(order!.entryTargets).toEqual([0.3144, 0.3272]);
    expect(order!.takeProfits).toEqual([0.289, 0.2664, 0.2452]);
    expect(order!.stopLoss).toBe(0.3575);
    expect(order!.leverage).toBe(20);
  });

  it('parses Limit Entry single price', () => {
    const content =
      'Long: FOO/USDT Limit Entry: 1.25 DCA: 1.20 ------------- TP ➊: 1.35 SL: below 1.10';
    const order = cmpDcaSignalParser(content);
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBe(1.25);
    expect(order!.entryTargets).toBeUndefined();
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
