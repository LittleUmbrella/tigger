import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';

/**
 * Parser function type - takes message content and returns parsed order or null
 */
export type ParserFunction = (content: string) => ParsedOrder | null;

/**
 * Registry of parsers by name
 */
const parserRegistry = new Map<string, ParserFunction>();

/**
 * Register a parser function with a name
 */
export const registerParser = (name: string, parser: ParserFunction): void => {
  parserRegistry.set(name, parser);
  logger.info('Parser registered', { name });
};

/**
 * Get a parser by name
 */
export const getParser = (name: string): ParserFunction | undefined => {
  return parserRegistry.get(name);
};

/**
 * Check if a parser exists
 */
export const hasParser = (name: string): boolean => {
  return parserRegistry.has(name);
};

/**
 * Get all registered parser names
 */
export const getRegisteredParsers = (): string[] => {
  return Array.from(parserRegistry.keys());
};

