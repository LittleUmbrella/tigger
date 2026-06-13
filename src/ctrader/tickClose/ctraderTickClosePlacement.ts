import type { CTraderClient } from '../../clients/ctraderClient.js';
import type { Trade } from '../../db/schema.js';
import { protobufLongToNumber } from '../../utils/protobufLong.js';
import { buildWatchFromTrade } from './hydrateTickTpWatches.js';
import type { TickTpWatch } from './types.js';

export type TickClosePlacementParams = {
  ctraderClient: CTraderClient;
  tradeId: number;
  channel: string;
  messageId: string;
  accountName: string;
  symbol: string;
  positionId: string;
  direction: 'long' | 'short';
  roundedStopLoss?: number;
  tpPrices: number[];
  totalVolumeLots: number;
  volumeStep?: number;
  minOrderVolume?: number;
  maxOrderVolume?: number;
  decimalPrecision: number;
};

export type TickClosePlacementResult = {
  watch: TickTpWatch | null;
};

const isFinitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export const placeTickClosePosition = async (
  params: TickClosePlacementParams
): Promise<TickClosePlacementResult> => {
  const lastTp = params.tpPrices[params.tpPrices.length - 1];
  const modifyPayload: { positionId: string; stopLoss?: number; takeProfit?: number } = {
    positionId: params.positionId,
  };

  if (isFinitePositive(params.roundedStopLoss)) {
    modifyPayload.stopLoss = params.roundedStopLoss;
  }
  if (isFinitePositive(lastTp)) {
    modifyPayload.takeProfit = lastTp;
  }

  if (modifyPayload.stopLoss != null || modifyPayload.takeProfit != null) {
    await params.ctraderClient.modifyPosition(modifyPayload);
  }

  if (params.tpPrices.length <= 1) {
    return { watch: null };
  }

  const symbolInfo = await params.ctraderClient.getSymbolInfo(params.symbol);
  const symbolId = protobufLongToNumber(symbolInfo?.symbolId);
  if (symbolId == null || !Number.isFinite(symbolId)) {
    throw new Error(`Cannot create tick-close watch: missing symbolId for ${params.symbol}`);
  }

  const trade = {
    id: params.tradeId,
    position_id: params.positionId,
    channel: params.channel,
    message_id: params.messageId,
    account_name: params.accountName,
    trading_pair: params.symbol,
    direction: params.direction,
    take_profits: JSON.stringify(params.tpPrices),
  } as Trade;

  const watch = buildWatchFromTrade({
    trade,
    symbolId,
    totalVolumeLots: params.totalVolumeLots,
    filledTpIndices: new Set<number>(),
    volumeStep: params.volumeStep,
    minVolume: params.minOrderVolume,
    maxVolume: params.maxOrderVolume,
    decimalPrecision: params.decimalPrecision,
  });

  return { watch };
};
