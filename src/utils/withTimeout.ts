/**
 * Wall-clock bound for Promises. Does not cancel the underlying work (I/O may still complete).
 */

export class TimeoutError extends Error {
  readonly timeoutMs: number;
  readonly label: string;

  constructor(timeoutMs: number, label: string) {
    super(`Timeout after ${timeoutMs}ms: ${label}`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
    this.label = label;
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(timeoutMs, label));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
