import { describe, expect, it } from 'vitest';
import { protobufLongToNumber } from '../protobufLong.js';

describe('protobufLongToNumber', () => {
  it('returns numbers as-is', () => {
    expect(protobufLongToNumber(42)).toBe(42);
  });

  it('uses toNumber when present', () => {
    expect(protobufLongToNumber({ toNumber: () => 99 })).toBe(99);
  });

  it('combines high and low words', () => {
    expect(protobufLongToNumber({ high: 1, low: 2 })).toBe(1 * 0x100000000 + 2);
  });

  it('returns undefined for unsupported values', () => {
    expect(protobufLongToNumber(null)).toBeUndefined();
    expect(protobufLongToNumber('x')).toBeUndefined();
  });
});
