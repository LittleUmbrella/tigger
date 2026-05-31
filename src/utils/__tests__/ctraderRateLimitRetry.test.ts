import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  isCTraderRateLimitError,
  resetCTraderHistoricalRateLimiterForTests,
  withCTraderRateLimitRetry,
} from '../ctraderRateLimitRetry.js';

describe('isCTraderRateLimitError', () => {
  it('detects REQUEST_FREQUENCY_EXCEEDED', () => {
    expect(
      isCTraderRateLimitError({ errorCode: 'REQUEST_FREQUENCY_EXCEEDED', description: 'Too many' })
    ).toBe(true);
  });

  it('detects BLOCKED_PAYLOAD_TYPE when description mentions rate limit', () => {
    expect(
      isCTraderRateLimitError({
        errorCode: 'BLOCKED_PAYLOAD_TYPE',
        description: 'You are being rate limited',
      })
    ).toBe(true);
  });

  it('ignores BLOCKED_PAYLOAD_TYPE without rate limit wording', () => {
    expect(
      isCTraderRateLimitError({
        errorCode: 'BLOCKED_PAYLOAD_TYPE',
        description: 'Message is blocked by server',
      })
    ).toBe(false);
  });
});

describe('withCTraderRateLimitRetry', () => {
  beforeEach(() => {
    resetCTraderHistoricalRateLimiterForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCTraderHistoricalRateLimiterForTests();
  });

  it('retries after BLOCKED_PAYLOAD_TYPE rate limit response', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        throw {
          errorCode: 'BLOCKED_PAYLOAD_TYPE',
          description: 'You are being rate limited',
        };
      }
      return 'ok';
    });

    const promise = withCTraderRateLimitRetry(fn, { baseDelayMs: 100, maxRetries: 3 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
