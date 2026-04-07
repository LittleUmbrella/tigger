import { InitiatorConfig, AccountConfig, AccountFilter } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { DatabaseManager, Message } from '../db/schema.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { logger } from '../utils/logger.js';

import { CustomPropFirmConfig } from '../types/config.js';

/**
 * Context passed to initiator functions
 */
export interface InitiatorContext {
  channel: string;
  riskPercentage: number;
  entryTimeoutMinutes: number;
  message: Message;
  order: ParsedOrder;
  db: DatabaseManager;
  isSimulation: boolean;
  priceProvider?: HistoricalPriceProvider;
  config: InitiatorConfig; // Full initiator config for initiator-specific settings
  accounts?: AccountConfig[]; // Available accounts configuration
  accountFilters?: AccountFilter[]; // Channel-level account filtering rules
  currentBalance?: number; // Current account balance at the time of trade creation (for evaluation mode)
  propFirms?: (string | CustomPropFirmConfig)[]; // Prop firm names or custom configurations to validate trades against
  forcePlaceTrade?: boolean; // If true, bypass existing-trade check (for manual retries when DB has stale data)
  slAdjustmentTolerancePercent?: number; // Per-channel: when price past SL, max overshoot % to allow proportional SL adjustment (0 = reject)
  /** cTrader only: When true, convert market orders to limit at current price. When false, use market with relative SL/TP (default: true) */
  useLimitOrderForEntry?: boolean;
  /** cTrader market orders only: max number of TPs to skip when price has already moved past them (0 = reject, default) */
  maxSkippablePastTPs?: number;
  /** cTrader: MARKET_RANGE entry; boundary TP index follows maxSkippablePastTPs */
  useMarketRangeForEntry?: boolean;
}

/**
 * Initiator function type - initiates a trade based on parsed order data
 */
export type InitiatorFunction = (context: InitiatorContext) => Promise<void>;

/**
 * Registry of initiators by name
 */
const initiatorRegistry = new Map<string, InitiatorFunction>();

/**
 * Register an initiator function with a name
 */
export const registerInitiator = (name: string, initiator: InitiatorFunction): void => {
  initiatorRegistry.set(name, initiator);
  logger.info('Initiator registered', { name });
};

/**
 * Get an initiator by name
 */
export const getInitiator = (name: string): InitiatorFunction | undefined => {
  return initiatorRegistry.get(name);
};

/**
 * Check if an initiator exists
 */
export const hasInitiator = (name: string): boolean => {
  return initiatorRegistry.has(name);
};

/**
 * Get all registered initiator names
 */
export const getRegisteredInitiators = (): string[] => {
  return Array.from(initiatorRegistry.keys());
};

