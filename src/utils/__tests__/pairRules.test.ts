import { describe, expect, it } from 'vitest';
import {
  applyPairRulesToContext,
  normalizeTradingPairKey,
  resolvePairRule,
} from '../pairRules.js';
import { InitiatorContext } from '../../initiators/initiatorRegistry.js';

const baseContext = (overrides: Partial<InitiatorContext> = {}): InitiatorContext => ({
  channel: '2845421508',
  riskPercentage: 1,
  entryTimeoutMinutes: 10,
  message: {
    id: 1,
    message_id: '15951',
    channel: '2845421508',
    content: 'test',
    date: '2026-06-05T13:32:02.000Z',
    parsed: false,
    analyzed: false,
  },
  order: {
    tradingPair: 'XAUUSD',
    signalType: 'short',
    stopLoss: 4416,
    takeProfits: [4406, 4401, 4396],
    leverage: 20,
  },
  db: {} as InitiatorContext['db'],
  isSimulation: false,
  config: { name: 'bybit', riskPercentage: 1 },
  useLimitOrderForEntry: false,
  ...overrides,
});

describe('normalizeTradingPairKey', () => {
  it('normalizes slash and quote suffixes', () => {
    expect(normalizeTradingPairKey('XAU/USD')).toBe('XAUUSD');
    expect(normalizeTradingPairKey('XAUUSD')).toBe('XAUUSD');
    expect(normalizeTradingPairKey('BTCUSDT')).toBe('BTC');
  });
});

describe('resolvePairRule', () => {
  const pairRules = [
    {
      pairs: ['XAUUSD', 'GOLD'],
      skip: true,
    },
    {
      pairs: ['BTCUSDT', 'BTC/USDT'],
      entry: { useLimitOrderForEntry: true },
    },
    {
      pairs: ['*'],
      entry: { useLimitOrderForEntry: false },
    },
  ];

  it('skips matched pairs', () => {
    expect(resolvePairRule('XAU/USD', 'short', pairRules)).toEqual({
      skip: true,
      entry: undefined,
      matchedRuleIndex: 0,
    });
  });

  it('returns entry overrides for matched pairs', () => {
    expect(resolvePairRule('BTCUSDT', 'long', pairRules)).toEqual({
      skip: false,
      entry: { useLimitOrderForEntry: true },
      matchedRuleIndex: 1,
    });
  });

  it('uses catch-all rule when no specific match', () => {
    expect(resolvePairRule('SOLUSDT', 'long', pairRules)).toEqual({
      skip: false,
      entry: { useLimitOrderForEntry: false },
      matchedRuleIndex: 2,
    });
  });

  it('returns no match when pairRules is empty', () => {
    expect(resolvePairRule('XAUUSD', 'short', undefined)).toEqual({ skip: false });
  });

  it('respects signalTypes on a rule', () => {
    const rules = [
      {
        pairs: ['ETHUSDT'],
        signalTypes: ['long' as const],
        skip: true,
      },
    ];
    expect(resolvePairRule('ETHUSDT', 'short', rules)).toEqual({ skip: false });
    expect(resolvePairRule('ETHUSDT', 'long', rules)).toEqual({
      skip: true,
      entry: undefined,
      matchedRuleIndex: 0,
    });
  });
});

describe('applyPairRulesToContext', () => {
  it('returns null when skip rule matches', () => {
    expect(
      applyPairRulesToContext(
        baseContext({
          pairRules: [{ pairs: ['XAUUSD'], skip: true }],
        }),
      ),
    ).toBeNull();
  });

  it('merges entry overrides onto channel defaults', () => {
    const merged = applyPairRulesToContext(
      baseContext({
        order: {
          ...baseContext().order,
          tradingPair: 'BTCUSDT',
        },
        useLimitOrderForEntry: false,
        useMarketRangeForEntry: true,
        maxSkippablePastTPs: 0,
        pairRules: [
          {
            pairs: ['BTCUSDT'],
            entry: { useLimitOrderForEntry: true },
          },
        ],
      }),
    );

    expect(merged).toMatchObject({
      useLimitOrderForEntry: true,
      useMarketRangeForEntry: true,
      maxSkippablePastTPs: 0,
    });
  });
});
