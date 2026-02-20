import { describe, it, expect, vi } from 'vitest';
import { applyTradeObfuscation } from '../tradeObfuscation.js';
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

  it('applies sl obfuscation when sl config present', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);
    const config: TradeObfuscationConfig = {
      sl: { minPercent: 0, maxPercent: 1 },
    };
    const result = applyTradeObfuscation(baseOrder, config);
    expect(result.stopLoss).toBe(49490); // 49000 * 1.01
    expect(result.entryPrice).toBe(baseOrder.entryPrice);
    expect(result.takeProfits).toEqual(baseOrder.takeProfits);
    randomSpy.mockRestore();
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

  it('applies tp obfuscation when tp config present', () => {
    const randomSpy = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(1);
    const config: TradeObfuscationConfig = {
      tp: { minPercent: -0.2, maxPercent: 0.2 },
    };
    const result = applyTradeObfuscation(baseOrder, config);
    expect(result.takeProfits).toHaveLength(3);
    // random 0 -> factor 0.998, 0.5 -> 1, 1 -> 1.002
    expect(result.takeProfits[0]).toBeCloseTo(50898, 0);
    expect(result.takeProfits[1]).toBe(52000);
    expect(result.takeProfits[2]).toBeCloseTo(53106, 0);
    expect(result.stopLoss).toBe(baseOrder.stopLoss);
    randomSpy.mockRestore();
  });

  it('does not mutate the input order', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const config: TradeObfuscationConfig = {
      sl: { minPercent: 0.5, maxPercent: 0.5 },
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
