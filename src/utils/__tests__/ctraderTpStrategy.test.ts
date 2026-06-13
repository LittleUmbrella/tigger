import { describe, expect, it } from 'vitest';
import type { AccountConfig } from '../../types/config.js';
import {
  isTickCloseStrategy,
  resolveCtraderTpStrategy,
} from '../ctraderTpStrategy.js';

describe('ctraderTpStrategy', () => {
  const ctraderAccount: AccountConfig = {
    name: 'ctrader-main',
    exchange: 'ctrader',
    envVarNames: { apiKey: 'CTRADER_KEY', apiSecret: 'CTRADER_SECRET' },
  };

  it('defaults to multi-order when omitted', () => {
    expect(resolveCtraderTpStrategy(ctraderAccount)).toBe('multi-order');
    expect(resolveCtraderTpStrategy(null)).toBe('multi-order');
    expect(resolveCtraderTpStrategy(undefined)).toBe('multi-order');
  });

  it('returns tick-close when set on ctrader account', () => {
    const account: AccountConfig = {
      ...ctraderAccount,
      ctraderTpStrategy: 'tick-close',
    };
    expect(resolveCtraderTpStrategy(account)).toBe('tick-close');
    expect(isTickCloseStrategy(account)).toBe(true);
  });

  it('isTickCloseStrategy is false for bybit accounts', () => {
    const bybitAccount: AccountConfig = {
      name: 'bybit-main',
      exchange: 'bybit',
      envVarNames: { apiKey: 'BYBIT_KEY', apiSecret: 'BYBIT_SECRET' },
      ctraderTpStrategy: 'tick-close',
    };
    expect(resolveCtraderTpStrategy(bybitAccount)).toBe('multi-order');
    expect(isTickCloseStrategy(bybitAccount)).toBe(false);
  });
});
