/**
 * Serialize thrown value for logging.
 * Bybit/cTrader SDKs can throw plain objects (e.g. retCode/retMsg), not just Error.
 * Using String(error) on objects yields "[object Object]" - this extracts useful info.
 */
export function serializeErrorForLog(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    try {
      const obj = error as Record<string, unknown>;
      if (obj.retCode !== undefined && obj.retMsg !== undefined) {
        return `retCode=${obj.retCode} retMsg=${obj.retMsg}`;
      }
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * True when the failure is likely transient (network blip, DB reconnect, TLS handshake, rate limits).
 * Used for log level and alerting — the parser loop will run again on the next tick.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  const chain = errorMessageChain(error).toLowerCase();

  const patterns = [
    'connection failure',
    'connection refused',
    'connection reset',
    'during authentication',
    'broken pipe',
    'socket hang up',
    'econnreset',
    'econnrefused',
    'etimedout',
    'enotfound',
    'enetunreach',
    'eai_again',
    'timeout',
    'timed out',
    'network error',
    'fetch failed',
    'temporarily unavailable',
    'service unavailable',
    'too many requests',
    'rate limit',
    'status code 503',
    'status code 502',
    'status code 504',
    'status code 429',
    'bad gateway',
    'gateway timeout',
    'host unreachable',
    'dns',
    'getaddrinfo',
  ];

  for (const pattern of patterns) {
    if (chain.includes(pattern)) {
      return true;
    }
  }
  return false;
}

function errorMessageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 4 && current !== undefined && current !== null; i++) {
    parts.push(serializeErrorForLog(current));
    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
    } else {
      break;
    }
  }
  return parts.join(' | ');
}
