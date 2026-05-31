import { Order } from '../db/schema.js';

/** Prefer filled entry, then pending with quantity, over duplicate zero-qty rows. */
export const selectCanonicalEntryOrder = (orders: Order[]): Order | undefined => {
  const entries = orders.filter((o) => o.order_type === 'entry');
  if (entries.length === 0) return undefined;
  return (
    entries.find((o) => o.status === 'filled' && o.filled_at != null) ??
    entries.find((o) => o.status === 'pending' && (o.quantity ?? 0) > 0) ??
    entries.find((o) => o.status === 'pending') ??
    entries[0]
  );
};

/** Prefer stop-loss row with quantity (covers remaining position after TPs). */
export const selectCanonicalStopLossOrder = (orders: Order[]): Order | undefined => {
  const stopLossOrders = orders.filter((o) => o.order_type === 'stop_loss');
  if (stopLossOrders.length === 0) return undefined;
  return (
    stopLossOrders.find((o) => (o.quantity ?? 0) > 0) ??
    stopLossOrders.find((o) => o.status === 'pending') ??
    stopLossOrders[0]
  );
};

export const computeDirectionalPnL = (
  isLong: boolean,
  entryFillPrice: number,
  exitPrice: number,
  quantity: number
): number => {
  if (quantity <= 0) return 0;
  const priceDiff = isLong ? exitPrice - entryFillPrice : entryFillPrice - exitPrice;
  return priceDiff * quantity;
};
