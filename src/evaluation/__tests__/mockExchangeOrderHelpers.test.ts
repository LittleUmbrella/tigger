import { describe, expect, it } from 'vitest';
import { Order } from '../../db/schema.js';
import {
  computeDirectionalPnL,
  selectCanonicalEntryOrder,
  selectCanonicalStopLossOrder,
} from '../mockExchangeOrderHelpers.js';

const entry = (overrides: Partial<Order>): Order =>
  ({
    id: 1,
    trade_id: 1,
    order_type: 'entry',
    status: 'pending',
    quantity: 0,
    ...overrides,
  }) as Order;

const stopLoss = (overrides: Partial<Order>): Order =>
  ({
    id: 2,
    trade_id: 1,
    order_type: 'stop_loss',
    status: 'pending',
    quantity: 0,
    ...overrides,
  }) as Order;

describe('selectCanonicalEntryOrder', () => {
  it('prefers filled entry over duplicate pending zero-qty row', () => {
    const orders = [
      entry({ id: 10, status: 'pending', quantity: 0 }),
      entry({
        id: 11,
        status: 'filled',
        filled_at: '2026-05-19T18:52:00.000Z',
        filled_price: 4498.74,
        quantity: 5,
      }),
    ];
    expect(selectCanonicalEntryOrder(orders)?.id).toBe(11);
  });
});

describe('selectCanonicalStopLossOrder', () => {
  it('prefers stop loss row with quantity', () => {
    const orders = [
      stopLoss({ id: 20, quantity: 0 }),
      stopLoss({ id: 21, quantity: 5 }),
    ];
    expect(selectCanonicalStopLossOrder(orders)?.id).toBe(21);
  });
});

describe('computeDirectionalPnL', () => {
  it('computes short PnL from entry and exit', () => {
    const pnl = computeDirectionalPnL(false, 4498.74, 4490.33, 1.66);
    expect(pnl).toBeCloseTo(13.9606, 2);
  });
});
