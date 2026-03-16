/**
 * Bybit API rate limit retry with exponential backoff.
 *
 * Wraps Bybit API calls and retries on rate limit (429) or other transient
 * errors (10006, 10016, 10018) using exponential backoff: 1s, 2s, 4s, 8s, 16s.
 *
 * When any call gets rate limited, ALL subsequent Bybit calls wait before
 * proceeding. Bybit docs: exceeding IP limit (600 req/5sec) yields 403
 * "access too frequent" and a 10-minute ban. Pausing all traffic avoids
 * cascading into that penalty.
 */

import { logger } from './logger.js';
import { createBybitPrivateRateLimiter } from './rateLimiter.js';

/** Bybit retCode values that warrant retry with backoff (rate limit, server busy, etc.) */
const BYBIT_RETRYABLE_CODES = new Set([10000, 10006, 10016, 10018, 429]);

/** Global cooldown: no Bybit calls proceed until this timestamp (ms). Set when any call hits rate limit. */
let globalCooldownUntil = 0;

async function waitForGlobalCooldown(): Promise<void> {
  const now = Date.now();
  if (now >= globalCooldownUntil) return;
  const waitMs = globalCooldownUntil - now;
  logger.warn('Bybit global cooldown active - waiting before next request', {
    waitMs,
    cooldownUntil: new Date(globalCooldownUntil).toISOString()
  });
  await new Promise(resolve => setTimeout(resolve, waitMs));
}

function isRetryableRetCode(retCode: unknown): boolean {
  return typeof retCode === 'number' && BYBIT_RETRYABLE_CODES.has(retCode);
}

function getRetCodeFromError(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'retCode' in error) {
    const rc = (error as { retCode?: unknown }).retCode;
    return typeof rc === 'number' ? rc : undefined;
  }
  return undefined;
}

function getRetCodeFromResponse(value: unknown): number | undefined {
  if (value && typeof value === 'object' && 'retCode' in value) {
    const rc = (value as { retCode?: unknown }).retCode;
    return typeof rc === 'number' ? rc : undefined;
  }
  return undefined;
}

/** Shared rate limiter for live bot Bybit calls (singleton to preserve state across calls) */
let sharedRateLimiter: ReturnType<typeof createBybitPrivateRateLimiter> | null = null;

function getRateLimiter(): ReturnType<typeof createBybitPrivateRateLimiter> {
  if (!sharedRateLimiter) {
    sharedRateLimiter = createBybitPrivateRateLimiter();
  }
  return sharedRateLimiter;
}

export interface WithBybitRateLimitRetryOptions {
  /** Max retries before giving up (default: 5) */
  maxRetries?: number;
  /** Optional label for logging */
  label?: string;
}

/**
 * Execute a Bybit API call with exponential backoff on rate limit.
 * Retries on 429, 10006, 10016, 10018. Uses backoff: 1s, 2s, 4s, 8s, 16s.
 * On rate limit, sets global cooldown so ALL Bybit calls pause before proceeding.
 */
export async function withBybitRateLimitRetry<T>(
  fn: () => Promise<T>,
  options?: WithBybitRateLimitRetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 5;
  const label = options?.label;
  const rateLimiter = getRateLimiter();
  const baseDelay = 1000;
  const getDelay = (attempt: number) => baseDelay * Math.pow(2, attempt);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Wait if another call triggered a global cooldown (e.g. hit rate limit)
    await waitForGlobalCooldown();

    try {
      const result = await fn();

      // Check if response has retryable retCode (non-throwing API responses)
      const retCode = getRetCodeFromResponse(result);
      if (retCode !== undefined && retCode !== 0 && isRetryableRetCode(retCode)) {
        if (attempt >= maxRetries) {
          const err = new Error(`Bybit rate limit: retCode=${retCode} retries exhausted`) as Error & { retCode?: number; response?: T };
          err.retCode = retCode;
          err.response = result;
          throw err;
        }
        const delay = getDelay(attempt);
        globalCooldownUntil = Date.now() + delay;
        await rateLimiter.handleRateLimitError(attempt);
        lastError = result;
        continue;
      }

      return result;
    } catch (error) {
      lastError = error;
      const retCode = getRetCodeFromError(error);
      const isRetryable = retCode !== undefined ? isRetryableRetCode(retCode) : false;

      if (!isRetryable || attempt >= maxRetries) {
        throw error;
      }

      const delay = getDelay(attempt);
      globalCooldownUntil = Date.now() + delay;
      await rateLimiter.handleRateLimitError(attempt);
    }
  }

  throw lastError;
}
