import { describe, expect, it } from 'vitest';
import {
  CTRADER_DEFAULT_AUTH_MAX_AGE_MS,
  isCtraderAlreadyLoggedInError,
  isCtraderAuthError,
  resolveCtraderAuthMaxAgeMs,
} from '../ctraderAuthErrors.js';

describe('ctraderAuthErrors', () => {
  it('resolves auth max age from minutes with 15 min default', () => {
    expect(resolveCtraderAuthMaxAgeMs()).toBe(CTRADER_DEFAULT_AUTH_MAX_AGE_MS);
    expect(resolveCtraderAuthMaxAgeMs(10)).toBe(10 * 60 * 1000);
    expect(resolveCtraderAuthMaxAgeMs(0)).toBe(0);
  });

  it('detects ProtoOA not authorized errors', () => {
    const error = JSON.stringify({
      payloadType: 'ProtoOAErrorRes',
      errorCode: 'INVALID_REQUEST',
      description: 'Trading account is not authorized',
    });
    expect(isCtraderAuthError(error)).toBe(true);
  });

  it('detects OA_AUTH_TOKEN_EXPIRED', () => {
    const error = JSON.stringify({
      payloadType: 'ProtoOAErrorRes',
      errorCode: 'OA_AUTH_TOKEN_EXPIRED',
      description: 'Token expired',
    });
    expect(isCtraderAuthError(error)).toBe(true);
  });

  it('detects already logged in as benign re-auth', () => {
    const error = JSON.stringify({
      payloadType: 'ProtoOAErrorRes',
      errorCode: 'ALREADY_LOGGED_IN',
      description: 'Already logged in',
    });
    expect(isCtraderAlreadyLoggedInError(error)).toBe(true);
    expect(isCtraderAuthError(error)).toBe(false);
  });
});
