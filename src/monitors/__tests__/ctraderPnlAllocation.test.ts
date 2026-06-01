import { describe, expect, it } from 'vitest';
import { allocateCtraderPositionPnlAmongSiblings } from '../ctraderPnlAllocation.js';

describe('allocateCtraderPositionPnlAmongSiblings', () => {
  const leg = (id: number, positionId: string, quantity: number) => ({
    id,
    position_id: positionId,
    quantity,
  });

  it('returns full PnL when leg is the only sibling on that position', () => {
    const siblings = [
      leg(1, '3896198', 0.06),
      leg(2, '3896202', 0.06),
    ];
    expect(allocateCtraderPositionPnlAmongSiblings(siblings[0]!, siblings, -78.06)).toBe(-78.06);
  });

  it('splits PnL by quantity when two legs share position_id (netting case)', () => {
    const siblings = [
      leg(1432, '3896198', 0.06),
      leg(1433, '3896202', 0.06),
      leg(1435, '3896198', 0.06),
    ];
    const a = allocateCtraderPositionPnlAmongSiblings(siblings[0]!, siblings, -78.06);
    const b = allocateCtraderPositionPnlAmongSiblings(siblings[2]!, siblings, -78.06);
    expect(a).toBeCloseTo(-39.03, 2);
    expect(b).toBeCloseTo(-39.03, 2);
    expect((a ?? 0) + (b ?? 0)).toBeCloseTo(-78.06, 2);
  });

  it('passes through undefined PnL', () => {
    const siblings = [leg(1, 'p1', 0.1), leg(2, 'p1', 0.1)];
    expect(allocateCtraderPositionPnlAmongSiblings(siblings[0]!, siblings, undefined)).toBeUndefined();
  });

  it('splits evenly when quantities are missing', () => {
    const siblings = [
      { id: 1, position_id: 'p1', quantity: undefined },
      { id: 2, position_id: 'p1', quantity: undefined },
    ];
    expect(allocateCtraderPositionPnlAmongSiblings(siblings[0]!, siblings, -90)).toBe(-45);
  });

  it('does not split when position_id is absent', () => {
    const siblings = [
      { id: 1, position_id: undefined, quantity: 0.06 },
      { id: 2, position_id: undefined, quantity: 0.06 },
    ];
    expect(allocateCtraderPositionPnlAmongSiblings(siblings[0]!, siblings, -50)).toBe(-50);
  });
});
