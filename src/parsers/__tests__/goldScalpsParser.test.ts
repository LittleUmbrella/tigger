import { describe, expect, it } from 'vitest';
import { goldScalpsParser } from '../goldScalpsParser.js';

const sampleSell = `Sell Gold @5066-5075

Sl :5077

Tp1 :5061
Tp2 :5050

Enter Slowly`;

describe('goldScalpsParser', () => {
  it('parses sell gold with range entry and numbered TPs', () => {
    const order = goldScalpsParser(sampleSell);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUTUSDT');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBe(5066);
    expect(order!.stopLoss).toBe(5077);
    expect(order!.takeProfits).toEqual([5061, 5050]);
  });

  it('parses buy with average entry strategy', () => {
    const msg = `Buy XAU @100-110
Sl :95
Tp1 :120
Tp2 :130`;
    const order = goldScalpsParser(msg, { entryPriceStrategy: 'average' });
    expect(order).not.toBeNull();
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBe(105);
  });

  it('returns null for invalid messages', () => {
    expect(goldScalpsParser('random text')).toBeNull();
    expect(goldScalpsParser('Buy Gold @100-110\nSl :95')).toBeNull();
  });
});
