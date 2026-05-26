import type { AccountConfig } from '../types/config.js';

/**
 * Whether a new cTrader trade may open while another active trade exists for the same
 * symbol on the same channel. Channel value overrides account; default false (dedupe on).
 */
export const resolveAllowConcurrentSymbolTrades = (
  channelOverride: boolean | undefined,
  account: AccountConfig | null | undefined
): boolean => {
  if (channelOverride !== undefined) {
    return channelOverride;
  }
  return account?.allowConcurrentSymbolTrades ?? false;
};
