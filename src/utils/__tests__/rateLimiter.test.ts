import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRateLimiter } from '../rateLimiter.js';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks requests within window', async () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 1000 });
    await limiter.waitIfNeeded();
    await limiter.waitIfNeeded();
    expect(limiter.getCurrentCount()).toBe(2);
  });

  it('waits when at capacity', async () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 1000 });
    await limiter.waitIfNeeded();
    const third = limiter.waitIfNeeded();
    vi.advanceTimersByTime(1100);
    await third;
    expect(limiter.getCurrentCount()).toBeGreaterThanOrEqual(1);
  });

  it('reset clears state', async () => {
    const limiter = createRateLimiter({ maxRequests: 5, windowMs: 1000 });
    await limiter.waitIfNeeded();
    limiter.reset();
    expect(limiter.getCurrentCount()).toBe(0);
  });
});
