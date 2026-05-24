import { describe, expect, it } from 'vitest';
import { parseManagementCommand } from '../managementParser.js';

describe('parseManagementCommand (pattern matching)', () => {
  it('detects close all longs', async () => {
    expect(await parseManagementCommand('Please close all longs now')).toEqual({
      type: 'close_all_longs',
    });
  });

  it('detects close all shorts', async () => {
    expect(await parseManagementCommand('closed all shorts')).toEqual({
      type: 'close_all_shorts',
    });
  });

  it('detects close all trades', async () => {
    expect(await parseManagementCommand('close everything')).toEqual({
      type: 'close_all_trades',
    });
  });

  it('detects secure half with BE', async () => {
    expect(await parseManagementCommand('Scalpers can secure half and set BE')).toEqual({
      type: 'close_percentage',
      percentage: 50,
      tradingPair: undefined,
      moveStopLossToEntry: true,
    });
  });

  it('detects percentage close with pair', async () => {
    expect(
      await parseManagementCommand('Close 25% #ETHUSDT and move SL on entry')
    ).toEqual({
      type: 'close_percentage',
      percentage: 25,
      tradingPair: 'ETH/USDT',
      moveStopLossToEntry: true,
    });
  });

  it('detects close specific position', async () => {
    expect(await parseManagementCommand('Close #BTCUSDT')).toEqual({
      type: 'close_position',
      tradingPair: 'BTC/USDT',
    });
  });

  it('returns null for non-management text', async () => {
    expect(await parseManagementCommand('Gold buy now 3950')).toBeNull();
  });
});
