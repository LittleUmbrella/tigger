/**
 * Persistent Bybit API Response Cache
 * 
 * Caches Bybit API responses to disk to avoid re-fetching during re-runs.
 * Implements LRU eviction with a 4GB size limit.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { logger } from './logger.js';

const MAX_CACHE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB in bytes
const MAX_MANIFEST_SIZE = 50 * 1024 * 1024; // 50MB max manifest size (safety limit)
const MAX_INDIVIDUAL_FILE_SIZE = 100 * 1024 * 1024; // 100MB max per cached file
const CACHE_DIR = join(process.cwd(), 'data', 'bybit-cache');
const MANIFEST_FILE = join(CACHE_DIR, 'manifest.json');

interface CacheEntry {
  key: string;
  filePath: string;
  size: number;
  lastAccessed: number;
  createdAt: number;
  endpoint: string;
  params: Record<string, any>;
}

interface CacheManifest {
  entries: Record<string, CacheEntry>;
  totalSize: number;
  version: number;
}

// In-memory manifest for fast access
let manifest: CacheManifest | null = null;

/**
 * Generate a cache key from endpoint and parameters
 */
function generateCacheKey(endpoint: string, params: Record<string, any>): string {
  // Normalize parameters by sorting keys and stringifying
  const normalizedParams = JSON.stringify(
    Object.keys(params)
      .sort()
      .reduce((acc, key) => {
        acc[key] = params[key];
        return acc;
      }, {} as Record<string, any>)
  );
  
  // Create hash of endpoint + params
  const hash = createHash('sha256')
    .update(`${endpoint}:${normalizedParams}`)
    .digest('hex');
  
  return hash;
}

/**
 * Get file path for a cache entry
 */
function getCacheFilePath(key: string): string {
  // Use first 2 chars of hash as subdirectory to avoid too many files in one dir
  const subdir = key.substring(0, 2);
  return join(CACHE_DIR, subdir, `${key}.json`);
}

/**
 * Load manifest from disk
 */
async function loadManifest(): Promise<CacheManifest> {
  if (manifest) {
    return manifest;
  }

  try {
    // Check file size before loading to avoid memory issues
    const stats = await fs.stat(MANIFEST_FILE);
    if (stats.size > MAX_MANIFEST_SIZE) {
      logger.warn('Manifest file too large, clearing cache', {
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        maxSizeMB: (MAX_MANIFEST_SIZE / (1024 * 1024)).toFixed(2)
      });
      // Clear corrupted/invalid manifest
      manifest = {
        entries: {},
        totalSize: 0,
        version: 1
      };
      return manifest;
    }
    
    const data = await fs.readFile(MANIFEST_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    
    manifest = {
      entries: parsed.entries || {},
      totalSize: parsed.totalSize || 0,
      version: parsed.version || 1
    };
    
    const entryCount = Object.keys(manifest.entries).length;
    logger.debug('Cache manifest loaded', {
      entryCount,
      totalSize: manifest.totalSize,
      totalSizeMB: (manifest.totalSize / (1024 * 1024)).toFixed(2),
      manifestSizeKB: (stats.size / 1024).toFixed(2)
    });
    
    // Warn if manifest has too many entries (could indicate issues)
    if (entryCount > 100000) {
      logger.warn('Cache manifest has very large number of entries', {
        entryCount,
        suggestion: 'Consider clearing cache if experiencing memory issues'
      });
    }
  } catch (error) {
    // Manifest doesn't exist or is corrupted, start fresh
    manifest = {
      entries: {},
      totalSize: 0,
      version: 1
    };
    logger.debug('Starting with empty cache manifest', {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return manifest;
}

/**
 * Save manifest to disk
 */
async function saveManifest(): Promise<void> {
  if (!manifest) {
    return;
  }

  try {
    // Ensure cache directory exists
    await fs.mkdir(CACHE_DIR, { recursive: true });
    
    const data = {
      entries: manifest.entries,
      totalSize: manifest.totalSize,
      version: manifest.version
    };
    
    await fs.writeFile(MANIFEST_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    logger.error('Failed to save cache manifest', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Evict least recently used entries until we're under the size limit
 */
async function evictLRU(targetSize: number): Promise<void> {
  if (!manifest) {
    return;
  }

  const entries = Object.values(manifest.entries);
  
  // Sort by lastAccessed (oldest first)
  entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
  
  let freedSize = 0;
  const toRemove: string[] = [];
  
  for (const entry of entries) {
    if (manifest.totalSize - freedSize <= targetSize) {
      break;
    }
    
    toRemove.push(entry.key);
    freedSize += entry.size;
  }
  
  // Remove entries
  for (const key of toRemove) {
    const entry = manifest.entries[key];
    if (entry) {
      try {
        await fs.unlink(entry.filePath).catch(() => {
          // File might not exist, that's okay
        });
        delete manifest.entries[key];
        manifest.totalSize -= entry.size;
        
        logger.debug('Evicted cache entry', {
          key: entry.key.substring(0, 8),
          endpoint: entry.endpoint,
          size: entry.size,
          lastAccessed: new Date(entry.lastAccessed).toISOString()
        });
      } catch (error) {
        logger.warn('Failed to evict cache entry', {
          key: entry.key.substring(0, 8),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  
  if (toRemove.length > 0) {
    logger.info('Cache eviction completed', {
      evictedCount: toRemove.length,
      freedSizeMB: (freedSize / (1024 * 1024)).toFixed(2),
      remainingSizeMB: (manifest.totalSize / (1024 * 1024)).toFixed(2)
    });
    await saveManifest();
  }
}

/**
 * Get cached response if it exists
 */
export async function getCachedResponse(
  endpoint: string,
  params: Record<string, any>
): Promise<any | null> {
  const manifest = await loadManifest();
  const key = generateCacheKey(endpoint, params);
  const entry = manifest.entries[key];
  
  if (!entry) {
    return null;
  }
  
  try {
    // Check if file exists
    await fs.access(entry.filePath);
    
    // Check file size before reading to avoid memory issues
    const stats = await fs.stat(entry.filePath);
    if (stats.size > MAX_INDIVIDUAL_FILE_SIZE) {
      logger.warn('Cached file too large, skipping', {
        endpoint,
        key: key.substring(0, 8),
        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        maxSizeMB: (MAX_INDIVIDUAL_FILE_SIZE / (1024 * 1024)).toFixed(2)
      });
      // Remove invalid entry from manifest
      delete manifest.entries[key];
      manifest.totalSize -= entry.size;
      await saveManifest();
      return null;
    }
    
    // Read cached response
    const data = await fs.readFile(entry.filePath, 'utf-8');
    const response = JSON.parse(data);
    
    // Update last accessed time
    entry.lastAccessed = Date.now();
    await saveManifest();
    
    logger.debug('Cache hit', {
      endpoint,
      key: key.substring(0, 8),
      size: entry.size
    });
    
    return response;
  } catch (error) {
    // File doesn't exist or is corrupted, remove from manifest
    logger.debug('Cache entry file missing or corrupted, removing from manifest', {
      key: key.substring(0, 8),
      endpoint,
      error: error instanceof Error ? error.message : String(error)
    });
    
    delete manifest.entries[key];
    manifest.totalSize -= entry.size;
    await saveManifest();
    
    return null;
  }
}

/**
 * Store response in cache
 */
export async function setCachedResponse(
  endpoint: string,
  params: Record<string, any>,
  response: any
): Promise<void> {
  const manifest = await loadManifest();
  const key = generateCacheKey(endpoint, params);
  const filePath = getCacheFilePath(key);
  
  try {
    // Serialize response
    const data = JSON.stringify(response);
    const size = Buffer.byteLength(data, 'utf-8');
    
    // Skip caching if individual file is too large
    if (size > MAX_INDIVIDUAL_FILE_SIZE) {
      logger.warn('Response too large to cache, skipping', {
        endpoint,
        key: key.substring(0, 8),
        sizeMB: (size / (1024 * 1024)).toFixed(2),
        maxSizeMB: (MAX_INDIVIDUAL_FILE_SIZE / (1024 * 1024)).toFixed(2)
      });
      return;
    }
    
    // Check if we need to evict entries
    const newTotalSize = manifest.totalSize - (manifest.entries[key]?.size || 0) + size;
    if (newTotalSize > MAX_CACHE_SIZE) {
      const targetSize = MAX_CACHE_SIZE * 0.9; // Evict to 90% of max to avoid frequent evictions
      await evictLRU(targetSize);
      
      // Recalculate after eviction
      const updatedTotalSize = manifest.totalSize - (manifest.entries[key]?.size || 0) + size;
      if (updatedTotalSize > MAX_CACHE_SIZE) {
        logger.warn('Cache entry too large, skipping cache', {
          endpoint,
          key: key.substring(0, 8),
          sizeMB: (size / (1024 * 1024)).toFixed(2),
          currentTotalSizeMB: (manifest.totalSize / (1024 * 1024)).toFixed(2)
        });
        return;
      }
    }
    
    // Ensure subdirectory exists
    await fs.mkdir(dirname(filePath), { recursive: true });
    
    // Write cache file
    await fs.writeFile(filePath, data, 'utf-8');
    
    // Update manifest
    const existingEntry = manifest.entries[key];
    if (existingEntry) {
      manifest.totalSize -= existingEntry.size;
    }
    
    const entry: CacheEntry = {
      key,
      filePath,
      size,
      lastAccessed: Date.now(),
      createdAt: existingEntry?.createdAt || Date.now(),
      endpoint,
      params
    };
    
    manifest.entries[key] = entry;
    manifest.totalSize += size;
    
    await saveManifest();
    
    logger.debug('Cached response', {
      endpoint,
      key: key.substring(0, 8),
      sizeMB: (size / (1024 * 1024)).toFixed(2),
      totalSizeMB: (manifest.totalSize / (1024 * 1024)).toFixed(2)
    });
  } catch (error) {
    logger.warn('Failed to cache response', {
      endpoint,
      key: key.substring(0, 8),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Clear all cached responses
 */
export async function clearCache(): Promise<void> {
  const currentManifest = await loadManifest();
  
  logger.info('Clearing cache', {
    entryCount: Object.keys(currentManifest.entries).length,
    totalSizeMB: (currentManifest.totalSize / (1024 * 1024)).toFixed(2)
  });
  
  // Delete all cache files
  for (const entry of Object.values(currentManifest.entries)) {
    try {
      await fs.unlink(entry.filePath).catch(() => {
        // File might not exist, that's okay
      });
    } catch (error) {
      // Continue even if deletion fails
    }
  }
  
  // Reset manifest
  manifest = {
    entries: {},
    totalSize: 0,
    version: 1
  };
  
  await saveManifest();
  
  logger.info('Cache cleared');
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  entryCount: number;
  totalSize: number;
  totalSizeMB: string;
}> {
  const manifest = await loadManifest();
  
  return {
    entryCount: Object.keys(manifest.entries).length,
    totalSize: manifest.totalSize,
    totalSizeMB: (manifest.totalSize / (1024 * 1024)).toFixed(2)
  };
}

