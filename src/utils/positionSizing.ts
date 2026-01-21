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
 * Calculate position size based on risk percentage
 * 
 * Formula:
 * - Risk amount = balance × (riskPercentage / 100)
 * - Quantity = riskAmount / priceDiff
 * - Position size = quantity × entryPrice
 * 
 * Note: Leverage does NOT affect position size calculation. Leverage only affects margin:
 * - Margin = positionSize / leverage
 * 
 * The loss at stop loss is always: quantity × priceDiff, regardless of leverage.
 * 
 * @param balance - Account balance
 * @param riskPercentage - Risk percentage (e.g., 1 for 1%)
 * @param entryPrice - Entry price for the trade
 * @param stopLoss - Stop loss price
 * @param leverage - Leverage multiplier (e.g., 20 for 20x) - used for margin calculation and risk adjustment
 * @param baseLeverage - Base/default leverage used for risk adjustment (optional)
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
  
  // Validate price difference
  if (priceDiff === 0 || !isFinite(priceDiff)) {
    throw new Error(`Invalid price difference: entry=${entryPrice}, stopLoss=${stopLoss}, diff=${priceDiff}`);
  }
  
  // CORRECT FORMULA:
  // The actual loss when stop loss is hit: loss = quantity × priceDiff
  // We want: loss = riskAmount
  // Therefore: quantity = riskAmount / priceDiff
  // Position size (notional) = quantity × entryPrice = (riskAmount / priceDiff) × entryPrice
  // 
  // Note: Leverage does NOT affect the position size calculation directly.
  // Leverage only affects the margin required: margin = positionSize / leverage
  // The loss at stop loss is always: quantity × priceDiff, regardless of leverage.
  const quantity = riskAmount / priceDiff;
  const positionSize = quantity * entryPrice;
  
  // Validate result
  if (!isFinite(positionSize) || positionSize <= 0) {
    throw new Error(`Invalid position size calculated: ${positionSize} (riskAmount=${riskAmount}, priceDiff=${priceDiff}, entryPrice=${entryPrice})`);
  }
  
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

/**
 * Distribute quantity evenly across take profits, rounding up the last TP (max TP) to ensure whole trade quantity is accounted for
 * 
 * @param totalQty - Total quantity to distribute
 * @param numTPs - Number of take profit levels
 * @param decimalPrecision - Decimal precision for quantity rounding
 * @returns Array of quantities, one per TP (last TP rounded up)
 */
export const distributeQuantityAcrossTPs = (
  totalQty: number,
  numTPs: number,
  decimalPrecision: number
): number[] => {
  if (numTPs === 0) return [];
  if (numTPs === 1) return [roundQuantity(totalQty, decimalPrecision, false)];
  
  // Calculate base quantity per TP
  const baseQty = totalQty / numTPs;
  
  // Round down all quantities except the last one
  const roundedQuantities: number[] = [];
  for (let i = 0; i < numTPs - 1; i++) {
    roundedQuantities.push(roundQuantity(baseQty, decimalPrecision, false));
  }
  
  // Calculate remaining quantity for the last TP (max TP)
  const allocatedQty = roundedQuantities.reduce((sum, qty) => sum + qty, 0);
  const remainingQty = totalQty - allocatedQty;
  
  // Round UP the last TP to ensure whole trade quantity is accounted for
  roundedQuantities.push(roundQuantity(remainingQty, decimalPrecision, true));
  
  return roundedQuantities;
};

/**
 * Validates and redistributes TP quantities to handle rounding issues and minimum order requirements
 * 
 * This function:
 * 1. Rounds TP quantities to qtyStep (except the last TP)
 * 2. Identifies TPs that round to zero or below minOrderQty
 * 3. Redistributes skipped quantities to remaining valid TPs
 * 4. Uses minOrderQty as fallback for TPs that can't be redistributed
 * 5. For the last TP, uses remaining quantity rounded UP to ensure full position coverage
 *    (Bybit will adjust it down to available position when executing due to reduceOnly: true)
 * 6. Validates quantities don't exceed maxOrderQty after redistribution and caps/redistributes if needed
 * 
 * Key feature: Last TP quantity is rounded UP (not down) to ensure no quantity is ever lost.
 * This guarantees the sum of all TP quantities >= position size. Bybit's reduceOnly: true
 * ensures the order only fills up to the available position size, similar to SL with tpslMode='Full'.
 * 
 * @param tpQuantities - Initial distributed TP quantities (before qtyStep rounding)
 * @param tpPrices - Rounded TP prices (must match tpQuantities length)
 * @param positionSize - Total position size (for minOrderQty fallback validation and last TP calculation)
 * @param qtyStep - Quantity step from exchange (if undefined, inferred from decimalPrecision)
 * @param minOrderQty - Minimum order quantity from exchange (0 or undefined means no minimum)
 * @param maxOrderQty - Maximum order quantity from exchange (undefined means no maximum)
 * @param decimalPrecision - Decimal precision for quantity (used if qtyStep is not provided)
 * @returns Array of valid TP orders with { index: number (1-based), price: number, quantity: number }
 */
export const validateAndRedistributeTPQuantities = (
  tpQuantities: number[],
  tpPrices: number[],
  positionSize: number,
  qtyStep: number | undefined,
  minOrderQty: number | undefined,
  maxOrderQty: number | undefined,
  decimalPrecision: number
): Array<{ index: number; price: number; quantity: number }> => {
  if (tpQuantities.length !== tpPrices.length) {
    throw new Error(`TP quantities (${tpQuantities.length}) and prices (${tpPrices.length}) must have the same length`);
  }

  // Round quantities to qtyStep if specified (except the last TP - it will use remaining quantity)
  const effectiveQtyStep = qtyStep !== undefined && qtyStep > 0 ? qtyStep : Math.pow(10, -decimalPrecision);
  let roundedTPQuantities = tpQuantities.map((qty, idx) => {
    // Don't round the last TP yet - it will use remaining quantity
    if (idx === tpQuantities.length - 1) {
      return qty; // Keep original for now
    }
    if (effectiveQtyStep > 0) {
      return Math.floor(qty / effectiveQtyStep) * effectiveQtyStep;
    }
    return qty;
  });

  // Get minimum order quantity (default to 0 if not provided)
  const minQty = minOrderQty !== undefined && minOrderQty > 0 ? minOrderQty : 0;

  // Identify TP orders that round to zero or below minimum (excluding the last TP)
  const skippedTPs: number[] = [];
  for (let i = 0; i < roundedTPQuantities.length - 1; i++) { // Exclude last TP from this check
    const qty = roundedTPQuantities[i];
    if (qty === 0 || (minQty > 0 && qty < minQty)) {
      skippedTPs.push(i);
    }
  }

  // If any TPs were skipped, redistribute their quantity to remaining TPs (excluding the last TP)
  if (skippedTPs.length > 0 && skippedTPs.length < roundedTPQuantities.length - 1) {
    const skippedQuantity = skippedTPs.reduce((sum, idx) => sum + tpQuantities[idx], 0);
    const validTPIndices = roundedTPQuantities
      .slice(0, -1) // Exclude last TP
      .map((qty, idx) => ({ qty, idx }))
      .filter(({ qty }) => qty > 0 && (minQty === 0 || qty >= minQty))
      .map(({ idx }) => idx);

    if (validTPIndices.length > 0 && skippedQuantity > 0) {
      // Redistribute skipped quantity evenly across valid TPs
      const redistributionPerTP = skippedQuantity / validTPIndices.length;
      for (const idx of validTPIndices) {
        const newQty = roundedTPQuantities[idx] + redistributionPerTP;
        // Round again after redistribution
        if (effectiveQtyStep > 0) {
          roundedTPQuantities[idx] = Math.floor(newQty / effectiveQtyStep) * effectiveQtyStep;
        } else {
          roundedTPQuantities[idx] = newQty;
        }
      }
    }
  }

  // Build list of valid TP orders (skip zero quantities, but use minOrderQty as fallback if needed)
  const validTPOrders: Array<{ index: number; price: number; quantity: number }> = [];
  const lastTPIndex = tpPrices.length - 1;
  
  for (let i = 0; i < tpPrices.length; i++) {
    const isLastTP = i === lastTPIndex;
    let qty = roundedTPQuantities[i];
    
    // For non-last TPs, handle zero or below minimum quantities
    if (!isLastTP) {
      if (qty === 0 || (minQty > 0 && qty < minQty)) {
        if (minQty > 0 && positionSize >= minQty) {
          // Use minimum order quantity as fallback - exchange will adjust to available position if needed
          qty = minQty;
        } else {
          // Can't use minOrderQty fallback - skip this TP
          continue;
        }
      }
      
      // Add non-last TP if quantity is valid
      if (qty > 0) {
        validTPOrders.push({
          index: i + 1, // 1-based index
          price: tpPrices[i],
          quantity: qty
        });
      }
    }
  }
  
  // Handle the last TP separately - use remaining quantity to ensure full position coverage
  // This ensures the total always adds up to the full position size (exchange will determine final size)
  if (lastTPIndex >= 0) {
    // Calculate sum of all valid TP orders already added
    const allocatedQty = validTPOrders.reduce((sum, tp) => sum + tp.quantity, 0);
    // Use remaining quantity - exchange will determine final size (similar to SL with tpslMode='Full')
    let remainingQty = positionSize - allocatedQty;
    
    // Round the last TP quantity UP (not down) to ensure we never lose quantity
    // Bybit will adjust it down to available position when executing due to reduceOnly: true
    let roundedRemainingQty = remainingQty;
    if (effectiveQtyStep > 0 && remainingQty > 0) {
      // Round UP to next qtyStep to ensure we capture all remaining quantity
      roundedRemainingQty = Math.ceil(remainingQty / effectiveQtyStep) * effectiveQtyStep;
    }
    
    // Ensure last TP quantity is at least minQty if specified
    if (minQty > 0 && roundedRemainingQty < minQty && positionSize >= minQty) {
      roundedRemainingQty = minQty;
    }
    
    // Check if last TP quantity is valid
    const isLastTPValid = roundedRemainingQty > 0 && (minQty === 0 || roundedRemainingQty >= minQty);
    
    if (isLastTPValid) {
      // Last TP quantity is valid - add it
      // Note: Quantity may be slightly larger than remaining position, but Bybit will adjust
      // it down to available position when executing due to reduceOnly: true (similar to SL with tpslMode='Full')
      validTPOrders.push({
        index: lastTPIndex + 1, // 1-based index
        price: tpPrices[lastTPIndex],
        quantity: roundedRemainingQty
      });
    } else if (remainingQty > 0 && validTPOrders.length > 0) {
      // Last TP quantity is invalid (below minQty or rounded to 0) but we have remaining quantity
      // Redistribute remaining quantity across existing valid TPs to ensure full position coverage
      const redistributionPerTP = remainingQty / validTPOrders.length;
      
      for (let i = 0; i < validTPOrders.length; i++) {
        const newQty = validTPOrders[i].quantity + redistributionPerTP;
        // Round again after redistribution
        if (effectiveQtyStep > 0) {
          validTPOrders[i].quantity = Math.floor(newQty / effectiveQtyStep) * effectiveQtyStep;
        } else {
          validTPOrders[i].quantity = newQty;
        }
      }
      
      // Recalculate remaining quantity after redistribution (may have rounding differences)
      const finalAllocatedQty = validTPOrders.reduce((sum, tp) => sum + tp.quantity, 0);
      const finalRemainingQty = positionSize - finalAllocatedQty;
      
      // If there's still a small remaining quantity after redistribution, add it to the last valid TP
      // (this handles rounding differences and ensures full position coverage)
      if (finalRemainingQty > 0 && validTPOrders.length > 0) {
        const lastValidTP = validTPOrders[validTPOrders.length - 1];
        const newLastQty = lastValidTP.quantity + finalRemainingQty;
        // Round one more time
        if (effectiveQtyStep > 0) {
          lastValidTP.quantity = Math.floor(newLastQty / effectiveQtyStep) * effectiveQtyStep;
        } else {
          lastValidTP.quantity = newLastQty;
        }
      }
    } else if (remainingQty > 0 && validTPOrders.length === 0) {
      // No valid TPs exist, but we have remaining quantity - use minQty if available
      if (minQty > 0 && positionSize >= minQty) {
        validTPOrders.push({
          index: lastTPIndex + 1,
          price: tpPrices[lastTPIndex],
          quantity: minQty // Exchange will adjust to available position
        });
      }
    } else if (remainingQty > 0 && roundedRemainingQty === 0 && validTPOrders.length > 0) {
      // Remaining quantity rounded to 0, but we still have unallocated quantity due to rounding
      // Add the unrounded remainder to the last valid TP to ensure full coverage
      const lastValidTP = validTPOrders[validTPOrders.length - 1];
      const newLastQty = lastValidTP.quantity + remainingQty;
      if (effectiveQtyStep > 0) {
        lastValidTP.quantity = Math.floor(newLastQty / effectiveQtyStep) * effectiveQtyStep;
      } else {
        lastValidTP.quantity = newLastQty;
      }
    }
    // If remainingQty <= 0, all quantity has been allocated - nothing to do
  }

  // Validate quantities don't exceed maxOrderQty after redistribution
  // If any TP quantity exceeds maxOrderQty, cap it and redistribute the excess
  if (maxOrderQty !== undefined && maxOrderQty > 0 && validTPOrders.length > 0) {
    const effectiveQtyStep = qtyStep !== undefined && qtyStep > 0 ? qtyStep : Math.pow(10, -decimalPrecision);
    let excessQty = 0;
    let hasExcess = false;

    // First pass: cap quantities that exceed maxOrderQty and collect excess
    for (const tpOrder of validTPOrders) {
      if (tpOrder.quantity > maxOrderQty) {
        hasExcess = true;
        const cappedQty = Math.floor(maxOrderQty / effectiveQtyStep) * effectiveQtyStep;
        excessQty += tpOrder.quantity - cappedQty;
        tpOrder.quantity = cappedQty;
      }
    }

    // If we have excess quantity, redistribute it across TPs that are below maxOrderQty
    if (hasExcess && excessQty > 0) {
      // Iteratively redistribute excess until all is distributed or no more TPs can accept it
      let remainingExcess = excessQty;
      let iterations = 0;
      const maxIterations = 10; // Prevent infinite loops
      
      while (remainingExcess > 0 && iterations < maxIterations) {
        iterations++;
        const tpsBelowMax = validTPOrders.filter(tp => tp.quantity < maxOrderQty);
        
        if (tpsBelowMax.length === 0) {
          // No TPs can accept more quantity - stop redistribution
          break;
        }
        
        // Redistribute remaining excess evenly across TPs below max
        const redistributionPerTP = remainingExcess / tpsBelowMax.length;
        let newExcess = 0;
        
        for (const tpOrder of tpsBelowMax) {
          let newQty = tpOrder.quantity + redistributionPerTP;
          
          // Cap at maxOrderQty if redistribution would exceed it
          if (newQty > maxOrderQty) {
            const cappedQty = Math.floor(maxOrderQty / effectiveQtyStep) * effectiveQtyStep;
            newExcess += newQty - cappedQty; // Track new excess from capping
            newQty = cappedQty;
          }
          
          // Round to qtyStep
          if (effectiveQtyStep > 0) {
            tpOrder.quantity = Math.floor(newQty / effectiveQtyStep) * effectiveQtyStep;
          } else {
            tpOrder.quantity = newQty;
          }
        }
        
        // Update remaining excess (may have increased due to rounding/capping)
        const allocatedQty = validTPOrders.reduce((sum, tp) => sum + tp.quantity, 0);
        remainingExcess = positionSize - allocatedQty;
        
        // If excess is very small (less than qtyStep), stop to avoid infinite loops
        if (remainingExcess < effectiveQtyStep) {
          break;
        }
      }
      
      // If there's still a small remaining excess after redistribution (due to rounding),
      // add it to the last TP (but cap at maxOrderQty)
      if (remainingExcess > 0 && validTPOrders.length > 0) {
        const lastTP = validTPOrders[validTPOrders.length - 1];
        let newLastQty = lastTP.quantity + remainingExcess;
        
        // Cap at maxOrderQty
        if (newLastQty > maxOrderQty) {
          newLastQty = Math.floor(maxOrderQty / effectiveQtyStep) * effectiveQtyStep;
        }
        
        // Round to qtyStep
        if (effectiveQtyStep > 0) {
          lastTP.quantity = Math.floor(newLastQty / effectiveQtyStep) * effectiveQtyStep;
        } else {
          lastTP.quantity = newLastQty;
        }
      }
    }
  }

  return validTPOrders;
};

