/**
 * cTrader Open API rate limit retry.
 *
 * cTrader limits historical data to 5 requests/sec. Parallel eval callers share one
 * serialized gate so waitIfNeeded cannot race, plus global cooldown on limit errors.
 */

import { logger } from './logger.js';
import { createCTraderHistoricalRateLimiter, type RateLimiter } from './rateLimiter.js';

const CTRADER_RATE_LIMIT_CODES = new Set([
  'REQUEST_FREQUENCY_EXCEEDED',
  'BLOCKED_PAYLOAD_TYPE',
]);

/** Global cooldown: no historical calls proceed until this timestamp (ms). */
let globalCooldownUntil = 0;

/** Serializes slot acquisition — prevents parallel waitIfNeeded races. */
let apiGate: Promise<void> = Promise.resolve();

let sharedHistoricalRateLimiter: RateLimiter | null = null;

export const getCTraderHistoricalRateLimiter = (): RateLimiter => {
  if (!sharedHistoricalRateLimiter) {
    sharedHistoricalRateLimiter = createCTraderHistoricalRateLimiter();
  }
  return sharedHistoricalRateLimiter;
};

/** Visible for tests */
export const isCTraderRateLimitError = (error: unknown): boolean => {
  const checkRecord = (obj: Record<string, unknown>): boolean => {
    const code = String(obj.errorCode ?? obj.error_code ?? '');
    if (!CTRADER_RATE_LIMIT_CODES.has(code)) return false;
    if (code === 'BLOCKED_PAYLOAD_TYPE') {
      const desc = String(obj.description ?? '').toLowerCase();
      return desc.includes('rate limit');
    }
    return true;
  };

  if (error instanceof Error) {
    for (const code of CTRADER_RATE_LIMIT_CODES) {
      if (error.message.includes(code)) return true;
    }
    if (error.message.toLowerCase().includes('rate limit')) return true;
    try {
      const parsed = JSON.parse(error.message);
      if (parsed && typeof parsed === 'object') {
        return checkRecord(parsed as Record<string, unknown>);
      }
    } catch {
      // not JSON
    }
    return false;
  }

  if (error && typeof error === 'object') {
    return checkRecord(error as Record<string, unknown>);
  }

  return false;
};

const waitForGlobalCooldown = async (): Promise<void> => {
  const now = Date.now();
  if (now >= globalCooldownUntil) return;
  const waitMs = globalCooldownUntil - now;
  logger.warn('cTrader rate limit cooldown - waiting before next historical request', {
    waitMs,
    exchange: 'ctrader',
  });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
};

const runWithHistoricalGate = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = apiGate;
  apiGate = slot;
  await previous;

  try {
    await waitForGlobalCooldown();
    await getCTraderHistoricalRateLimiter().waitIfNeeded();
    return await fn();
  } finally {
    release();
  }
};

export interface WithCTraderRateLimitRetryOptions {
  /** Max retries before giving up (default: 8) */
  maxRetries?: number;
  /** Base delay in ms (default: 2000) */
  baseDelayMs?: number;
  /** Label for logging */
  label?: string;
}

/**
 * Execute a cTrader historical API call with serialized rate limiting and retry.
 */
export async function withCTraderRateLimitRetry<T>(
  fn: () => Promise<T>,
  options?: WithCTraderRateLimitRetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 8;
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  const label = options?.label;
  const getDelay = (attempt: number) => baseDelayMs * Math.pow(2, attempt);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runWithHistoricalGate(fn);
    } catch (error) {
      lastError = error;
      if (!isCTraderRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }
      const delay = getDelay(attempt);
      globalCooldownUntil = Date.now() + delay;
      logger.warn('cTrader rate limit hit - retrying after backoff', {
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        label,
        exchange: 'ctrader',
        errorCode:
          error && typeof error === 'object'
            ? (error as Record<string, unknown>).errorCode
            : undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/** Reset shared limiter state (tests only) */
export const resetCTraderHistoricalRateLimiterForTests = (): void => {
  sharedHistoricalRateLimiter?.reset();
  sharedHistoricalRateLimiter = null;
  globalCooldownUntil = 0;
  apiGate = Promise.resolve();
};
