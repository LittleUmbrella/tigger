/**
 * cTrader Open API rate limit retry.
 *
 * cTrader limits historical data (deal list, order list) to 5 requests/sec.
 * When exceeded, returns ProtoOAErrorRes with errorCode REQUEST_FREQUENCY_EXCEEDED.
 *
 * Wraps historical API calls and retries with exponential backoff on rate limit.
 * When any call hits the limit, a global cooldown applies so other calls wait
 * before proceeding (avoids thundering herd).
 */

import { logger } from './logger.js';

const CTRADER_RATE_LIMIT_ERROR = 'REQUEST_FREQUENCY_EXCEEDED';

/** Global cooldown: no historical calls proceed until this timestamp (ms). */
let globalCooldownUntil = 0;

function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes(CTRADER_RATE_LIMIT_ERROR);
  }
  if (!error || typeof error !== 'object') return false;
  const obj = error as Record<string, unknown>;
  const code = obj.errorCode ?? obj.error_code;
  if (typeof code === 'string') return code === CTRADER_RATE_LIMIT_ERROR;
  return false;
}

async function waitForGlobalCooldown(): Promise<void> {
  const now = Date.now();
  if (now >= globalCooldownUntil) return;
  const waitMs = globalCooldownUntil - now;
  logger.warn('cTrader rate limit cooldown - waiting before next historical request', {
    waitMs,
    exchange: 'ctrader'
  });
  await new Promise(resolve => setTimeout(resolve, waitMs));
}

export interface WithCTraderRateLimitRetryOptions {
  /** Max retries before giving up (default: 4) */
  maxRetries?: number;
  /** Base delay in ms (default: 1500) - historical limit is 5/sec, 1.5s between retries is safe */
  baseDelayMs?: number;
  /** Label for logging */
  label?: string;
}

/**
 * Execute a cTrader historical API call with retry on REQUEST_FREQUENCY_EXCEEDED.
 * Uses exponential backoff and global cooldown so parallel callers respect the limit.
 */
export async function withCTraderRateLimitRetry<T>(
  fn: () => Promise<T>,
  options?: WithCTraderRateLimitRetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 4;
  const baseDelayMs = options?.baseDelayMs ?? 1500;
  const label = options?.label;
  const getDelay = (attempt: number) => baseDelayMs * Math.pow(2, attempt);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await waitForGlobalCooldown();

    try {
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }
      const delay = getDelay(attempt);
      globalCooldownUntil = Date.now() + delay;
      logger.warn('cTrader rate limit hit - retrying after backoff', {
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        label,
        exchange: 'ctrader'
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
