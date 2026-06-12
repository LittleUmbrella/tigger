import { describe, expect, it } from 'vitest';
import {
  buildEvaluationConfig,
  findChannelSetConfig,
  resolveChannelEvalDefaults,
  resolvePropFirmsFromChannel,
} from '../channelEvalConfig.js';
import { BotConfig } from '../../types/config.js';

const botConfig = {
  accounts: [
    {
      name: 'ctrader_demo_2',
      exchange: 'ctrader',
      propFirms: [{ name: 'the5ers', initialBalance: 5000 }],
    },
  ],
  initiators: [{ name: 'ctrader', riskPercentage: 1, baseLeverage: 20 }],
  monitors: [
    {
      type: 'ctrader',
      entryTimeoutMinutes: 2880,
      dynamicBreakevenAfterTPs: true,
    },
  ],
  channels: [
    {
      channel: '2845421508',
      parser: 'dgfvip',
      initiator: 'ctrader',
      monitor: 'ctrader',
      riskPercentage: 1,
      baseLeverage: 20,
      entryTimeoutMinutes: 10,
      allowConcurrentSymbolTrades: true,
      useLimitOrderForEntry: true,
      tradeTolerance: { tp: 0.02 },
      maxSkippablePastTPs: 0,
      minRiskReward: 1.5,
      accountFilters: [{ accounts: ['ctrader_demo_2'], rules: {} }],
    },
    {
      channel: '2845421508',
      parser: 'dgfvip',
      initiator: 'bybit',
      monitor: 'bybit',
    },
  ],
} as BotConfig;

describe('channelEvalConfig', () => {
  it('finds ctrader row when monitor type specified for multi-initiator channel', () => {
    const row = findChannelSetConfig(botConfig, '2845421508', 'ctrader');
    expect(row?.initiator).toBe('ctrader');
    expect(row?.entryTimeoutMinutes).toBe(10);
  });

  it('resolves prop firms from account when channel has accountFilters', () => {
    const row = findChannelSetConfig(botConfig, '2845421508', 'ctrader')!;
    const resolved = resolvePropFirmsFromChannel(botConfig, row);
    expect(resolved.propFirms).toEqual([{ name: 'the5ers', initialBalance: 5000 }]);
    expect(resolved.initialBalance).toBe(5000);
  });

  it('resolves prop firms from initiator default account when no accountFilters', () => {
    const cfg = {
      ...botConfig,
      accounts: [
        {
          name: 'hyro_main',
          exchange: 'bybit',
          propFirms: [{ name: 'hyrotrader', initialBalance: 50000 }],
        },
      ],
      initiators: [{ name: 'bybit', riskPercentage: 1, accounts: ['hyro_main'] }],
      channels: [
        {
          channel: '999',
          parser: 'p',
          initiator: 'bybit',
          monitor: 'bybit',
        },
      ],
    } as BotConfig;
    const row = cfg.channels[0];
    const resolved = resolvePropFirmsFromChannel(cfg, row);
    expect(resolved.initialBalance).toBe(50000);
  });

  it('builds evaluation config mirroring channel settings', () => {
    const defaults = resolveChannelEvalDefaults(botConfig, '2845421508', 'ctrader');
    const config = buildEvaluationConfig(
      {
        channel: '2845421508',
        parser: 'dgfvip',
        propFirms: ['the5ers'],
        startDate: '2026-04-30',
        endDate: '2026-05-30',
      },
      defaults
    );

    expect(config.monitor.entryTimeoutMinutes).toBe(10);
    expect(config.allowConcurrentSymbolTrades).toBe(true);
    expect(config.useLimitOrderForEntry).toBe(true);
    expect(config.tradeTolerance).toEqual({ tp: 0.02 });
    expect(config.initiator.riskPercentage).toBe(1);
    expect(config.minRiskReward).toBe(1.5);
    expect(config.initiator.baseLeverage).toBe(20);
    expect(config.initialBalance).toBe(5000);
    expect(config.monitor.dynamicBreakevenAfterTPs).toBe(true);
  });

  it('CLI overrides beat channel defaults', () => {
    const defaults = resolveChannelEvalDefaults(botConfig, '2845421508', 'ctrader');
    const config = buildEvaluationConfig(
      {
        channel: '2845421508',
        parser: 'dgfvip',
        propFirms: ['the5ers'],
        entryTimeoutMinutes: 30,
        allowConcurrentSymbolTrades: false,
        minRiskReward: 2,
      },
      defaults
    );

    expect(config.monitor.entryTimeoutMinutes).toBe(30);
    expect(config.allowConcurrentSymbolTrades).toBe(false);
    expect(config.minRiskReward).toBe(2);
  });
});
