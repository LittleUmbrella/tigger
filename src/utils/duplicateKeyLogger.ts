import { logger } from './logger.js';

/**
 * Checks if an error is a duplicate key/UNIQUE constraint violation.
 * Handles both SQLite ("UNIQUE constraint") and PostgreSQL ("duplicate key value violates unique constraint") formats.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes('unique constraint') ||
    message.includes('duplicate key value violates unique constraint') ||
    message.includes('duplicate key')
  );
}

interface DuplicateKeyStats {
  count: number;
  uniqueMessageIds: Set<string>;
  firstSeen: number;
  lastSeen: number;
  channel: string;
}

/**
 * Throttled logger for duplicate key errors.
 * Logs a digest warning periodically instead of logging every single duplicate.
 */
class DuplicateKeyLogger {
  private stats = new Map<string, DuplicateKeyStats>();
  private readonly LOG_INTERVAL_MS = 600000; // Log every 10 minutes
  private readonly MIN_COUNT_THRESHOLD = 100; // Or every 100 duplicates
  private flushInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic flush
    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.LOG_INTERVAL_MS);
  }

  /**
   * Record a duplicate key error and log if threshold is reached.
   * @param channel - The channel where the duplicate occurred
   * @param messageId - Optional message ID to track unique duplicates
   */
  record(channel: string, messageId?: string): void {
    const key = channel;
    const now = Date.now();
    const stats = this.stats.get(key);

    if (stats) {
      stats.count++;
      stats.lastSeen = now;
      if (messageId) {
        stats.uniqueMessageIds.add(String(messageId));
      }
    } else {
      const uniqueMessageIds = new Set<string>();
      if (messageId) {
        uniqueMessageIds.add(String(messageId));
      }
      this.stats.set(key, {
        count: 1,
        uniqueMessageIds,
        firstSeen: now,
        lastSeen: now,
        channel
      });
    }

    const currentStats = this.stats.get(key)!;
    
    // Log if we've hit the count threshold
    if (currentStats.count >= this.MIN_COUNT_THRESHOLD && currentStats.count % this.MIN_COUNT_THRESHOLD === 0) {
      this.logAndReset(key);
    }
  }

  /**
   * Flush all pending stats and log them.
   */
  flush(): void {
    const now = Date.now();
    const keysToLog: string[] = [];

    // Find all channels that have stats older than LOG_INTERVAL_MS
    for (const [key, stats] of this.stats.entries()) {
      if (now - stats.firstSeen >= this.LOG_INTERVAL_MS) {
        keysToLog.push(key);
      }
    }

    // Log and reset each
    for (const key of keysToLog) {
      this.logAndReset(key);
    }
  }

  /**
   * Log stats for a channel and reset its counter.
   */
  private logAndReset(key: string): void {
    const stats = this.stats.get(key);
    if (!stats || stats.count === 0) {
      return;
    }

    const durationSeconds = Math.round((stats.lastSeen - stats.firstSeen) / 1000);
    const uniqueCount = stats.uniqueMessageIds.size;
    logger.warn('Duplicate key errors detected (digest)', {
      channel: stats.channel,
      totalAttempts: stats.count,
      uniqueMessages: uniqueCount,
      durationSeconds,
      ratePerSecond: durationSeconds > 0 ? (stats.count / durationSeconds).toFixed(2) : stats.count
    });

    // Reset counter but keep the entry (in case more come in before next flush)
    stats.count = 0;
    stats.uniqueMessageIds.clear();
    stats.firstSeen = Date.now();
  }

  /**
   * Clean up interval on shutdown.
   */
  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    // Final flush
    this.flush();
  }
}

// Singleton instance
let instance: DuplicateKeyLogger | null = null;

export function getDuplicateKeyLogger(): DuplicateKeyLogger {
  if (!instance) {
    instance = new DuplicateKeyLogger();
  }
  return instance;
}

