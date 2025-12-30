import { DatabaseManager, Message, Trade } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { RestClientV5 } from '../utils/bybitClient.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';

/**
 * Parsed management command from a message
 */
export interface ParsedManagementCommand {
  type: 'close_all_longs' | 'close_all_shorts' | 'close_all_trades' | 'close_position' | 'close_percentage' | 
        'update_entry' | 'update_stop_loss' | 'update_take_profits';
  tradingPair?: string; // Optional: specific trading pair to close
  percentage?: number; // Optional: percentage of position to close (0-100)
  moveStopLossToEntry?: boolean; // Optional: move stop loss to entry after partial close
  newOrder?: any; // For update commands: the new parsed order
  trade?: any; // For update commands: the existing trade to update
}

/**
 * Context passed to manager functions
 */
export interface ManagerContext {
  channel: string;
  message: Message;
  command: ParsedManagementCommand;
  db: DatabaseManager;
  isSimulation: boolean;
  priceProvider?: HistoricalPriceProvider;
  bybitClient?: RestClientV5; // Deprecated: use getBybitClient instead
  getBybitClient?: (accountName?: string) => RestClientV5 | undefined; // Function to get client by account name
}

/**
 * Manager function type - executes a management command
 */
export type ManagerFunction = (context: ManagerContext) => Promise<void>;

/**
 * Registry of managers by command type
 */
const managerRegistry = new Map<string, ManagerFunction>();

/**
 * Register a manager function with a command type
 */
export const registerManager = (commandType: ParsedManagementCommand['type'], manager: ManagerFunction): void => {
  managerRegistry.set(commandType, manager);
  logger.info('Manager registered', { commandType });
};

/**
 * Get a manager by command type
 */
export const getManager = (commandType: ParsedManagementCommand['type']): ManagerFunction | undefined => {
  return managerRegistry.get(commandType);
};

/**
 * Check if a manager exists
 */
export const hasManager = (commandType: ParsedManagementCommand['type']): boolean => {
  return managerRegistry.has(commandType);
};

/**
 * Get all registered manager command types
 */
export const getRegisteredManagers = (): string[] => {
  return Array.from(managerRegistry.keys());
};

