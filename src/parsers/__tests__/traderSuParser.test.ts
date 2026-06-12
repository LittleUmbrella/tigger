import { describe, it, expect } from 'vitest';
import { traderSuParser } from '../traderSuParser.js';

describe('traderSuParser', () => {
  it('parses limit entry from dash when NOW is absent', () => {
    const msg = `gold buy - 5054
SL 5052
TP 5066
TP 5076`;
    const order = traderSuParser(msg);
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBe(5054);
    expect(order!.marketExecution).toBe(false);
    expect(order!.signalType).toBe('long');
    expect(order!.stopLoss).toBe(5052);
    expect(order!.takeProfits).toEqual([5066, 5076]);
  });

  it('parses limit entry from @ when NOW is absent', () => {
    const msg = `gold buy @5055 - 5051
SL 5049
TP 5066`;
    const order = traderSuParser(msg);
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBe(5055);
    expect(order!.marketExecution).toBe(false);
  });

  it('treats NOW on first line as market execution (entry omitted)', () => {
    const msg = `gold buy Now!! - 5054
SL 5052
TP 5066
TP 5076`;
    const order = traderSuParser(msg);
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.marketExecution).toBe(true);
    expect(order!.stopLoss).toBe(5052);
  });

  it('parses compact NOW line as market', () => {
    const msg = 'XAUUSD BUY NOW @5193 - 5187 SL:5184 TP:5203 TP:5210 TP:5218';
    const order = traderSuParser(msg);
    expect(order).not.toBeNull();
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.marketExecution).toBe(true);
    expect(order!.stopLoss).toBe(5184);
    expect(order!.takeProfits).toEqual([5203, 5210, 5218]);
  });

  it('returns null when limit signal has no entry price', () => {
    const msg = `gold buy
SL 5052
TP 5066`;
    expect(traderSuParser(msg)).toBeNull();
  });
});
