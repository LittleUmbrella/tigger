import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parser options passed to parser functions
 */
export interface ParserOptions {
  entryPriceStrategy?: 'worst' | 'average';
}

/**
 * Parser function type - takes message content and optional options, returns parsed order or null
 */
export type ParserFunction = (content: string, options?: ParserOptions) => ParsedOrder | null;

/**
 * Registry of parsers by name
 */
const parserRegistry = new Map<string, ParserFunction>();
const loadedChannelParsers = new Set<string>();

/**
 * Register a parser function with a name
 */
export const registerParser = (name: string, parser: ParserFunction): void => {
  parserRegistry.set(name, parser);
  logger.info('Parser registered', { name });
};

/**
 * Get a parser by name
 * If not found in registry, tries to load from channel-specific parsers
 */
export const getParser = async (name: string): Promise<ParserFunction | undefined> => {
  // Check registry first
  if (parserRegistry.has(name)) {
    return parserRegistry.get(name);
  }

  // Try to load from channel parsers
  await loadChannelParserIfExists(name);
  
  return parserRegistry.get(name);
};

/**
 * Synchronous version for backward compatibility
 * Note: This won't load channel parsers dynamically
 */
export const getParserSync = (name: string): ParserFunction | undefined => {
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

/**
 * Load a parser from channel-specific directory
 */
async function loadChannelParserIfExists(parserName: string): Promise<void> {
  if (loadedChannelParsers.has(parserName)) {
    return; // Already tried to load
  }

  loadedChannelParsers.add(parserName);

  try {
    const channelsDir = path.join(__dirname, 'channels');
    
    if (!await fs.pathExists(channelsDir)) {
      return;
    }

    // Look for parser in any channel subdirectory
    const channelDirs = await fs.readdir(channelsDir);
    
    for (const channelDir of channelDirs) {
      const channelPath = path.join(channelsDir, channelDir);
      const stat = await fs.stat(channelPath);
      
      if (!stat.isDirectory()) continue;

      // Check for index.ts or direct parser file
      const indexPath = path.join(channelPath, 'index.ts');
      const parserPath = path.join(channelPath, `${parserName}.ts`);

      if (await fs.pathExists(indexPath)) {
        try {
          const module = await import(`./channels/${channelDir}/index.js`);
          if (module[parserName]) {
            registerParser(parserName, module[parserName]);
            logger.info('Loaded channel parser from index', { parserName, channel: channelDir });
            return;
          }
        } catch (error) {
          logger.debug('Failed to load from index', { parserName, channel: channelDir });
        }
      }

      if (await fs.pathExists(parserPath)) {
        try {
          const module = await import(`./channels/${channelDir}/${parserName}.js`);
          const parser = module.default || module[parserName] || module[`${channelDir}Parser`];
          if (parser) {
            registerParser(parserName, parser);
            logger.info('Loaded channel parser', { parserName, channel: channelDir });
            return;
          }
        } catch (error) {
          logger.debug('Failed to load parser file', { parserName, channel: channelDir });
        }
      }
    }
  } catch (error) {
    logger.debug('Error loading channel parser', {
      parserName,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Preload all channel parsers
 */
export async function loadAllChannelParsers(): Promise<void> {
  try {
    const channelsDir = path.join(__dirname, 'channels');
    
    if (!await fs.pathExists(channelsDir)) {
      return;
    }

    const channelDirs = await fs.readdir(channelsDir);
    
    for (const channelDir of channelDirs) {
      const channelPath = path.join(channelsDir, channelDir);
      const stat = await fs.stat(channelPath);
      
      if (!stat.isDirectory()) continue;

      const indexPath = path.join(channelPath, 'index.ts');
      
      if (await fs.pathExists(indexPath)) {
        try {
          const module = await import(`./channels/${channelDir}/index.js`);
          // Register all exported parsers
          for (const [name, parser] of Object.entries(module)) {
            if (typeof parser === 'function') {
              registerParser(name, parser as ParserFunction);
              logger.info('Preloaded channel parser', { parserName: name, channel: channelDir });
            }
          }
        } catch (error) {
          logger.debug('Failed to preload channel parsers', {
            channel: channelDir,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  } catch (error) {
    logger.debug('Error preloading channel parsers', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

