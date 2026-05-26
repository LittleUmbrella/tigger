import { describe, expect, it } from 'vitest';
import { resolveAllowConcurrentSymbolTrades } from '../allowConcurrentSymbolTrades.js';
import type { AccountConfig } from '../../types/config.js';

const account = (allowConcurrentSymbolTrades?: boolean): AccountConfig => ({
  name: 'test',
  exchange: 'ctrader',
  allowConcurrentSymbolTrades
});

describe('resolveAllowConcurrentSymbolTrades', () => {
  it('defaults to false when unset', () => {
    expect(resolveAllowConcurrentSymbolTrades(undefined, account())).toBe(false);
    expect(resolveAllowConcurrentSymbolTrades(undefined, null)).toBe(false);
  });

  it('uses account when channel omits override', () => {
    expect(resolveAllowConcurrentSymbolTrades(undefined, account(true))).toBe(true);
    expect(resolveAllowConcurrentSymbolTrades(undefined, account(false))).toBe(false);
  });

  it('channel override wins over account', () => {
    expect(resolveAllowConcurrentSymbolTrades(true, account(false))).toBe(true);
    expect(resolveAllowConcurrentSymbolTrades(false, account(true))).toBe(false);
  });
});
