/** Default max age before probing/re-auth on a pooled cTrader account session (15 minutes). */
export const CTRADER_DEFAULT_AUTH_MAX_AGE_MS = 15 * 60 * 1000;

export const resolveCtraderAuthMaxAgeMs = (minutes?: number): number => {
  if (minutes === 0) return 0;
  if (minutes != null && minutes > 0) return minutes * 60 * 1000;
  return CTRADER_DEFAULT_AUTH_MAX_AGE_MS;
};

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
};

export const isCtraderAlreadyLoggedInError = (error: unknown): boolean => {
  const text = errorText(error).toLowerCase();
  return text.includes('already_logged_in') || text.includes('already logged in');
};

export const isCtraderAuthError = (error: unknown): boolean => {
  const text = errorText(error);
  const lower = text.toLowerCase();

  if (lower.includes('trading account is not authorized')) return true;
  if (lower.includes('account_not_authorized')) return true;
  if (lower.includes('oa_auth_token_expired')) return true;
  if (lower.includes('not authorized') && lower.includes('protooa')) return true;

  if (text.includes('ProtoOAErrorRes')) {
    try {
      const parsed = JSON.parse(text) as { errorCode?: string; description?: string };
      const code = String(parsed.errorCode ?? '').toUpperCase();
      const description = String(parsed.description ?? '').toLowerCase();
      if (code === 'OA_AUTH_TOKEN_EXPIRED') return true;
      if (description.includes('not authorized')) return true;
    } catch {
      /* ignore malformed JSON */
    }
  }

  return false;
};

export const isCtraderAuthRetryableMessage = (error: unknown): boolean =>
  isCtraderAuthError(error);
