import { logger } from '../utils/logger.js';
import { DatabaseManager } from '../db/schema.js';
import { RestClientV5 } from 'bybit-api';
import { CTraderClient } from '../clients/ctraderClient.js';
import { ParsedOrder } from '../types/order.js';

/**
 * Context passed to every long-running strategy. Call `initiateTrade` with a `ParsedOrder` to run the same
 * initiator + exchange path as signal messages (creates `Trade` rows, orders, monitors).
 */
export type StrategyContext = {
  /** Registry key, e.g. `bybit_ticker`. */
  strategyName: string;
  /** Channel id from config — must match initiator + monitor routing. */
  channel: string;
  db: DatabaseManager;
  isSimulation: boolean;
  isRunning: () => boolean;
  /** From `channel.strategyOptions` in config. */
  options: Record<string, unknown> | undefined;
  getBybitClient: (accountName?: string) => RestClientV5 | undefined;
  getCTraderClient: (accountName?: string) => Promise<CTraderClient | undefined>;
  /**
   * Places the order through the channel’s registered initiator (Bybit, cTrader, etc.). `signalId` must be
   * unique per signal (used in the audit message_id). Creates DB trades like Telegram-driven signals.
   */
  initiateTrade: (order: ParsedOrder, signalId: string) => Promise<void>;
};

export type StrategyStopFn = () => Promise<void>;
export type StrategyStartFn = (ctx: StrategyContext) => Promise<StrategyStopFn>;

const registry = new Map<string, StrategyStartFn>();

export const registerStrategy = (name: string, start: StrategyStartFn): void => {
  registry.set(name, start);
  logger.info('Strategy registered', { name });
};

export const getStrategy = (name: string): StrategyStartFn | undefined => registry.get(name);

export const getRegisteredStrategyNames = (): string[] => [...registry.keys()];
