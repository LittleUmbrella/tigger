import { describe, expect, it } from 'vitest';
import { meanNumericGap, parseTpTokens, resolveTpTokensWithOpen } from '../tpOpenResolve.js';

describe('meanNumericGap', () => {
  it('returns 0 for fewer than two numbers', () => {
    expect(meanNumericGap([])).toBe(0);
    expect(meanNumericGap([1])).toBe(0);
  });

  it('averages consecutive gaps', () => {
    expect(meanNumericGap([10, 12, 16])).toBe(3);
  });
});

describe('parseTpTokens', () => {
  it('recognizes bare T1/T2 labels without P', () => {
    expect(parseTpTokens('T1 :4565 T2 : 4550')).toEqual([
      { kind: 'number', value: 4565 },
      { kind: 'number', value: 4550 },
    ]);
  });

  it('recognizes mathematical italic TP labels (dgfvip message 14813)', () => {
    const msg =
      '🛡XAUUSD BUY@4506~4502 𝑇𝑃1: 4520 𝑇𝑃2: 4530 💣SL 4495';
    expect(parseTpTokens(msg)).toEqual([
      { kind: 'number', value: 4520 },
      { kind: 'number', value: 4530 },
    ]);
  });

  it('recognizes TP 4 : Open without capturing index as price', () => {
    const msg =
      'TP1:4565 TP2:4575 TP3:4585 TP 4 : Open';
    expect(parseTpTokens(msg)).toEqual([
      { kind: 'number', value: 4565 },
      { kind: 'number', value: 4575 },
      { kind: 'number', value: 4585 },
      { kind: 'open' },
    ]);
  });

  it('recognizes TP arrow labels with inconsistent spacing (message 15302)', () => {
    const msg =
      'TP1 ➝ 72950 TP2➝ 72650 TP3 ➝72350 TP 4—72000';
    expect(parseTpTokens(msg)).toEqual([
      { kind: 'number', value: 72950 },
      { kind: 'number', value: 72650 },
      { kind: 'number', value: 72350 },
      { kind: 'number', value: 72000 },
    ]);
  });

  it('does not treat TP index digits as prices when arrow normalization fails', () => {
    expect(parseTpTokens('TP2➝ 72650 TP3 ➝72350')).toEqual([
      { kind: 'number', value: 72650 },
      { kind: 'number', value: 72350 },
    ]);
  });
});

describe('resolveTpTokensWithOpen', () => {
  it('interpolates open slots between numerics', () => {
    const tokens = [
      { kind: 'number' as const, value: 100 },
      { kind: 'open' as const },
      { kind: 'number' as const, value: 110 },
    ];
    expect(resolveTpTokensWithOpen(tokens, 5)).toEqual([100, 105, 110]);
  });

  it('extends trailing opens with avgStep', () => {
    const tokens = [
      { kind: 'number' as const, value: 100 },
      { kind: 'open' as const },
      { kind: 'open' as const },
    ];
    expect(resolveTpTokensWithOpen(tokens, 2)).toEqual([100, 102, 104]);
  });

  it('skips leading opens until first number', () => {
    const tokens = [
      { kind: 'open' as const },
      { kind: 'number' as const, value: 50 },
    ];
    expect(resolveTpTokensWithOpen(tokens, 1)).toEqual([50]);
  });
});
