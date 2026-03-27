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
    expect(order!.entryPrice).toBe(4410);
    expect(order!.stopLoss).toBe(4404);
    expect(order!.takeProfits).toEqual([4420, 4425, 4430, 4435, 4440, 4450]);
  });

  it('parses SELLING NOW ENTRIES with double underscore', () => {
    const msg =
      '$GOLD SELLING NOW ENTRIES:2650__2655 STOPLOSS 2660 TP 2645 TP 2640';
    const order = ctraderFtgParser(msg);
    expect(order).not.toBeNull();
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBe(2655);
    expect(order!.stopLoss).toBe(2660);
  });
});
