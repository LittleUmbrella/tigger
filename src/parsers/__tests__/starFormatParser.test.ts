import { describe, it, expect } from 'vitest';
import { starFormatParser } from '../starFormatParser.js';

describe('starFormatParser', () => {
  it('parses Cryptosyntix-style single-line message with $ prices (message 13625)', () => {
    const content =
      '⭐ #ZEC/USDT 🛑 SHORT 📊 EXCHANGE - BYBIT/BINGX/MEXC 🧑‍🎤 Leverage: 5X 🔥 👉 Entry = $319.9500 - $331.7336 TARGET - $296.3828 - $272.8157 - $237.4649 ❌ Stop Loss - $355.3007 www.cryptosyntix.com';
    const order = starFormatParser(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('ZECUSDT');
    expect(order!.signalType).toBe('short');
    expect(order!.entryPrice).toBe(319.95);
    expect(order!.stopLoss).toBe(355.3007);
    expect(order!.takeProfits).toEqual([296.3828, 272.8157, 237.4649]);
    expect(order!.leverage).toBe(5);
  });

  it('still parses classic star format without dollar signs', () => {
    const content = `🌟 #RIVER/USDT 

🛑 Short 

📊 EXCHANGE -BYBIT/BINGX/MEXC

🧑‍🎤 Leverage: 3- 8X 🔥

👉 Entry = 27.65 - 29.89

TARGET-  26.45 - 25.67 - 24.79 - 22.80 - 20.78+

❌STOP LOSS - 31.89`;
    const order = starFormatParser(content);
    expect(order).not.toBeNull();
    expect(order!.tradingPair).toBe('RIVERUSDT');
    expect(order!.signalType).toBe('short');
    expect(order!.stopLoss).toBe(31.89);
  });
});
