/**
 * cTrader MARKET_RANGE: slippage cap relative to a boundary take-profit level, aligned with
 * `maxSkippablePastTPs` (same index: 0 = TP1, 1 = TP2, …).
 *
 * Manual: confirm on your cTrader demo that Spotware applies slippage one-sided as intended
 * (vs symmetric band around baseSlippagePrice); adjust initiator math if fills disagree.
 */

/**
 * Resolved TP array index for the range boundary (clamps to last TP if requested index is too high).
 */
export function getRangeBoundaryTpIndex(
  maxSkippablePastTPs: number | undefined,
  takeProfitsLength: number
): number {
  if (takeProfitsLength <= 0) {
    return 0;
  }
  const raw = maxSkippablePastTPs ?? 0;
  return Math.max(0, Math.min(raw, takeProfitsLength - 1));
}

/**
 * TP price that caps/floors the MARKET_RANGE band. Index matches channel `maxSkippablePastTPs`:
 * unset or 0 → TP1 (`takeProfits[0]`), 1 → TP2, 2 → TP3, etc.
 */
export function getRangeBoundaryTpPrice(
  takeProfits: number[],
  maxSkippablePastTPs?: number
): number | undefined {
  if (takeProfits.length === 0) {
    return undefined;
  }
  const index = getRangeBoundaryTpIndex(maxSkippablePastTPs, takeProfits.length);
  return takeProfits[index];
}

export interface ComputeSlippagePointsForBoundaryTpParams {
  signalType: 'long' | 'short';
  currentPrice: number;
  boundaryTp: number;
  /** Symbol pip/tick size (price units per point). Must be positive. */
  pipSize: number;
}

/**
 * Maps price room from current quote to the boundary TP into slippageInPoints for MARKET_RANGE.
 * Returns undefined if there is no positive room (price already past boundary).
 */
export function computeSlippagePointsForBoundaryTp(
  params: ComputeSlippagePointsForBoundaryTpParams
): { slippageInPoints: number } | undefined {
  const { signalType, currentPrice: cp, boundaryTp, pipSize } = params;
  if (pipSize <= 0 || !Number.isFinite(cp) || !Number.isFinite(boundaryTp)) {
    return undefined;
  }

  let delta: number;
  if (signalType === 'long') {
    delta = boundaryTp - cp;
  } else {
    delta = cp - boundaryTp;
  }

  if (delta <= 0) {
    return undefined;
  }

  const raw = Math.round(delta / pipSize);
  const slippageInPoints = Math.max(1, raw);
  return { slippageInPoints };
}

/**
 * True when there is no positive price room to the boundary TP (same as
 * `computeSlippagePointsForBoundaryTp` returning undefined). Order must not be placed:
 * long: currentPrice >= boundaryTp; short: currentPrice <= boundaryTp.
 */
export function hasNoRoomToBoundaryTpForMarketRange(
  signalType: 'long' | 'short',
  currentPrice: number,
  boundaryTp: number
): boolean {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(boundaryTp)) {
    return true;
  }
  if (signalType === 'long') {
    return currentPrice >= boundaryTp;
  }
  return currentPrice <= boundaryTp;
}
