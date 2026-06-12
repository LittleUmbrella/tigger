import { describe, it, expect } from 'vitest';
import { applyTradeTolerance, resolveObfuscatedStopLossAbsolute } from '../tradeTolerance.js';
import type { ParsedOrder } from '../../types/order.js';
import type { TradeToleranceConfig } from '../../types/config.js';

describe('applyTradeTolerance', () => {
  const baseOrder: ParsedOrder = {
    tradingPair: 'BTCUSDT',
    leverage: 20,
    entryPrice: 50000,
    stopLoss: 49000,
    takeProfits: [51000, 52000, 53000],
    signalType: 'long',
  };

  it('returns order unchanged when no tolerance config', () => {
    const config: TradeToleranceConfig = {};
    const result = applyTradeTolerance(baseOrder, config);
    expect(result).toEqual(baseOrder);
  });

  it('applies sl tolerance toward worse price for long trades', () => {
    const config: TradeToleranceConfig = {
      sl: 1,
    };
    const result = applyTradeTolerance(baseOrder, config);
    expect(result.stopLoss).toBe(48510); // 49000 * (1 - 0.01)
    expect(result.entryPrice).toBe(baseOrder.entryPrice);
    expect(result.takeProfits).toEqual(baseOrder.takeProfits);
  });

  it('applies sl tolerance toward worse price for short trades', () => {
    const shortOrder: ParsedOrder = {
      ...baseOrder,
      signalType: 'short',
      stopLoss: 51000,
    };
    const config: TradeToleranceConfig = {
      sl: 1,
    };
    const result = applyTradeTolerance(shortOrder, config);
    expect(result.stopLoss).toBeCloseTo(51510, 0); // 51000 * (1 + 0.01)
  });

  it('resolveObfuscatedStopLossAbsolute applies sl tolerance from signal SL', () => {
    const sl = resolveObfuscatedStopLossAbsolute(4580, 'short', { sl: 1 });
    expect(sl).toBeCloseTo(4625.8, 1); // 4580 * 1.01
  });

  it('resolveObfuscatedStopLossAbsolute returns signal SL when no sl config', () => {
    expect(resolveObfuscatedStopLossAbsolute(4580, 'short', { tp: 0.02 })).toBe(4580);
  });

  it('treats negative sl offset as absolute value', () => {
    const config: TradeToleranceConfig = {
      sl: -0.5,
    };
    const result = applyTradeTolerance(baseOrder, config);
    expect(result.stopLoss).toBeCloseTo(48755, 0); // 49000 * (1 - 0.005)
  });

  it('applies entry tolerance toward worse fill for long trades', () => {
    const config: TradeToleranceConfig = {
      entry: 0.5,
    };
    const result = applyTradeTolerance(baseOrder, config);
    expect(result.entryPrice).toBeCloseTo(50250, 0); // 50000 * (1 + 0.005)
    expect(result.stopLoss).toBe(baseOrder.stopLoss);
  });

  it('applies entry tolerance toward worse fill for short trades', () => {
    const shortOrder: ParsedOrder = {
      ...baseOrder,
      signalType: 'short',
    };
    const config: TradeToleranceConfig = {
      entry: 0.5,
    };
    const result = applyTradeTolerance(shortOrder, config);
    expect(result.entryPrice).toBeCloseTo(49750, 0); // 50000 * (1 - 0.005)
  });

  it('treats negative entry offset as absolute value', () => {
    const config: TradeToleranceConfig = {
      entry: -0.5,
    };
    const result = applyTradeTolerance(baseOrder, config);
    expect(result.entryPrice).toBeCloseTo(50250, 0); // 50000 * (1 + 0.005)
  });

  it('applies tp tolerance in worse direction for long trades', () => {
    const config: TradeToleranceConfig = {
      tp: 0.2,
    };
    const result = applyTradeTolerance(baseOrder, config);
    expect(result.takeProfits).toHaveLength(3);
    expect(result.takeProfits[0]).toBeCloseTo(50898, 0);
    expect(result.takeProfits[1]).toBeCloseTo(51896, 0);
    expect(result.takeProfits[2]).toBeCloseTo(52894, 0);
    expect(result.stopLoss).toBe(baseOrder.stopLoss);
  });

  it('applies tp tolerance in worse direction for short trades', () => {
    const shortOrder: ParsedOrder = {
      ...baseOrder,
      signalType: 'short',
    };
    const config: TradeToleranceConfig = {
      tp: 0.2,
    };
    const result = applyTradeTolerance(shortOrder, config);
    expect(result.takeProfits).toHaveLength(3);
    expect(result.takeProfits[0]).toBeCloseTo(51102, 0);
    expect(result.takeProfits[1]).toBeCloseTo(52104, 0);
    expect(result.takeProfits[2]).toBeCloseTo(53106, 0);
  });

  it('treats negative tp offset as absolute value', () => {
    const config: TradeToleranceConfig = {
      tp: -0.2,
    };
    const result = applyTradeTolerance(baseOrder, config);
    expect(result.takeProfits[0]).toBeCloseTo(50898, 0);
  });

  it('does not mutate the input order', () => {
    const config: TradeToleranceConfig = {
      entry: 0.5,
    };
    const original = { ...baseOrder };
    applyTradeTolerance(baseOrder, config);
    expect(baseOrder).toEqual(original);
  });

  it('handles optional entryPrice and entryTargets', () => {
    const orderNoEntry: ParsedOrder = {
      ...baseOrder,
      entryPrice: undefined,
      entryTargets: [49900, 50100],
    };
    const config: TradeToleranceConfig = {
      entry: 0.5,
    };
    const result = applyTradeTolerance(orderNoEntry, config);
    expect(result.entryPrice).toBeUndefined();
    expect(result.entryTargets).toHaveLength(2);
    expect(result.entryTargets![0]).toBeCloseTo(50149.5, 0); // 49900 * (1 + 0.005)
    expect(result.entryTargets![1]).toBeCloseTo(50350.5, 0); // 50100 * (1 + 0.005)
  });
});
