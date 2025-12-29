/**
 * Position Sizing Utilities
 * 
 * Shared utilities for calculating position sizes based on risk management.
 * Used by both live trading and evaluation/simulation modes.
 */

/**
 * Get decimal precision from a price value
 */
export const getDecimalPrecision = (price: number): number => {
  if (!isFinite(price)) return 2;
  const priceStr = price.toString();
  if (priceStr.includes('.')) {
    return priceStr.split('.')[1].length;
  }
  return 0;
};

/**
 * Calculate position size based on risk percentage, accounting for leverage
 * 
 * @param balance - Account balance
 * @param riskPercentage - Risk percentage (e.g., 1 for 1%)
 * @param entryPrice - Entry price for the trade
 * @param stopLoss - Stop loss price
 * @param leverage - Leverage multiplier (e.g., 20 for 20x)
 * @param baseLeverage - Base/default leverage used as confidence indicator (optional)
 * @returns Position size in quote currency (e.g., USDT)
 */
export const calculatePositionSize = (
  balance: number,
  riskPercentage: number,
  entryPrice: number,
  stopLoss: number,
  leverage: number,
  baseLeverage?: number
): number => {
  // Use baseLeverage as default if leverage is not specified (leverage === 0 or undefined)
  const effectiveLeverage = leverage > 0 ? leverage : (baseLeverage || 1);
  
  // Adjust risk percentage based on leverage comparison with baseLeverage
  let adjustedRiskPercentage = riskPercentage;
  
  if (baseLeverage !== undefined && baseLeverage > 0) {
    // Calculate risk multiplier based on leverage ratio
    // If specified leverage is lower than base, reduce risk proportionally
    // If specified leverage is higher, increase risk proportionally
    const leverageRatio = effectiveLeverage / baseLeverage;
    
    // Apply risk multiplier, but limit to:
    // - Maximum: 2x the risk (double)
    // - Minimum: 0.25x the risk (quarter)
    const riskMultiplier = Math.max(0.25, Math.min(2.0, leverageRatio));
    
    adjustedRiskPercentage = riskPercentage * riskMultiplier;
  }
  
  // Calculate risk amount using adjusted risk percentage
  const riskAmount = balance * (adjustedRiskPercentage / 100);
  
  // Calculate price difference between entry and stop loss
  const priceDiff = Math.abs(entryPrice - stopLoss);
  
  // With leverage, the risk per unit is amplified
  // For example, with 20x leverage, a 5% price move results in 100% loss
  const riskPerUnit = (priceDiff / entryPrice) * effectiveLeverage;
  
  // Position size = risk amount / risk per unit
  // This ensures that if stop loss is hit, loss equals risk amount
  const positionSize = riskAmount / riskPerUnit;
  
  return positionSize;
};

/**
 * Calculate quantity from position size and entry price, rounded to appropriate precision
 * 
 * @param positionSize - Position size in quote currency
 * @param entryPrice - Entry price
 * @param decimalPrecision - Decimal precision for rounding (should come from exchange symbol info)
 * @returns Quantity rounded to appropriate precision
 */
export const calculateQuantity = (
  positionSize: number,
  entryPrice: number,
  decimalPrecision: number
): number => {
  const rawQuantity = positionSize / entryPrice;
  const roundedQuantity = Math.floor(rawQuantity * Math.pow(10, decimalPrecision)) / Math.pow(10, decimalPrecision);
  
  // If quantity rounds to 0 but we have a valid position size, log a warning
  // This shouldn't happen if precision is correctly set from exchange
  if (roundedQuantity === 0 && rawQuantity > 0) {
    // Try with higher precision up to 8 decimal places as fallback
    for (let p = decimalPrecision + 1; p <= 8; p++) {
      const qty = Math.floor(rawQuantity * Math.pow(10, p)) / Math.pow(10, p);
      if (qty > 0) {
        return qty;
      }
    }
  }
  
  return roundedQuantity;
};

