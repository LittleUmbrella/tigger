import { describe, expect, it } from 'vitest';
import { meanNumericGap, resolveTpTokensWithOpen } from '../tpOpenResolve.js';

describe('meanNumericGap', () => {
  it('returns 0 for fewer than two numbers', () => {
    expect(meanNumericGap([])).toBe(0);
    expect(meanNumericGap([1])).toBe(0);
  });

  it('averages consecutive gaps', () => {
    expect(meanNumericGap([10, 12, 16])).toBe(3);
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
