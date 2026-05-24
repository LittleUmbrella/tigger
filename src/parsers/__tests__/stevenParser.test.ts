import { describe, expect, it } from 'vitest';
import { stevenParser } from '../stevenParser.js';

describe('stevenParser', () => {
  it('parses market gold buy with emoji prefix', () => {
    const msg = `🔴Gold buy now  3956 :3953
🔖take Profit  3961
🔖take Profit  3966
❌Stop loss .  3946`;
    const order = stevenParser(msg);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('XAUUSD');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeUndefined();
    expect(order!.stopLoss).toBe(3946);
    expect(order!.takeProfits).toEqual([3961, 3966]);
  });

  it('parses limit sell with entry from first line', () => {
    const msg = `Gold sell 4000 :3995
take profit 3980
Stop loss 4010`;
    const order = stevenParser(msg);
    expect(order).not.toBeNull();
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBe(4000);
    expect(order!.takeProfits).toEqual([3980]);
  });
});
