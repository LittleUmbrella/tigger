import { logger } from '../utils/logger.js';
import type { StrategyStartFn } from './strategyRegistry.js';

/**
 * No polling — template for a custom strategy. Use `ctx.initiateTrade(order, signalId)` to open
 * the same `Trade` rows as channel initiators.
 */
export const startNoopStrategy: StrategyStartFn = async (ctx) => {
  logger.info('noop strategy started', { channel: ctx.channel, strategyName: ctx.strategyName });
  return async () => {
    logger.info('noop strategy stopped', { channel: ctx.channel });
  };
};
