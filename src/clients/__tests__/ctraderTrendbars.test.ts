import { describe, expect, it } from 'vitest';
import { CTraderClient } from '../ctraderClient.js';

describe('CTraderClient.trendbarMaxChunkMs', () => {
  it('limits M1 chunks to under 2000 bars (count is back from toTimestamp)', () => {
    const chunkMs = CTraderClient.trendbarMaxChunkMs('M1', 2000);
    const barsInChunk = chunkMs / (60 * 1000) + 1;
    expect(barsInChunk).toBeLessThanOrEqual(2000);
    expect(chunkMs).toBeLessThan(5 * 7 * 24 * 60 * 60 * 1000);
  });

  it('respects API max range for M5', () => {
    const chunkMs = CTraderClient.trendbarMaxChunkMs('M5', 2000);
    expect(chunkMs).toBeLessThanOrEqual(302_400_000);
    expect(chunkMs / (5 * 60 * 1000) + 1).toBeLessThanOrEqual(2000);
  });
});
