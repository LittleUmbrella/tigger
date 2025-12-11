import { InitiatorConfig, AccountConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { DatabaseManager, Message } from '../db/schema.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { logger } from '../utils/logger.js';

/**
 * Context passed to initiator functions
 */
export interface InitiatorContext {
  channel: string;
  riskPercentage: number;
  entryTimeoutDays: number;
  message: Message;
  order: ParsedOrder;
  db: DatabaseManager;
  isSimulation: boolean;
  priceProvider?: HistoricalPriceProvider;
  config: InitiatorConfig; // Full initiator config for initiator-specific settings
  accounts?: AccountConfig[]; // Available accounts configuration
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

