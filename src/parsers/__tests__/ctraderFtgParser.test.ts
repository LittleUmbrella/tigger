import { describe, it, expect } from 'vitest';
import { ctraderFtgParser } from '../ctraderFtgParser.js';

describe('ctraderFtgParser', () => {
  it('parses Format 7: BUYING NOW ENTRIES:a__b STOPLOSS inline TPs', () => {
    const msg =
      '$GOLD BUYING NOW ENTRIES:4416__4410 STOPLOSS 4404 TP 4420 TP 4425 TP 4430 TP 4435 TP 4440 TP 4450';
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4404);
    expect(order!.takeProfits).toEqual([4420, 4425, 4430, 4435, 4440, 4450]);
  });

  it('parses SELLING NOW ENTRIES with double underscore', () => {
    const msg =
      '$GOLD SELLING NOW ENTRIES:2650__2655 STOPLOSS 2660 TP 2645 TP 2640';
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(2660);
  });

  it('treats #XAUUSD BUY NOW + ENTRIES as market (ENTRIES ignored for entry; GOLD still uses ENTRIES)', () => {
    const msg = `#XAUUSD BUY NOW

ENTRIES:4488__4480

STOPLOSS 4474

TP 4494
TP 4498`;
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4474);
    expect(order!.takeProfits).toEqual([4494, 4498]);
  });

  it('parses single-line #XAUUSD BUY NOW ENTRIES:a__b STOPLOSS + TPs (market)', () => {
    const msg =
      '#XAUUSD BUY NOW ENTRIES:4488__4480 STOPLOSS 4474 TP 4494 TP 4498 TP 4502 TP 4510 TP 4520';
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4474);
    expect(order!.takeProfits).toEqual([4494, 4498, 4502, 4510, 4520]);
  });

  it('parses Format 8: symbol + BUY/SELL without entry, SL + TP (market)', () => {
    const msg = `#XAUUSD

BUY

SL: 4534.72

TP: 4608.96`;
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4534.72);
    expect(order!.takeProfits).toEqual([4608.96]);
  });

  it('parses Format 8 single-line: BUY + SL: + TP: (inline colon TPs)', () => {
    const msg = '#XAUUSD BUY SL: 4534.72 TP: 4608.96';
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.stopLoss).toBe(4534.72);
    expect(order!.takeProfits).toEqual([4608.96]);
  });

  it('parses Format 8: #XAUUSD BUY one line, SL/TP', () => {
    const msg = `#XAUUSD BUY
SL: 4500
TP: 4600`;
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.signalType).toBe('long');
  });

  it('parses Format 9: single-line GOLD SELL NOW with 📉a/b📉, TP¹✔️…, SL on same line (market)', () => {
    const msg =
      '$GOLD SELL NOW 📉4536/4539📉 TP¹✔️4533 TP²✔️4530 TP³✔️4527 TP⁴✔️4524 TP⁵✔️4521 TP⁶✔️4518 ♨️ SL 4544';
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(4544);
    expect(order!.takeProfits).toEqual([4533, 4530, 4527, 4524, 4521, 4518]);
  });

  it('parses Format 10: Forex Signal Buy USDCHF, between–till zone as limit (worst entry), Target 1–4, Stop Loss', () => {
    const msg = `🔼Forex Signal Buy USDCHF at any price between 0.7970 till 0.7945 📊 USDCHF Analysis - USDCHF is rebounding from the lower low area of the downtrend line on the weekly timeframe chart. On the daily timeframe, USDCHF has broken the top (lower high) area of the descending channel. Target 1: 0.8017 Target 2: 0.8100 Target 3: 0.8190 Target 4: 0.8315 Stop Loss: 0.7882 Follow below signal rules 📍 After T1 reach, close some trade. Don't place any new trades. Move SL to Entry. 📍 If T1 is not hit Within 2 days (Signal day + Next Working Day AEDT time), If the trade is at Entry = Close Trade in Profit = Move SL to Entry in Loss = Move TP to Entry`;
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('USDCHF');
    expect(order!.signalType).toBe('long');
    expect(order!.entryTargets).toEqual([0.7945, 0.797]);
    expect(order!.entryPrice).toBe(0.797);
    expect(order!.stopLoss).toBe(0.7882);
    expect(order!.takeProfits).toEqual([0.8017, 0.81, 0.819, 0.8315]);
  });

  it('Format 10: respects entryPriceStrategy average for the zone', () => {
    const msg = `Forex Signal Buy USDCHF at any price between 0.7970 till 0.7945 Target 1: 0.8017 Stop Loss: 0.7882`;
    const order = ctraderFtgParser(msg, { entryPriceStrategy: 'average' });
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBeCloseTo((0.797 + 0.7945) / 2, 10);
    expect(order!.entryTargets).toEqual([0.7945, 0.797]);
  });
});
