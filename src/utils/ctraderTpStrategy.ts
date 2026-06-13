import type { AccountConfig } from '../types/config.js';

export type CTraderTpStrategy = 'multi-order' | 'tick-close';

export const resolveCtraderTpStrategy = (account: AccountConfig | null | undefined): CTraderTpStrategy => {
  if (!account || account.exchange !== 'ctrader') return 'multi-order';
  return account.ctraderTpStrategy ?? 'multi-order';
};

export const isTickCloseStrategy = (account: AccountConfig | null | undefined): boolean =>
  resolveCtraderTpStrategy(account) === 'tick-close';
