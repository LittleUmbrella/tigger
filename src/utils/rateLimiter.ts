/**
 * Rate Limiter
 * 
 * Handles API rate limiting with request tracking and exponential backoff.
 */

import { logger } from './logger.js';

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  retryAfterHeader?: string;
}

interface RequestRecord {
  timestamp: number;
}

export interface RateLimiter {
  waitIfNeeded: () => Promise<void>;
  handleRateLimitError: (retryCount?: number) => Promise<void>;
  setRetryAfter: (seconds: number) => void;
  reset: () => void;
  getCurrentCount: () => number;
}

/**
 * Create a rate limiter that tracks requests and enforces limits
 */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  let requests: RequestRecord[] = [];
  let lastRetryAfter: number = 0;

  const waitIfNeeded = async (): Promise<void> => {
    const now = Date.now();
    
    // Remove old requests outside the window
    requests = requests.filter(
      r => now - r.timestamp < config.windowMs
    );

    // Check if we're at the limit
    if (requests.length >= config.maxRequests) {
      const oldestRequest = requests[0];
      const waitTime = config.windowMs - (now - oldestRequest.timestamp) + 100; // Add 100ms buffer
      
      if (waitTime > 0) {
        logger.debug('Rate limit reached, waiting', {
          maxRequests: config.maxRequests,
          windowMs: config.windowMs,
          waitTimeMs: waitTime,
          currentRequests: requests.length
        });
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Clean up again after waiting
        const newNow = Date.now();
        requests = requests.filter(
          r => newNow - r.timestamp < config.windowMs
        );
      }
    }

    // Record this request
    requests.push({ timestamp: Date.now() });
  };

  const handleRateLimitError = async (retryCount: number = 0): Promise<void> => {
    const maxRetries = 5;
    const baseDelay = 1000; // 1 second base delay
    
    if (retryCount >= maxRetries) {
      throw new Error('Rate limit exceeded - max retries reached');
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = baseDelay * Math.pow(2, retryCount);
    
    // If we have a retry-after header, use that instead
    if (lastRetryAfter > 0) {
      const waitTime = Math.max(lastRetryAfter * 1000, delay);
      logger.warn('Rate limited - waiting based on retry-after header', {
        waitTimeMs: waitTime,
        retryCount
      });
      await new Promise(resolve => setTimeout(resolve, waitTime));
      lastRetryAfter = 0; // Reset after using it
    } else {
      logger.warn('Rate limited - exponential backoff', {
        delayMs: delay,
        retryCount
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  };

  const setRetryAfter = (seconds: number): void => {
    lastRetryAfter = seconds;
  };

  const reset = (): void => {
    requests = [];
    lastRetryAfter = 0;
  };

  const getCurrentCount = (): number => {
    const now = Date.now();
    requests = requests.filter(
      r => now - r.timestamp < config.windowMs
    );
    return requests.length;
  };

  return {
    waitIfNeeded,
    handleRateLimitError,
    setRetryAfter,
    reset,
    getCurrentCount
  };
}

/**
 * Create a rate limiter for Bybit public endpoints
 * Bybit allows 120 requests per minute for public endpoints
 */
export function createBybitPublicRateLimiter(): RateLimiter {
  return createRateLimiter({
    maxRequests: 100, // Conservative limit (120/min = ~2/sec, but we'll use 100/min to be safe)
    windowMs: 60 * 1000 // 1 minute window
  });
}

/**
 * Create a rate limiter for Bybit private endpoints
 * Bybit allows 50 requests per minute for private endpoints
 */
export function createBybitPrivateRateLimiter(): RateLimiter {
  return createRateLimiter({
    maxRequests: 40, // Conservative limit (50/min, use 40 to be safe)
    windowMs: 60 * 1000 // 1 minute window
  });
}
