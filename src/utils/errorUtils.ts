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
