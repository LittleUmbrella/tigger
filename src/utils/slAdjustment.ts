/**
 * Proportional stop loss adjustment when current price has already passed message SL.
 *
 * When price is past SL by at most tolerancePercent of the original entry-to-SL distance,
 * we adjust the SL proportionally: new SL keeps the same point distance from current price
 * as the original SL was from message entry.
 *
 * @param messageEntry - Signal's entry price
 * @param messageSl - Signal's stop loss price
 * @param currentPrice - Current market price
 * @param signalType - 'long' or 'short'
 * @param tolerancePercent - Max overshoot (as % of original risk) to allow. 0 = reject
 * @param roundPriceFn - Function to round the result to exchange precision
 * @returns { adjusted: true, newStopLoss } or { adjusted: false, rejectReason }
 */
export function tryAdjustStopLossWhenPastSL(
  messageEntry: number,
  messageSl: number,
  currentPrice: number,
  signalType: 'long' | 'short',
  tolerancePercent: number,
  roundPriceFn: (p: number) => number
): { adjusted: true; newStopLoss: number } | { adjusted: false; rejectReason: string } {
  const originalRisk = Math.abs(messageEntry - messageSl);
  if (originalRisk <= 0) {
    return { adjusted: false, rejectReason: 'Invalid original risk (entry equals SL)' };
  }

  const isLong = signalType === 'long';
  const pricePastSl = isLong ? currentPrice < messageSl : currentPrice > messageSl;
  if (!pricePastSl) {
    return { adjusted: false, rejectReason: 'Price not past SL (unexpected)' };
  }

  const overshoot = isLong ? messageSl - currentPrice : currentPrice - messageSl;
  const overshootPercent = (overshoot / originalRisk) * 100;

  if (tolerancePercent <= 0 || overshootPercent > tolerancePercent) {
    return {
      adjusted: false,
      rejectReason: overshootPercent > tolerancePercent
        ? `Price past SL by ${overshootPercent.toFixed(1)}% (max ${tolerancePercent}% allowed)`
        : 'SL adjustment disabled (tolerance 0)'
    };
  }

  const newSl = isLong ? currentPrice - originalRisk : currentPrice + originalRisk;
  return { adjusted: true, newStopLoss: roundPriceFn(newSl) };
}
