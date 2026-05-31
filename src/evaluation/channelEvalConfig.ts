/**
 * Resolve evaluation defaults from config.json channel entries so wizard/CLI
 * mirror live bot settings (entry timeout, concurrent symbols, obfuscation, etc.).
 */

import fs from 'fs-extra';
import path from 'path';
import {
  BotConfig,
  ChannelSetConfig,
  CustomPropFirmConfig,
  EvaluationConfig,
  MonitorConfig,
} from '../types/config.js';

export interface ChannelEvalDefaults {
  parser?: string;
  monitorType?: 'bybit' | 'ctrader';
  riskPercentage?: number;
  baseLeverage?: number;
  entryTimeoutMinutes?: number;
  breakevenAfterTPs?: number;
  dynamicBreakevenAfterTPs?: boolean;
  propFirms?: (string | CustomPropFirmConfig)[];
  initialBalance?: number;
  tradeObfuscation?: EvaluationConfig['tradeObfuscation'];
  slAdjustmentTolerancePercent?: number;
  maxRisk?: number;
  allowConcurrentSymbolTrades?: boolean;
  useLimitOrderForEntry?: boolean;
  maxSkippablePastTPs?: number;
  useMarketRangeForEntry?: boolean;
  minRiskReward?: number;
}

const DEFAULT_CONFIG_PATH = 'config.json';

export const loadBotConfig = async (configPath?: string): Promise<BotConfig | null> => {
  const resolved = path.resolve(process.env.CONFIG_PATH || configPath || DEFAULT_CONFIG_PATH);
  if (!(await fs.pathExists(resolved))) {
    return null;
  }
  return (await fs.readJson(resolved)) as BotConfig;
};

export const findChannelSetConfig = (
  botConfig: BotConfig,
  channel: string,
  monitorType?: string
): ChannelSetConfig | undefined => {
  const matches = botConfig.channels.filter((c) => c.channel === channel);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  if (monitorType) {
    const byMonitor = matches.find((c) => c.monitor === monitorType || c.initiator === monitorType);
    if (byMonitor) return byMonitor;
  }

  return matches[0];
};

const resolveMonitorConfig = (
  botConfig: BotConfig,
  channelConfig: ChannelSetConfig
): MonitorConfig | undefined =>
  botConfig.monitors.find((m) => m.type === channelConfig.monitor);

const resolveInitiatorConfig = (botConfig: BotConfig, channelConfig: ChannelSetConfig) =>
  botConfig.initiators.find(
    (i) => i.name === channelConfig.initiator || i.type === channelConfig.initiator
  );

/** Prop firms + initial balance from channel row or first accountFilter account. */
export const resolvePropFirmsFromChannel = (
  botConfig: BotConfig,
  channelConfig: ChannelSetConfig
): { propFirms?: (string | CustomPropFirmConfig)[]; initialBalance?: number } => {
  if (channelConfig.propFirms?.length) {
    const first = channelConfig.propFirms[0];
    const initialBalance =
      typeof first === 'object' && first.initialBalance != null ? first.initialBalance : undefined;
    return { propFirms: channelConfig.propFirms, initialBalance };
  }

  const accountName = channelConfig.accountFilters?.[0]?.accounts?.[0];
  if (!accountName || !botConfig.accounts?.length) {
    return {};
  }

  const account = botConfig.accounts.find((a) => a.name === accountName);
  if (!account?.propFirms?.length) {
    return {};
  }

  const first = account.propFirms[0];
  const initialBalance =
    typeof first === 'object' && first.initialBalance != null ? first.initialBalance : undefined;
  return { propFirms: account.propFirms, initialBalance };
};

export const resolveChannelEvalDefaults = (
  botConfig: BotConfig,
  channel: string,
  monitorType?: string
): ChannelEvalDefaults | null => {
  const channelConfig = findChannelSetConfig(botConfig, channel, monitorType);
  if (!channelConfig) return null;

  const monitorConfig = resolveMonitorConfig(botConfig, channelConfig);
  const initiatorConfig = resolveInitiatorConfig(botConfig, channelConfig);
  const { propFirms, initialBalance } = resolvePropFirmsFromChannel(botConfig, channelConfig);

  const entryTimeoutMinutes =
    channelConfig.entryTimeoutMinutes ?? monitorConfig?.entryTimeoutMinutes;

  const channelMonitorType: 'bybit' | 'ctrader' | undefined =
    channelConfig.monitor === 'bybit' || channelConfig.monitor === 'ctrader'
      ? channelConfig.monitor
      : undefined;

  return {
    parser: channelConfig.parser,
    monitorType: channelMonitorType,
    riskPercentage: channelConfig.riskPercentage ?? initiatorConfig?.riskPercentage,
    baseLeverage: channelConfig.baseLeverage ?? initiatorConfig?.baseLeverage,
    entryTimeoutMinutes,
    breakevenAfterTPs: channelConfig.breakevenAfterTPs ?? monitorConfig?.breakevenAfterTPs,
    dynamicBreakevenAfterTPs:
      channelConfig.dynamicBreakevenAfterTPs ?? monitorConfig?.dynamicBreakevenAfterTPs,
    propFirms,
    initialBalance,
    tradeObfuscation: channelConfig.tradeObfuscation,
    slAdjustmentTolerancePercent: channelConfig.slAdjustmentTolerancePercent,
    maxRisk: channelConfig.maxRisk,
    allowConcurrentSymbolTrades: channelConfig.allowConcurrentSymbolTrades,
    useLimitOrderForEntry: channelConfig.useLimitOrderForEntry,
    maxSkippablePastTPs: channelConfig.maxSkippablePastTPs,
    useMarketRangeForEntry: channelConfig.useMarketRangeForEntry,
    minRiskReward: channelConfig.minRiskReward,
  };
};

export interface BuildEvaluationConfigInput {
  channel: string;
  parser: string;
  propFirms: (string | CustomPropFirmConfig)[];
  startDate?: string;
  endDate?: string;
  initialBalance?: number;
  riskPercentage?: number;
  baseLeverage?: number;
  monitorType?: 'bybit' | 'ctrader';
  entryTimeoutMinutes?: number;
  breakevenAfterTPs?: number;
  dynamicBreakevenAfterTPs?: boolean;
  tradeObfuscation?: EvaluationConfig['tradeObfuscation'];
  slAdjustmentTolerancePercent?: number;
  maxRisk?: number;
  allowConcurrentSymbolTrades?: boolean;
  useLimitOrderForEntry?: boolean;
  maxSkippablePastTPs?: number;
  useMarketRangeForEntry?: boolean;
  minRiskReward?: number;
  speedMultiplier?: number;
  maxTradeDurationDays?: number;
  ctraderUseTickData?: boolean;
  ctraderSymbolMap?: Record<string, string>;
}

/** Merge channel defaults with explicit overrides (CLI / wizard flags win when set). */
export const buildEvaluationConfig = (
  input: BuildEvaluationConfigInput,
  channelDefaults?: ChannelEvalDefaults | null
): EvaluationConfig => {
  const monitorType = input.monitorType ?? channelDefaults?.monitorType ?? 'bybit';
  const entryTimeoutMinutes =
    input.entryTimeoutMinutes ?? channelDefaults?.entryTimeoutMinutes ?? 2880;

  return {
    channel: input.channel,
    parser: input.parser,
    initiator: {
      name: 'evaluation',
      riskPercentage: input.riskPercentage ?? channelDefaults?.riskPercentage ?? 3,
      baseLeverage: input.baseLeverage ?? channelDefaults?.baseLeverage,
      testnet: false,
    },
    monitor: {
      type: monitorType,
      testnet: false,
      pollInterval: 10000,
      entryTimeoutMinutes,
      breakevenAfterTPs: input.breakevenAfterTPs ?? channelDefaults?.breakevenAfterTPs ?? 1,
      dynamicBreakevenAfterTPs:
        input.dynamicBreakevenAfterTPs ?? channelDefaults?.dynamicBreakevenAfterTPs ?? false,
      ctraderUseTickData: input.ctraderUseTickData,
      ctraderSymbolMap: input.ctraderSymbolMap,
    },
    propFirms: input.propFirms,
    initialBalance: input.initialBalance ?? channelDefaults?.initialBalance ?? 10000,
    startDate: input.startDate,
    endDate: input.endDate,
    speedMultiplier: input.speedMultiplier ?? 0,
    maxTradeDurationDays: input.maxTradeDurationDays ?? 7,
    tradeObfuscation: input.tradeObfuscation ?? channelDefaults?.tradeObfuscation,
    slAdjustmentTolerancePercent:
      input.slAdjustmentTolerancePercent ?? channelDefaults?.slAdjustmentTolerancePercent,
    maxRisk: input.maxRisk ?? channelDefaults?.maxRisk,
    allowConcurrentSymbolTrades:
      input.allowConcurrentSymbolTrades ?? channelDefaults?.allowConcurrentSymbolTrades,
    useLimitOrderForEntry: input.useLimitOrderForEntry ?? channelDefaults?.useLimitOrderForEntry,
    maxSkippablePastTPs: input.maxSkippablePastTPs ?? channelDefaults?.maxSkippablePastTPs,
    useMarketRangeForEntry:
      input.useMarketRangeForEntry ?? channelDefaults?.useMarketRangeForEntry,
    minRiskReward: input.minRiskReward ?? channelDefaults?.minRiskReward,
  };
};

export const formatChannelEvalDefaultsSummary = (defaults: ChannelEvalDefaults): string => {
  const parts: string[] = [];
  if (defaults.parser) parts.push(`parser=${defaults.parser}`);
  if (defaults.monitorType) parts.push(`monitor=${defaults.monitorType}`);
  if (defaults.riskPercentage != null) parts.push(`risk=${defaults.riskPercentage}%`);
  if (defaults.minRiskReward != null) parts.push(`minRR=${defaults.minRiskReward}`);
  if (defaults.baseLeverage != null) parts.push(`leverage=${defaults.baseLeverage}`);
  if (defaults.entryTimeoutMinutes != null) {
    parts.push(`entryTimeout=${defaults.entryTimeoutMinutes}m`);
  }
  if (defaults.allowConcurrentSymbolTrades) parts.push('allowConcurrentSymbolTrades=true');
  if (defaults.useLimitOrderForEntry != null) {
    parts.push(`useLimitOrderForEntry=${defaults.useLimitOrderForEntry}`);
  }
  if (defaults.tradeObfuscation) parts.push(`tradeObfuscation=${JSON.stringify(defaults.tradeObfuscation)}`);
  if (defaults.propFirms?.length) {
    const names = defaults.propFirms.map((f) => (typeof f === 'string' ? f : f.name)).join(',');
    parts.push(`propFirms=${names}`);
  }
  if (defaults.initialBalance != null) parts.push(`initialBalance=${defaults.initialBalance}`);
  return parts.join(', ');
};
