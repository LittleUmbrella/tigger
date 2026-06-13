import { describe, expect, it, vi } from 'vitest';
import type { CTraderClient } from '../../../clients/ctraderClient.js';
import {
  placeTickClosePosition,
  type TickClosePlacementParams,
} from '../ctraderTickClosePlacement.js';

const buildParams = (
  overrides: Partial<TickClosePlacementParams> = {}
): {
  params: TickClosePlacementParams;
  modifyPosition: ReturnType<typeof vi.fn>;
  getSymbolInfo: ReturnType<typeof vi.fn>;
  placeLimitOrder: ReturnType<typeof vi.fn>;
} => {
  const modifyPosition = vi.fn(async () => undefined);
  const getSymbolInfo = vi.fn(async () => ({ symbolId: { low: 42, high: 0 } }));
  const placeLimitOrder = vi.fn(async () => undefined);

  const ctraderClient = {
    modifyPosition,
    getSymbolInfo,
    placeLimitOrder,
  } as unknown as CTraderClient;

  return {
    params: {
      ctraderClient,
      tradeId: 101,
      channel: 'alerts',
      messageId: 'msg-101',
      accountName: 'ctrader_live_tick_close',
      symbol: 'XAUUSD',
      positionId: '9001',
      direction: 'long',
      roundedStopLoss: 2480,
      tpPrices: [2510, 2520, 2530],
      totalVolumeLots: 0.03,
      volumeStep: 0.01,
      minOrderVolume: 0.01,
      maxOrderVolume: 1,
      decimalPrecision: 2,
      ...overrides,
    },
    modifyPosition,
    getSymbolInfo,
    placeLimitOrder,
  };
};

describe('placeTickClosePosition', () => {
  it('amends position SL + last TP and builds a watch for multi-TP signals', async () => {
    const { params, modifyPosition, getSymbolInfo, placeLimitOrder } = buildParams();

    const result = await placeTickClosePosition(params);

    expect(modifyPosition).toHaveBeenCalledWith({
      positionId: '9001',
      stopLoss: 2480,
      takeProfit: 2530,
    });
    expect(getSymbolInfo).toHaveBeenCalledWith('XAUUSD');
    expect(placeLimitOrder).not.toHaveBeenCalled();
    expect(result.watch).not.toBeNull();
    expect(result.watch?.symbolId).toBe(42);
    expect(result.watch?.levels.map((level) => level.index)).toEqual([1, 2]);
  });

  it('returns null watch for single TP and skips symbol info fetch', async () => {
    const { params, modifyPosition, getSymbolInfo, placeLimitOrder } = buildParams({
      roundedStopLoss: undefined,
      tpPrices: [2530],
    });

    const result = await placeTickClosePosition(params);

    expect(modifyPosition).toHaveBeenCalledWith({
      positionId: '9001',
      takeProfit: 2530,
    });
    expect(getSymbolInfo).not.toHaveBeenCalled();
    expect(placeLimitOrder).not.toHaveBeenCalled();
    expect(result).toEqual({ watch: null });
  });
});
