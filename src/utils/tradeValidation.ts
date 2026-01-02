import { ParsedOrder } from '../types/order.js';
import { logger } from './logger.js';

/**
 * Validate trade prices based on position type
 * For long: all TPs must be > entry, stop loss must be < entry
 * For short: all TPs must be < entry, stop loss must be > entry
 * 
 * @param signalType - 'long' or 'short'
 * @param entryPrice - Entry price (required for validation)
 * @param stopLoss - Stop loss price (optional)
 * @param takeProfits - Array of take profit prices (optional)
 * @param context - Context for logging (channel, symbol, messageId, etc.)
 * @returns true if valid, false if invalid
 */
export const validateTradePrices = (
  signalType: 'long' | 'short',
  entryPrice: number,
  stopLoss: number | undefined,
  takeProfits: number[] | undefined,
  context?: { channel?: string; symbol?: string; messageId?: number; message?: string }
): boolean => {
  const errors: string[] = [];

  // Validate stop loss
  if (stopLoss && stopLoss > 0) {
    if (signalType === 'long') {
      if (stopLoss >= entryPrice) {
        errors.push(`Stop loss (${stopLoss}) must be lower than entry price (${entryPrice}) for long position`);
      }
    } else {
      // short
      if (stopLoss <= entryPrice) {
        errors.push(`Stop loss (${stopLoss}) must be higher than entry price (${entryPrice}) for short position`);
      }
    }
  }

  // Validate take profits
  if (takeProfits && takeProfits.length > 0) {
    takeProfits.forEach((tp, index) => {
      if (signalType === 'long') {
        if (tp <= entryPrice) {
          errors.push(`Take profit ${index + 1} (${tp}) must be greater than entry price (${entryPrice}) for long position`);
        }
      } else {
        // short
        if (tp >= entryPrice) {
          errors.push(`Take profit ${index + 1} (${tp}) must be less than entry price (${entryPrice}) for short position`);
        }
      }
    });
  }

  // If validation fails, log and return false
  if (errors.length > 0) {
    logger.error('Trade validation failed: Invalid price relationships', {
      ...context,
      signalType,
      entryPrice,
      stopLoss,
      takeProfits,
      errors
    });
    return false;
  }

  return true;
};

/**
 * Validate a ParsedOrder (only if entryPrice is provided)
 * Returns true if valid or if entryPrice is missing (market order - validation happens later)
 */
export const validateParsedOrder = (
  order: ParsedOrder,
  context?: { channel?: string; messageId?: number; message?: string }
): boolean => {
  // If entry price is not provided, skip validation (will be validated later in initiator)
  if (!order.entryPrice || order.entryPrice <= 0) {
    return true;
  }

  const symbol = order.tradingPair.split('/')[0];
  return validateTradePrices(
    order.signalType,
    order.entryPrice,
    order.stopLoss,
    order.takeProfits,
    { ...context, symbol }
  );
};

