import type { TickTpLevel } from './types.js';

export const findNextTriggeredLevel = (
  direction: 'long' | 'short',
  quote: { bid: number; ask: number },
  levels: TickTpLevel[]
): TickTpLevel | undefined => {
  const pending = [...levels]
    .filter((l) => l.status === 'pending')
    .sort((a, b) => a.index - b.index);

  for (const level of pending) {
    const touched =
      direction === 'long'
        ? quote.bid >= level.price
        : quote.ask <= level.price;
    if (touched) return level;
  }
  return undefined;
};
