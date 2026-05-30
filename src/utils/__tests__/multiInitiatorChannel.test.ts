import { describe, expect, it, vi } from 'vitest';
import {
  buildChannelInitiatorScopeMap,
  exchangeForInitiator,
  initiatorLockScope,
  isMultiInitiatorTelegramChannel,
  maybeMarkMessageFullyProcessed,
} from '../multiInitiatorChannel.js';
import { ChannelSetConfig } from '../../types/config.js';
import { DatabaseManager, Message } from '../../db/schema.js';

describe('multiInitiatorChannel', () => {
  it('builds distinct lock scopes per initiator on a channel', () => {
    const channels: ChannelSetConfig[] = [
      {
        channel: '2845421508',
        harvester: 'dgfvip_harvester',
        parser: 'dgfvip',
        initiator: 'ctrader',
        monitor: 'ctrader',
      },
      {
        channel: '2845421508',
        harvester: 'dgfvip_harvester',
        parser: 'dgfvip',
        initiator: 'bybit',
        monitor: 'bybit',
      },
    ];
    const map = buildChannelInitiatorScopeMap(channels);
    expect(map.get('2845421508')).toEqual(['trade:ctrader', 'trade:bybit']);
    expect(isMultiInitiatorTelegramChannel('2845421508', map)).toBe(true);
    expect(isMultiInitiatorTelegramChannel('999', map)).toBe(false);
  });

  it('maps initiator names to exchanges', () => {
    expect(initiatorLockScope('bybit')).toBe('trade:bybit');
    expect(exchangeForInitiator('ctrader')).toBe('ctrader');
    expect(exchangeForInitiator('bybit')).toBe('bybit');
  });

  it('marks message parsed only when all initiator scopes are locked', async () => {
    const message: Message = {
      id: 1,
      message_id: '15302',
      channel: '2845421508',
      content: 'test',
      sender: '',
      date: new Date().toISOString(),
      created_at: new Date().toISOString(),
      parsed: false,
      analyzed: false,
      reply_to_message_id: undefined,
      image_paths: undefined,
    };
    const locks = new Set<string>();
    const db = {
      hasTradeInitiationLock: vi.fn(async (_mid: string, _ch: string, scope: string) =>
        locks.has(scope),
      ),
      markMessageParsed: vi.fn(async () => undefined),
    } as unknown as DatabaseManager;

    await maybeMarkMessageFullyProcessed(db, message, ['trade:ctrader', 'trade:bybit']);
    expect(db.markMessageParsed).not.toHaveBeenCalled();

    locks.add('trade:ctrader');
    await maybeMarkMessageFullyProcessed(db, message, ['trade:ctrader', 'trade:bybit']);
    expect(db.markMessageParsed).not.toHaveBeenCalled();

    locks.add('trade:bybit');
    await maybeMarkMessageFullyProcessed(db, message, ['trade:ctrader', 'trade:bybit']);
    expect(db.markMessageParsed).toHaveBeenCalledWith(1);
  });
});
