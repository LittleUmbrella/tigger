import type { Order, Trade } from '../../db/schema.js';
import {
  distributeQuantityAcrossTPs,
  validateAndRedistributeTPQuantities,
} from '../../utils/positionSizing.js';
import type { TickTpLevel, TickTpWatch } from './types.js';

const TP_SPLIT_OPTIONS = { lastSliceRounding: 'floor' as const };

const parseTpPrices = (rawTakeProfits: string | undefined): number[] => {
  try {
    const parsed = JSON.parse(rawTakeProfits ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
};

export const buildIntermediateTpLevels = (
  tpPrices: number[],
  totalVolumeLots: number,
  volumeStep: number | undefined,
  minVolume: number | undefined,
  maxVolume: number | undefined,
  decimalPrecision: number,
  filledTpIndices: Set<number>
): TickTpLevel[] => {
  if (tpPrices.length <= 1) return [];

  const distributedQuantities = distributeQuantityAcrossTPs(
    totalVolumeLots,
    tpPrices.length,
    decimalPrecision,
    TP_SPLIT_OPTIONS
  );

  return validateAndRedistributeTPQuantities(
    distributedQuantities,
    tpPrices,
    totalVolumeLots,
    volumeStep,
    minVolume,
    maxVolume,
    decimalPrecision,
    TP_SPLIT_OPTIONS
  )
    .filter((level) => level.index < tpPrices.length)
    .map((level) => ({
      index: level.index,
      price: level.price,
      volumeLots: level.quantity,
      status: filledTpIndices.has(level.index) ? 'filled' : 'pending',
    }));
};

export const buildWatchFromTrade = ({
  trade,
  symbolId,
  totalVolumeLots,
  filledTpIndices,
  volumeStep,
  minVolume,
  maxVolume,
  decimalPrecision,
}: {
  trade: Trade;
  symbolId: number;
  totalVolumeLots: number;
  filledTpIndices: Set<number>;
  volumeStep: number | undefined;
  minVolume: number | undefined;
  maxVolume: number | undefined;
  decimalPrecision: number;
}): TickTpWatch | null => {
  if (!trade.position_id) return null;

  const tpPrices = parseTpPrices(trade.take_profits);
  if (tpPrices.length <= 1) return null;

  const levels = buildIntermediateTpLevels(
    tpPrices,
    totalVolumeLots,
    volumeStep,
    minVolume,
    maxVolume,
    decimalPrecision,
    filledTpIndices
  );

  const filledVolumeLots = levels
    .filter((level) => level.status === 'filled')
    .reduce((sum, level) => sum + level.volumeLots, 0);

  return {
    tradeId: trade.id,
    positionId: String(trade.position_id),
    channel: trade.channel,
    messageId: String(trade.message_id),
    accountName: trade.account_name ?? '',
    symbol: trade.trading_pair.replace('/', ''),
    symbolId,
    direction: trade.direction === 'short' ? 'short' : 'long',
    remainingVolumeLots: Math.max(0, totalVolumeLots - filledVolumeLots),
    levels,
    closingInFlight: false,
  };
};

export const filledTpIndicesFromOrders = (orders: Order[]): Set<number> => {
  const filledTpIndices = new Set<number>();
  for (const order of orders) {
    if (
      order.order_type === 'take_profit' &&
      order.status === 'filled' &&
      order.tp_index != null
    ) {
      filledTpIndices.add(order.tp_index);
    }
  }
  return filledTpIndices;
};
