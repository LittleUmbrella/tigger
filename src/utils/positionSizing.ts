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
 * Get quantity precision based on risk amount in asset's base currency: 
 * 2 decimal places lower (more precise) than the position of the first significant digit
 * 
 * Examples:
 * - Risk 100 USDT, BTC at 100,000: risk in BTC = 0.001, first sig at position 3 -> precision = 5
 * - Risk 50 USDT, ETH at 3,000: risk in ETH = 0.0167, first sig at position 2 -> precision = 4
 * - Risk 10 USDT, token at 0.05: risk in token = 200, first sig in integer -> precision = 2
 * 
 * @param riskAmountInAsset - Risk amount in the asset's base currency (positionSize / entryPrice)
 * @returns Quantity precision (number of decimal places)
 */
export const getQuantityPrecisionFromRiskAmount = (riskAmountInAsset: number): number => {
  if (!isFinite(riskAmountInAsset) || riskAmountInAsset <= 0) return 2;
  
  const riskStr = riskAmountInAsset.toString();
  
  // Handle scientific notation (e.g., 1.23e-5)
  if (riskStr.includes('e') || riskStr.includes('E')) {
    const num = parseFloat(riskStr);
    if (num < 1) {
      // For numbers < 1, find first significant digit position
      const decimalStr = num.toFixed(20).split('.')[1];
      let firstSigPos = 0;
      for (let i = 0; i < decimalStr.length; i++) {
        if (decimalStr[i] !== '0') {
          firstSigPos = i + 1; // Position (1-indexed for decimal places)
          break;
        }
      }
      // "2 decimal places lower" means more precision: add 2
      return firstSigPos + 2;
    } else {
      // For numbers >= 1, use default precision
      return 2;
    }
  }
  
  // Handle normal decimal notation
  if (riskStr.includes('.')) {
    const [integerPart, decimalPart] = riskStr.split('.');
    
    // If integer part is non-zero, first significant digit is in integer part
    if (integerPart && parseInt(integerPart) > 0) {
      return 2; // Default to 2 decimal places for risk amounts >= 1 asset
    }
    
    // Find first non-zero digit in decimal part
    let firstSigPos = 0;
    for (let i = 0; i < decimalPart.length; i++) {
      if (decimalPart[i] !== '0') {
        firstSigPos = i + 1; // Position (1-indexed for decimal places)
        break;
      }
    }
    
    // "2 decimal places lower" means more precision: add 2 to the position
    return firstSigPos + 2;
  }
  
  // No decimal point (integer) - risk amount is >= 1 asset
  return 2; // Default to 2 decimal places
};

/**
 * Round price to exchange tick size/precision
 * 
 * @param price - Price to round
 * @param pricePrecision - Decimal precision for price (from exchange symbol info)
 * @param tickSize - Optional tick size (if provided, rounds to nearest tick)
 * @returns Rounded price respecting exchange precision
 */
export const roundPrice = (
  price: number,
  pricePrecision?: number,
  tickSize?: number
): number => {
  if (!isFinite(price)) return price;
  
  // If tick size is provided, round to nearest tick
  if (tickSize !== undefined && tickSize > 0) {
    return Math.round(price / tickSize) * tickSize;
  }
  
  // Otherwise, round to specified decimal precision
  const precision = pricePrecision !== undefined ? pricePrecision : getDecimalPrecision(price);
  const multiplier = Math.pow(10, precision);
  return Math.round(price * multiplier) / multiplier;
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
 * @returns Quantity rounded down to appropriate precision (using floor to ensure valid order size)
 */
export const calculateQuantity = (
  positionSize: number,
  entryPrice: number,
  decimalPrecision: number
): number => {
  const rawQuantity = positionSize / entryPrice;
  const multiplier = Math.pow(10, decimalPrecision);
  const roundedQuantity = Math.floor(rawQuantity * multiplier) / multiplier;
  
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

/**
 * Round quantity to exchange precision
 * 
 * @param quantity - Quantity to round
 * @param decimalPrecision - Decimal precision for quantity (from exchange symbol info)
 * @param roundUp - If true, round up (ceil), otherwise round down (floor). Default: false
 * @returns Rounded quantity respecting exchange precision
 */
export const roundQuantity = (
  quantity: number,
  decimalPrecision: number,
  roundUp: boolean = false
): number => {
  if (!isFinite(quantity)) return quantity;
  
  const multiplier = Math.pow(10, decimalPrecision);
  if (roundUp) {
    return Math.ceil(quantity * multiplier) / multiplier;
  } else {
    return Math.floor(quantity * multiplier) / multiplier;
  }
};

