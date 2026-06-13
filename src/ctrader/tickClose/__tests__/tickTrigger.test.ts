import { describe, expect, it } from 'vitest';
import { findNextTriggeredLevel } from '../tickTrigger.js';
import type { TickTpLevel } from '../types.js';

const levels = (items: Array<[number, number, TickTpLevel['status']]>): TickTpLevel[] =>
  items.map(([index, price, status]) => ({
    index,
    price,
    volumeLots: 0.01,
    status,
  }));

describe('findNextTriggeredLevel', () => {
  it('long: triggers when bid >= lowest pending TP', () => {
    const hit = findNextTriggeredLevel('long', { bid: 2651, ask: 2651.5 }, levels([[1, 2650, 'pending'], [2, 2660, 'pending']]));
    expect(hit?.index).toBe(1);
  });

  it('long: skips filled, returns next pending', () => {
    const hit = findNextTriggeredLevel('long', { bid: 2661, ask: 2661.5 }, levels([[1, 2650, 'filled'], [2, 2660, 'pending']]));
    expect(hit?.index).toBe(2);
  });

  it('short: triggers when ask <= TP', () => {
    const hit = findNextTriggeredLevel('short', { bid: 2649, ask: 2649.5 }, levels([[1, 2650, 'pending']]));
    expect(hit?.index).toBe(1);
  });

  it('returns undefined when no level touched', () => {
    const hit = findNextTriggeredLevel('long', { bid: 2640, ask: 2640.5 }, levels([[1, 2650, 'pending']]));
    expect(hit).toBeUndefined();
  });
});
