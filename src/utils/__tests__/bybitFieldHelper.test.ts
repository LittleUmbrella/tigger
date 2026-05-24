import { describe, expect, it } from 'vitest';
import { getBybitField } from '../bybitFieldHelper.js';

describe('getBybitField', () => {
  it('returns undefined for nullish object', () => {
    expect(getBybitField(undefined, 'orderId')).toBeUndefined();
  });

  it('prefers camelCase', () => {
    expect(getBybitField({ orderId: 'a' }, 'orderId')).toBe('a');
  });

  it('uses explicit snake_case', () => {
    expect(getBybitField({ order_id: 'b' }, 'orderId', 'order_id')).toBe('b');
  });

  it('auto-converts camelCase to snake_case', () => {
    expect(getBybitField({ avg_price: 1.5 }, 'avgPrice')).toBe(1.5);
  });
});
