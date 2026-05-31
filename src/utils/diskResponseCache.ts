/**
 * Persistent API response cache on disk (LRU eviction, size limits).
 * Used by Bybit and cTrader evaluation price fetches.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { logger } from './logger.js';

const MAX_CACHE_SIZE = 10 * 1024 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 50 * 1024 * 1024;
const MAX_INDIVIDUAL_FILE_SIZE = 100 * 1024 * 1024;

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

export interface DiskResponseCache {
  getCachedResponse: (endpoint: string, params: Record<string, any>) => Promise<any | null>;
  setCachedResponse: (endpoint: string, params: Record<string, any>, response: any) => Promise<void>;
  clearCache: () => Promise<void>;
  getCacheStats: () => Promise<{ entryCount: number; totalSize: number; totalSizeMB: string }>;
}

const generateCacheKey = (endpoint: string, params: Record<string, any>): string => {
  const normalizedParams = JSON.stringify(
    Object.keys(params)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = params[key];
          return acc;
        },
        {} as Record<string, any>
      )
  );
  return createHash('sha256').update(`${endpoint}:${normalizedParams}`).digest('hex');
};

export const createDiskResponseCache = (cacheName: string): DiskResponseCache => {
  const cacheDir = join(process.cwd(), 'data', cacheName);
  const manifestFile = join(cacheDir, 'manifest.json');
  let manifest: CacheManifest | null = null;

  const getCacheFilePath = (key: string): string => {
    const subdir = key.substring(0, 2);
    return join(cacheDir, subdir, `${key}.json`);
  };

  const loadManifest = async (): Promise<CacheManifest> => {
    if (manifest) return manifest;

    try {
      const stats = await fs.stat(manifestFile);
      if (stats.size > MAX_MANIFEST_SIZE) {
        logger.warn('Manifest file too large, clearing cache', {
          cacheName,
          sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
        });
        manifest = { entries: {}, totalSize: 0, version: 1 };
        return manifest;
      }

      const data = await fs.readFile(manifestFile, 'utf-8');
      const parsed = JSON.parse(data);
      manifest = {
        entries: parsed.entries || {},
        totalSize: parsed.totalSize || 0,
        version: parsed.version || 1,
      };
    } catch (error) {
      manifest = { entries: {}, totalSize: 0, version: 1 };
      logger.debug('Starting with empty cache manifest', {
        cacheName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return manifest;
  };

  const saveManifest = async (): Promise<void> => {
    if (!manifest) return;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        manifestFile,
        JSON.stringify(
          { entries: manifest.entries, totalSize: manifest.totalSize, version: manifest.version },
          null,
          2
        ),
        'utf-8'
      );
    } catch (error) {
      logger.error('Failed to save cache manifest', {
        cacheName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const evictLRU = async (targetSize: number): Promise<void> => {
    if (!manifest) return;

    const entries = Object.values(manifest.entries).sort((a, b) => a.lastAccessed - b.lastAccessed);
    let freedSize = 0;
    const toRemove: string[] = [];

    for (const entry of entries) {
      if (manifest.totalSize - freedSize <= targetSize) break;
      toRemove.push(entry.key);
      freedSize += entry.size;
    }

    for (const key of toRemove) {
      const entry = manifest.entries[key];
      if (!entry) continue;
      await fs.unlink(entry.filePath).catch(() => undefined);
      delete manifest.entries[key];
      manifest.totalSize -= entry.size;
    }

    if (toRemove.length > 0) {
      logger.info('Cache eviction completed', {
        cacheName,
        evictedCount: toRemove.length,
        freedSizeMB: (freedSize / (1024 * 1024)).toFixed(2),
      });
      await saveManifest();
    }
  };

  const getCachedResponse = async (
    endpoint: string,
    params: Record<string, any>
  ): Promise<any | null> => {
    const loaded = await loadManifest();
    const key = generateCacheKey(endpoint, params);
    const entry = loaded.entries[key];
    if (!entry) return null;

    try {
      await fs.access(entry.filePath);
      const stats = await fs.stat(entry.filePath);
      if (stats.size > MAX_INDIVIDUAL_FILE_SIZE) {
        delete loaded.entries[key];
        loaded.totalSize -= entry.size;
        await saveManifest();
        return null;
      }

      const data = await fs.readFile(entry.filePath, 'utf-8');
      const response = JSON.parse(data);
      entry.lastAccessed = Date.now();
      await saveManifest();

      logger.debug('Cache hit', { cacheName, endpoint, key: key.substring(0, 8) });
      return response;
    } catch (error) {
      delete loaded.entries[key];
      loaded.totalSize -= entry.size;
      await saveManifest();
      logger.debug('Cache entry missing or corrupted', {
        cacheName,
        endpoint,
        key: key.substring(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const setCachedResponse = async (
    endpoint: string,
    params: Record<string, any>,
    response: any
  ): Promise<void> => {
    const loaded = await loadManifest();
    const key = generateCacheKey(endpoint, params);
    const filePath = getCacheFilePath(key);

    try {
      const data = JSON.stringify(response);
      const size = Buffer.byteLength(data, 'utf-8');
      if (size > MAX_INDIVIDUAL_FILE_SIZE) return;

      const newTotalSize = loaded.totalSize - (loaded.entries[key]?.size || 0) + size;
      if (newTotalSize > MAX_CACHE_SIZE) {
        await evictLRU(MAX_CACHE_SIZE * 0.9);
        const updatedTotalSize = loaded.totalSize - (loaded.entries[key]?.size || 0) + size;
        if (updatedTotalSize > MAX_CACHE_SIZE) return;
      }

      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data, 'utf-8');

      const existingEntry = loaded.entries[key];
      if (existingEntry) loaded.totalSize -= existingEntry.size;

      loaded.entries[key] = {
        key,
        filePath,
        size,
        lastAccessed: Date.now(),
        createdAt: existingEntry?.createdAt || Date.now(),
        endpoint,
        params,
      };
      loaded.totalSize += size;
      await saveManifest();

      logger.debug('Cached response', {
        cacheName,
        endpoint,
        key: key.substring(0, 8),
        sizeMB: (size / (1024 * 1024)).toFixed(2),
      });
    } catch (error) {
      logger.warn('Failed to cache response', {
        cacheName,
        endpoint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const clearCache = async (): Promise<void> => {
    const loaded = await loadManifest();
    for (const entry of Object.values(loaded.entries)) {
      await fs.unlink(entry.filePath).catch(() => undefined);
    }
    manifest = { entries: {}, totalSize: 0, version: 1 };
    await saveManifest();
    logger.info('Cache cleared', { cacheName });
  };

  const getCacheStats = async () => {
    const loaded = await loadManifest();
    return {
      entryCount: Object.keys(loaded.entries).length,
      totalSize: loaded.totalSize,
      totalSizeMB: (loaded.totalSize / (1024 * 1024)).toFixed(2),
    };
  };

  return { getCachedResponse, setCachedResponse, clearCache, getCacheStats };
};
