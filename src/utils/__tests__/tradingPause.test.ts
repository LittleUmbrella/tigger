import { describe, it, expect } from 'vitest';
import {
  EMPTY_TRADING_PAUSE,
  filterTradableAccounts,
  getPausedAccountNames,
  isAccountTradingPaused,
  resolveTradingPause,
} from '../tradingPause.js';
import type { AccountConfig } from '../../types/config.js';

const ctraderAccount = (name: string): AccountConfig => ({
  name,
  exchange: 'ctrader',
  envVarNames: { apiKey: 'K', apiSecret: 'S' },
});

const bybitAccount: AccountConfig = {
  name: 'bybit_main',
  exchange: 'bybit',
  envVarNames: { apiKey: 'K', apiSecret: 'S' },
};

describe('tradingPause', () => {
  it('pauses by exchange type', () => {
    expect(
      isAccountTradingPaused(ctraderAccount('ctrader_live_5'), { exchanges: ['ctrader'], accounts: [] }),
    ).toBe(true);
    expect(
      isAccountTradingPaused(bybitAccount, { exchanges: ['ctrader'], accounts: [] }),
    ).toBe(false);
  });

  it('uses by account name', () => {
    expect(
      isAccountTradingPaused(bybitAccount, { exchanges: [], accounts: ['bybit_main'] }),
    ).toBe(true);
    expect(
      isAccountTradingPaused(bybitAccount, { exchanges: [], accounts: ['other'] }),
    ).toBe(false);
  });

  it('treats empty lists as no pauses', () => {
    expect(isAccountTradingPaused(bybitAccount, EMPTY_TRADING_PAUSE)).toBe(false);
    expect(isAccountTradingPaused({ ...bybitAccount, paused: true }, EMPTY_TRADING_PAUSE)).toBe(true);
  });

  it('filters paused accounts in live mode only', () => {
    const accounts = [ctraderAccount('a'), ctraderAccount('b'), bybitAccount];
    const pause = { exchanges: ['ctrader'], accounts: [] };
    const filtered = filterTradableAccounts(accounts, pause, { isSimulation: false });
    expect(filtered.map((a) => a?.name)).toEqual(['bybit_main']);

    const simulationFiltered = filterTradableAccounts(accounts, pause, { isSimulation: true });
    expect(simulationFiltered).toEqual(accounts);
  });

  it('reports paused account names', () => {
    const accounts = [ctraderAccount('a'), bybitAccount];
    expect(getPausedAccountNames(accounts, { exchanges: ['ctrader'], accounts: [] })).toEqual(['a']);
  });

  it('reads comma-delimited values from env vars named in config', () => {
    expect(
      resolveTradingPause(
        { envVarNames: { exchanges: 'TRADING_PAUSE_EXCHANGES' } },
        { TRADING_PAUSE_EXCHANGES: 'ctrader, bybit' },
      ),
    ).toEqual({ exchanges: ['ctrader', 'bybit'], accounts: [] });
  });

  it('treats unset or blank env as no pauses', () => {
    expect(
      resolveTradingPause({ envVarNames: { exchanges: 'TRADING_PAUSE_EXCHANGES' } }, {}),
    ).toEqual(EMPTY_TRADING_PAUSE);
    expect(
      resolveTradingPause({ envVarNames: { exchanges: 'TRADING_PAUSE_EXCHANGES' } }, {
        TRADING_PAUSE_EXCHANGES: '',
      }),
    ).toEqual(EMPTY_TRADING_PAUSE);
  });

  it('resolves exchanges and accounts independently', () => {
    expect(
      resolveTradingPause(
        {
          envVarNames: {
            exchanges: 'TRADING_PAUSE_EXCHANGES',
            accounts: 'TRADING_PAUSE_ACCOUNTS',
          },
        },
        {
          TRADING_PAUSE_EXCHANGES: 'ctrader',
          TRADING_PAUSE_ACCOUNTS: 'ctrader_live_5, ctrader_demo_2_100',
        },
      ),
    ).toEqual({
      exchanges: ['ctrader'],
      accounts: ['ctrader_live_5', 'ctrader_demo_2_100'],
    });
  });
});
