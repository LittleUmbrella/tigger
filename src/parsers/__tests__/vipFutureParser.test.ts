import { describe, it, expect } from 'vitest';
import { vipCryptoSignals } from '../channels/2427485240/vip-future.js';

describe('vipCryptoSignals (2427485240)', () => {
  it('parses EXIT comma-separated targets (message 1756 style)', () => {
    const content =
      '#KITEUSDT / LONG / 10X-20X ENTRY: 0.206 - 0.195 EXIT: 0.212 , 0.218 , 0.224 , 0.236 , 0.250 STOPLOSS: 0.185';
    const order = vipCryptoSignals(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('KITE');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBe(0.206);
    expect(order!.stopLoss).toBe(0.185);
    expect(order!.takeProfits).toEqual([0.212, 0.218, 0.224, 0.236, 0.25]);
  });
});
