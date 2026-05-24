import { describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from '../withTimeout.js';

describe('withTimeout', () => {
  it('resolves when promise finishes first', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'fast')).resolves.toBe(42);
  });

  it('rejects with TimeoutError when deadline exceeded', async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve('late'), 5000);
    });
    const pending = withTimeout(slow, 100, 'slow-op');
    vi.advanceTimersByTime(150);
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await expect(pending).rejects.toMatchObject({ timeoutMs: 100, label: 'slow-op' });
    vi.useRealTimers();
  });
});
