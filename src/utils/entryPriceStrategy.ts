/**
 * Calculate entry price from a range based on strategy
 * @param price1 First price in the range
 * @param price2 Second price in the range
 * @param signalType 'long' or 'short'
 * @param strategy 'worst' (default) or 'average'
 * @returns Calculated entry price
 */
export function calculateEntryPrice(
  price1: number,
  price2: number,
  signalType: 'long' | 'short',
  strategy: 'worst' | 'average' = 'worst'
): number {
  if (strategy === 'average') {
    return (price1 + price2) / 2;
  }
  
  // Default to 'worst' strategy
  // For LONG: worst = highest price (entering higher is worse, you pay more)
  // For SHORT: worst = lowest price (entering lower is worse, you sell for less)
  return signalType === 'long' ? Math.max(price1, price2) : Math.min(price1, price2);
}

