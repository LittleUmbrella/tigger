import { describe, expect, it } from 'vitest';
import { fxcmChartParser } from '../fxcmChartParser.js';

describe('fxcmChartParser', () => {
  it('parses JSON format', () => {
    const json = JSON.stringify({
      asset: 'XAUUSD',
      direction: 'long',
      entry: 5216.72,
      sl: 5203.4,
      tp: [5245.38],
    });
    const order = fxcmChartParser(json);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBe(5216.72);
    expect(order!.stopLoss).toBe(5203.4);
    expect(order!.takeProfits).toEqual([5245.38]);
  });

  it('parses structured text', () => {
    const text = 'XAUUSD Long Entry: 5216.72 SL: 5203.40 TP: 5245.38';
    const order = fxcmChartParser(text);
    expect(order).not.toBeNull();
    expect(order!.signalType).toBe('long');
    expect(order!.takeProfits).toContain(5245.38);
  });

  it('returns null when asset or levels missing', () => {
    expect(fxcmChartParser('BTC long entry 1')).toBeNull();
  });
});
