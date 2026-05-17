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

  it('parses PENGU buy-zone signal with average entry (message 1853)', () => {
    const content =
      '🥇 #PENGUUSDT 📤 Long 💹 Buy: 0.008412 - 0.008539 🧿 Target: 0.008530 - 0.008606 - 0.008691 - 0.008792 - 0.008919 - 0.009088 🧨 StopLoss: 0.008158 🔘 Leverage: 5-10x';
    const orderWorst = vipCryptoSignals(content);
    expect(orderWorst).toBeNull();

    const order = vipCryptoSignals(content, { entryPriceStrategy: 'average' });
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('PENGU');
    expect(order!.signalType).toBe('long');
    expect(order!.entryPrice).toBeCloseTo(0.0084755, 7);
    expect(order!.stopLoss).toBe(0.008158);
    expect(order!.takeProfits).toEqual([0.00853, 0.008691, 0.008792, 0.008919, 0.009088]);
    expect(order!.leverage).toBe(5);
  });
});
