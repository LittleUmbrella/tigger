import { ParsedOrder } from '../types/order.js';
import { logger } from './logger.js';

/** Reject CMP parse when SL/TP and cmpRef differ by more than this ratio (catches dropped-digit typos). */
export const CMP_REFERENCE_MAX_PRICE_RATIO = 10;

export const priceRatioExceedsSanity = (
  a: number,
  b: number,
  maxRatio: number = CMP_REFERENCE_MAX_PRICE_RATIO
): boolean => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return true;
  const ratio = a >= b ? a / b : b / a;
  return ratio > maxRatio;
};

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
  context?: { channel?: string; symbol?: string; messageId?: string; message?: string }
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
 * Validate CMP-style signals using the message's CMP reference price (entry omitted on ParsedOrder).
 */
export const validateCmpSignalPrices = (
  signalType: 'long' | 'short',
  cmpRef: number,
  stopLoss: number | undefined,
  takeProfits: number[] | undefined,
  context?: { channel?: string; symbol?: string; messageId?: string; message?: string }
): boolean => {
  if (!Number.isFinite(cmpRef) || cmpRef <= 0) {
    return false;
  }

  if (!validateTradePrices(signalType, cmpRef, stopLoss, takeProfits, context)) {
    return false;
  }

  const errors: string[] = [];
  if (stopLoss && stopLoss > 0 && priceRatioExceedsSanity(cmpRef, stopLoss)) {
    errors.push(
      `Stop loss (${stopLoss}) is implausible vs CMP reference (${cmpRef}); ratio exceeds ${CMP_REFERENCE_MAX_PRICE_RATIO}x`
    );
  }
  if (takeProfits && takeProfits.length > 0) {
    takeProfits.forEach((tp, index) => {
      if (priceRatioExceedsSanity(cmpRef, tp)) {
        errors.push(
          `Take profit ${index + 1} (${tp}) is implausible vs CMP reference (${cmpRef}); ratio exceeds ${CMP_REFERENCE_MAX_PRICE_RATIO}x`
        );
      }
    });
  }

  if (errors.length > 0) {
    logger.error('CMP signal validation failed: price sanity check', {
      ...context,
      signalType,
      cmpRef,
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
  context?: { channel?: string; messageId?: string; message?: string }
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

