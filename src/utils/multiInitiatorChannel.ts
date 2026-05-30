import { ChannelSetConfig } from '../types/config.js';
import { DatabaseManager, Message, Trade } from '../db/schema.js';

/** Lock scope for trade initiation idempotency (one row per initiator per message). */
export const initiatorLockScope = (initiatorName: string): string => `trade:${initiatorName}`;

/** Exchange stored on `trades.exchange` for a given initiator name. */
export const exchangeForInitiator = (initiatorName: string): Trade['exchange'] =>
  initiatorName === 'ctrader' ? 'ctrader' : 'bybit';

/** Map Telegram channel id → distinct initiator lock scopes configured for that channel. */
export const buildChannelInitiatorScopeMap = (
  channels: ChannelSetConfig[],
): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  for (const ch of channels) {
    if (ch.strategy) continue;
    const scope = initiatorLockScope(ch.initiator);
    const existing = map.get(ch.channel) ?? [];
    if (!existing.includes(scope)) {
      existing.push(scope);
    }
    map.set(ch.channel, existing);
  }
  return map;
};

export const isMultiInitiatorTelegramChannel = (
  channelId: string,
  scopeMap: Map<string, string[]>,
): boolean => (scopeMap.get(channelId)?.length ?? 0) > 1;

/**
 * When multiple initiators share one Telegram channel, mark the message parsed only after
 * every configured initiator scope has a persistent lock (success or permanent failure).
 */
export const maybeMarkMessageFullyProcessed = async (
  db: DatabaseManager,
  message: Message,
  allInitiatorScopes: string[],
): Promise<void> => {
  for (const scope of allInitiatorScopes) {
    const hasLock = await db.hasTradeInitiationLock(message.message_id, message.channel, scope);
    if (!hasLock) return;
  }
  await db.markMessageParsed(message.id);
};
