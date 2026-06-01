import type { Trade } from '../db/schema.js';

export type CtraderPnlAllocationLeg = Pick<Trade, 'id' | 'position_id' | 'quantity'>;

/**
 * When multiple DB legs share one cTrader position_id, deal-based close checks return
 * the full position PnL for each leg. Split proportionally by quantity across siblings
 * on the same position so summed leg PnL matches the exchange position once.
 */
export const allocateCtraderPositionPnlAmongSiblings = (
  trade: CtraderPnlAllocationLeg,
  siblings: CtraderPnlAllocationLeg[],
  positionPnl: number | undefined
): number | undefined => {
  if (positionPnl === undefined || !Number.isFinite(positionPnl)) {
    return positionPnl;
  }

  const positionId = trade.position_id;
  if (positionId == null || positionId === '') {
    return positionPnl;
  }

  const sharing = siblings.filter(
    (s) => s.position_id != null && String(s.position_id) === String(positionId)
  );
  if (sharing.length <= 1) {
    return positionPnl;
  }

  const totalQty = sharing.reduce((sum, s) => {
    const q = s.quantity;
    return sum + (q != null && Number.isFinite(q) && q > 0 ? q : 0);
  }, 0);

  if (totalQty <= 0) {
    return positionPnl / sharing.length;
  }

  const legQty = trade.quantity;
  const weight =
    legQty != null && Number.isFinite(legQty) && legQty > 0
      ? legQty / totalQty
      : 1 / sharing.length;

  return positionPnl * weight;
};
