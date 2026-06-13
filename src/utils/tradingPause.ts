import type { AccountConfig, TradingPauseConfig } from '../types/config.js';

/** Resolved pause lists — empty arrays mean no pauses for that dimension. */
export interface ResolvedTradingPause {
  exchanges: string[];
  accounts: string[];
}

export const EMPTY_TRADING_PAUSE: ResolvedTradingPause = {
  exchanges: [],
  accounts: [],
};

const parseCommaDelimited = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const readPauseList = (
  envVarName: string | undefined,
  inlineList: string[] | undefined,
  env: NodeJS.ProcessEnv,
): string[] => {
  if (envVarName) {
    const raw = env[envVarName];
    if (raw === undefined || raw === '') {
      return [];
    }
    return parseCommaDelimited(raw);
  }
  return inlineList ?? [];
};

/** Read comma-delimited pause lists from env vars named in config (blank/unset env = no pauses). */
export const resolveTradingPause = (
  config?: TradingPauseConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTradingPause => {
  if (!config) {
    return EMPTY_TRADING_PAUSE;
  }

  return {
    exchanges: readPauseList(config.envVarNames?.exchanges, config.exchanges, env),
    accounts: readPauseList(config.envVarNames?.accounts, config.accounts, env),
  };
};

export const isAccountTradingPaused = (
  account: AccountConfig,
  tradingPause: ResolvedTradingPause = EMPTY_TRADING_PAUSE,
): boolean => {
  if (account.paused) {
    return true;
  }
  if (tradingPause.accounts.includes(account.name)) {
    return true;
  }
  const exchange = account.exchange.toLowerCase();
  return tradingPause.exchanges.some(
    (pausedExchange) => pausedExchange.toLowerCase() === exchange,
  );
};

export const filterTradableAccounts = (
  accounts: (AccountConfig | null)[],
  tradingPause: ResolvedTradingPause,
  options: { isSimulation: boolean },
): (AccountConfig | null)[] => {
  if (options.isSimulation) {
    return accounts;
  }
  return accounts.filter((account) => account === null || !isAccountTradingPaused(account, tradingPause));
};

export const getPausedAccountNames = (
  accounts: (AccountConfig | null)[],
  tradingPause: ResolvedTradingPause,
): string[] =>
  accounts
    .filter((account): account is AccountConfig => account !== null && isAccountTradingPaused(account, tradingPause))
    .map((account) => account.name);
