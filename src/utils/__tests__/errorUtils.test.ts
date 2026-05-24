import { describe, expect, it } from 'vitest';
import { isTransientInfrastructureError, serializeErrorForLog } from '../errorUtils.js';

describe('serializeErrorForLog', () => {
  it('returns message for Error instances', () => {
    expect(serializeErrorForLog(new Error('boom'))).toBe('boom');
  });

  it('formats Bybit-style retCode objects', () => {
    expect(serializeErrorForLog({ retCode: 10001, retMsg: 'params error' })).toBe(
      'retCode=10001 retMsg=params error'
    );
  });

  it('stringifies other objects', () => {
    expect(serializeErrorForLog({ code: 'X' })).toBe('{"code":"X"}');
  });

  it('coerces primitives', () => {
    expect(serializeErrorForLog('plain')).toBe('plain');
  });
});

describe('isTransientInfrastructureError', () => {
  it('detects network and rate-limit patterns', () => {
    expect(isTransientInfrastructureError(new Error('ECONNRESET while fetching'))).toBe(true);
    expect(isTransientInfrastructureError(new Error('HTTP 429 too many requests'))).toBe(true);
    expect(isTransientInfrastructureError({ retCode: 1, retMsg: 'rate limit exceeded' })).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientInfrastructureError(new Error('invalid API key'))).toBe(false);
  });

  it('walks Error.cause chain', () => {
    const inner = new Error('socket hang up');
    const outer = new Error('request failed', { cause: inner });
    expect(isTransientInfrastructureError(outer)).toBe(true);
  });
});
