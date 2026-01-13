/**
 * Deduplication Utilities
 * 
 * Shared utilities for deduplicating arrays, particularly take profit prices.
 */

/**
 * Deduplicates an array of numbers, removing duplicates while preserving order.
 * Uses epsilon-based comparison for floating point equality.
 * 
 * @param numbers - Array of numbers to deduplicate
 * @param signalType - Signal type ('long' or 'short') - determines sort order before deduplication
 * @param epsilon - Tolerance for floating point comparison (default: 0.0001)
 * @returns Deduplicated array, sorted based on signal type
 */
export const deduplicateNumbers = (
  numbers: number[],
  signalType: 'long' | 'short',
  epsilon: number = 0.0001
): number[] => {
  if (numbers.length === 0) return [];

  // Sort first based on signal type
  const sorted = [...numbers];
  if (signalType === 'long') {
    sorted.sort((a, b) => a - b); // Ascending for long
  } else {
    sorted.sort((a, b) => b - a); // Descending for short
  }

  // Deduplicate using epsilon-based comparison
  const deduplicated: number[] = [];
  for (const num of sorted) {
    const isDuplicate = deduplicated.some(existing => Math.abs(existing - num) < epsilon);
    if (!isDuplicate) {
      deduplicated.push(num);
    }
  }

  return deduplicated;
};

/**
 * Deduplicates take profit prices specifically.
 * This is a convenience wrapper around deduplicateNumbers for take profits.
 * 
 * @param takeProfits - Array of take profit prices
 * @param signalType - Signal type ('long' or 'short')
 * @param epsilon - Tolerance for floating point comparison (default: 0.0001)
 * @returns Deduplicated array of take profit prices, sorted appropriately
 */
export const deduplicateTakeProfits = (
  takeProfits: number[],
  signalType: 'long' | 'short',
  epsilon: number = 0.0001
): number[] => {
  return deduplicateNumbers(takeProfits, signalType, epsilon);
};

