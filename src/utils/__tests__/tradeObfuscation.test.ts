import { describe, it, expect, vi } from 'vitest';
import { applyTradeObfuscation, resolveObfuscatedStopLossAbsolute } from '../tradeObfuscation.js';
import type { ParsedOrder } from '../../types/order.js';
import type { TradeObfuscationConfig } from '../../types/config.js';

describe('applyTradeObfuscation', () => {
  const baseOrder: ParsedOrder = {
    tradingPair: 'BTCUSDT',
    leverage: 20,
    entryPrice: 50000,
    stopLoss: 49000,
    takeProfits: [51000, 52000, 53000],
    signalType: 'long',
  };

  it('returns order unchanged when no obfuscation config', () => {
    const config: TradeObfuscationConfig = {};
    const result = applyTradeObfuscation(baseOrder, config);
    expect(result).toEqual(baseOrder);
  });

  it('applies sl obfuscation toward worse price for long trades', () => {
    const config: TradeObfuscationConfig = {
      sl: 1,
    };
    const result = applyTradeObfuscation(baseOrder, config);
    expect(result.stopLoss).toBe(48510); // 49000 * (1 - 0.01)
    expect(result.entryPrice).toBe(baseOrder.entryPrice);
    expect(result.takeProfits).toEqual(baseOrder.takeProfits);
  });

  it('applies sl obfuscation toward worse price for short trades', () => {
    const shortOrder: ParsedOrder = {
      ...baseOrder,
      signalType: 'short',
      stopLoss: 51000,
    };
    const config: TradeObfuscationConfig = {
      sl: 1,
    };
    const result = applyTradeObfuscation(shortOrder, config);
    expect(result.stopLoss).toBeCloseTo(51510, 0); // 51000 * (1 + 0.01)
  });

  it('resolveObfuscatedStopLossAbsolute applies sl obfuscation from signal SL', () => {
    const sl = resolveObfuscatedStopLossAbsolute(4580, 'short', { sl: 1 });
    expect(sl).toBeCloseTo(4625.8, 1); // 4580 * 1.01
  });

  it('resolveObfuscatedStopLossAbsolute returns signal SL when no sl config', () => {
    expect(resolveObfuscatedStopLossAbsolute(4580, 'short', { tp: 0.02 })).toBe(4580);
  });

  it('treats negative sl offset as absolute value', () => {
    const config: TradeObfuscationConfig = {
      sl: -0.5,
    };
    const result = applyTradeObfuscation(baseOrder, config);
    expect(result.stopLoss).toBeCloseTo(48755, 0); // 49000 * (1 - 0.005)
  });
  it('applies entry obfuscation when entry config present', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const config: TradeObfuscationConfig = {
      entry: { minPercent: -0.5, maxPercent: 0.5 },
    };
    const result = applyTradeObfuscation(baseOrder, config);
    expect(result.entryPrice).toBeCloseTo(49750, 0); // 50000 * 0.995
    expect(result.stopLoss).toBe(baseOrder.stopLoss);
    randomSpy.mockRestore();
  });

  it('applies tp obfuscation in worse direction for long trades', () => {
    const config: TradeObfuscationConfig = {
      tp: 0.2,
    };
    const result = applyTradeObfuscation(baseOrder, config);
    expect(result.takeProfits).toHaveLength(3);
    expect(result.takeProfits[0]).toBeCloseTo(50898, 0);
    expect(result.takeProfits[1]).toBeCloseTo(51896, 0);
    expect(result.takeProfits[2]).toBeCloseTo(52894, 0);
    expect(result.stopLoss).toBe(baseOrder.stopLoss);
  });

  it('applies tp obfuscation in worse direction for short trades', () => {
    const shortOrder: ParsedOrder = {
      ...baseOrder,
      signalType: 'short',
    };
    const config: TradeObfuscationConfig = {
      tp: 0.2,
    };
    const result = applyTradeObfuscation(shortOrder, config);
    expect(result.takeProfits).toHaveLength(3);
    expect(result.takeProfits[0]).toBeCloseTo(51102, 0);
    expect(result.takeProfits[1]).toBeCloseTo(52104, 0);
    expect(result.takeProfits[2]).toBeCloseTo(53106, 0);
  });

  it('treats negative tp offset as absolute value', () => {
    const config: TradeObfuscationConfig = {
      tp: -0.2,
    };
    const result = applyTradeObfuscation(baseOrder, config);
    expect(result.takeProfits[0]).toBeCloseTo(50898, 0);
  });

  it('does not mutate the input order', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const config: TradeObfuscationConfig = {
      entry: { minPercent: 0.5, maxPercent: 0.5 },
    };
    const original = { ...baseOrder };
    applyTradeObfuscation(baseOrder, config);
    expect(baseOrder).toEqual(original);
    randomSpy.mockRestore();
  });

  it('handles optional entryPrice and entryTargets', () => {
    const orderNoEntry: ParsedOrder = {
      ...baseOrder,
      entryPrice: undefined,
      entryTargets: [49900, 50100],
    };
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const config: TradeObfuscationConfig = {
      entry: { minPercent: -0.5, maxPercent: 0.5 },
    };
    const result = applyTradeObfuscation(orderNoEntry, config);
    expect(result.entryPrice).toBeUndefined();
    expect(result.entryTargets).toHaveLength(2);
    expect(result.entryTargets![0]).toBeCloseTo(49650.5, 0); // 49900 * 0.995
    expect(result.entryTargets![1]).toBeCloseTo(49849.5, 0); // 50100 * 0.995
    randomSpy.mockRestore();
  });
});
