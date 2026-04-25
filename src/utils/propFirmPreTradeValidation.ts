import { PropFirmRule, getPropFirmRule, createCustomPropFirmRule } from '../evaluation/propFirmRules.js';
import { DatabaseManager } from '../db/schema.js';
import { CustomPropFirmConfig } from '../types/config.js';
import { logger } from './logger.js';
import {
  calculatePotentialLoss,
  loadCompletedTradesForAccount,
  loadCompletedTradesForChannel,
  buildDailyPnLMap,
  projectRunningBalanceAndPeak,
  projectTodayRealizedPnLAndPeak,
  getUtcTodayString,
} from './risk.js';

/**
 * Result of pre-trade prop firm validation
 */
export interface PreTradeValidationResult {
  allowed: boolean;
  violations: string[];
  propFirmName: string;
}

/**
 * Resolve the challenge initial balance for a prop firm config.
 * For drawdown %, we use the challenge starting capital (e.g. $10k), NOT the current exchange balance.
 */
function resolveChallengeInitialBalance(
  propFirmConfig: string | CustomPropFirmConfig
): number {
  if (typeof propFirmConfig === 'string') {
    const rule = getPropFirmRule(propFirmConfig);
    return rule?.initialBalance ?? 10000;
  }
  return propFirmConfig.initialBalance ?? getPropFirmRule(propFirmConfig.name)?.initialBalance ?? 10000;
}

/**
 * Check if a trade would violate prop firm rules if it resulted in total loss
 *
 * @param currentBalanceFromExchange - When provided (live trading), use as source of truth for current balance.
 *   Prop firm drawdown % is always calculated against the challenge initial balance (e.g. $10k), not current balance.
 * @param quantity - Size in **base units** for P&L: Bybit linear = coin qty; cTrader = units per
 *   `calculatePotentialLoss` (e.g. oz for gold) = **lots × (lotSize/100)**, not raw API lots.
 * @param settlementAccountName - When set (e.g. Bybit `account_name` / cTrader account), use **all** completed trades
 *   for that settlement account to build peak & daily P&L, so the projection matches exchange equity instead of
 *   mixing one channel's P&L path with a whole-account balance.
 */
export async function validateTradeAgainstPropFirms(
  db: DatabaseManager,
  channel: string,
  propFirmConfigs: (string | CustomPropFirmConfig)[],
  entryPrice: number,
  stopLoss: number,
  quantity: number,
  leverage: number,
  additionalWorstCaseLoss: number = 0,
  dayStartBalance: number | undefined = undefined,
  currentBalanceFromExchange?: number,
  settlementAccountName?: string
): Promise<PreTradeValidationResult[]> {
  const results: PreTradeValidationResult[] = [];

  // Calculate potential loss
  const potentialLoss = calculatePotentialLoss(entryPrice, stopLoss, quantity);
  const totalWorstCaseLoss = potentialLoss + additionalWorstCaseLoss;

  let completedTrades =
    settlementAccountName !== undefined && settlementAccountName !== ''
      ? await loadCompletedTradesForAccount(db, settlementAccountName)
      : await loadCompletedTradesForChannel(db, channel);
  if (settlementAccountName && completedTrades.length === 0) {
    completedTrades = await loadCompletedTradesForChannel(db, channel);
  }
  const dailyPnLAll = buildDailyPnLMap(completedTrades);

  // Validate against each prop firm
  for (const propFirmConfig of propFirmConfigs) {
    let rule: PropFirmRule | null = null;

    if (typeof propFirmConfig === 'string') {
      rule = getPropFirmRule(propFirmConfig);
    } else {
      // Start from the named preset (if it exists) so constraints like maxDrawdown,
      // dailyDrawdown, maxRiskPerTrade etc. are inherited even when the config only
      // overrides initialBalance.  Only explicitly-provided fields win over the preset.
      const baseRule = getPropFirmRule(propFirmConfig.name);

      const overrides: Partial<PropFirmRule> = {};
      if (propFirmConfig.initialBalance !== undefined) overrides.initialBalance = propFirmConfig.initialBalance;
      if (propFirmConfig.displayName !== undefined)    overrides.displayName = propFirmConfig.displayName;
      if (propFirmConfig.profitTarget !== undefined)    overrides.profitTarget = propFirmConfig.profitTarget;
      if (propFirmConfig.maxDrawdown !== undefined)     overrides.maxDrawdown = propFirmConfig.maxDrawdown;
      if (propFirmConfig.maxDrawdownMode !== undefined) overrides.maxDrawdownMode = propFirmConfig.maxDrawdownMode;
      if (propFirmConfig.dailyDrawdown !== undefined)   overrides.dailyDrawdown = propFirmConfig.dailyDrawdown;
      if (propFirmConfig.dailyDrawdownMode !== undefined) overrides.dailyDrawdownMode = propFirmConfig.dailyDrawdownMode;
      if (propFirmConfig.minTradingDays !== undefined)   overrides.minTradingDays = propFirmConfig.minTradingDays;
      if (propFirmConfig.minTradesPerDay !== undefined)  overrides.minTradesPerDay = propFirmConfig.minTradesPerDay;
      if (propFirmConfig.maxRiskPerTrade !== undefined)  overrides.maxRiskPerTrade = propFirmConfig.maxRiskPerTrade;
      if (propFirmConfig.stopLossRequired !== undefined) overrides.stopLossRequired = propFirmConfig.stopLossRequired;
      if (propFirmConfig.stopLossTimeLimit !== undefined) overrides.stopLossTimeLimit = propFirmConfig.stopLossTimeLimit;
      if (propFirmConfig.maxProfitPerDay !== undefined)  overrides.maxProfitPerDay = propFirmConfig.maxProfitPerDay;
      if (propFirmConfig.maxProfitPerTrade !== undefined) overrides.maxProfitPerTrade = propFirmConfig.maxProfitPerTrade;
      if (propFirmConfig.minTradeDuration !== undefined) overrides.minTradeDuration = propFirmConfig.minTradeDuration;
      if (propFirmConfig.maxShortTradesPercentage !== undefined) overrides.maxShortTradesPercentage = propFirmConfig.maxShortTradesPercentage;
      if (propFirmConfig.reverseTradingAllowed !== undefined) overrides.reverseTradingAllowed = propFirmConfig.reverseTradingAllowed;
      if (propFirmConfig.reverseTradingTimeLimit !== undefined) overrides.reverseTradingTimeLimit = propFirmConfig.reverseTradingTimeLimit;
      if (propFirmConfig.customRules !== undefined)     overrides.customRules = propFirmConfig.customRules;

      if (baseRule) {
        rule = { ...baseRule, ...overrides };
      } else {
        rule = createCustomPropFirmRule(
          propFirmConfig.name,
          propFirmConfig.displayName || propFirmConfig.name,
          {
            initialBalance: propFirmConfig.initialBalance ?? resolveChallengeInitialBalance(propFirmConfig),
            ...overrides,
          }
        );
      }
    }

    if (!rule) {
      logger.warn('Invalid prop firm configuration in pre-trade validation', {
        channel,
        propFirm: typeof propFirmConfig === 'string' ? propFirmConfig : propFirmConfig.name
      });
      continue;
    }

    const { currentBalance: dbBalanceForRule, peakBalance: peakFromTrades } =
      projectRunningBalanceAndPeak(completedTrades, rule.initialBalance);
    const currentBalance = currentBalanceFromExchange ?? dbBalanceForRule;

    const violations: string[] = [];

    // Check maxRiskPerTrade rule
    if (rule.maxRiskPerTrade !== undefined) {
      const maxRiskAmount = (rule.maxRiskPerTrade / 100) * rule.initialBalance;
      if (potentialLoss > maxRiskAmount) {
        violations.push(
          `Trade risk (${potentialLoss.toFixed(2)} USDT) exceeds maximum risk per trade (${maxRiskAmount.toFixed(2)} USDT, ${rule.maxRiskPerTrade}% of initial balance)`
        );
      }
    }

    // Check stopLossRequired rule
    if (rule.stopLossRequired && (!stopLoss || stopLoss <= 0)) {
      violations.push('Stop loss is required but not provided');
    }

    // Simulate the trade as a total loss and check drawdown rules
    const simulatedBalance = currentBalance - totalWorstCaseLoss;
    const simulatedPeakBalance = Math.max(peakFromTrades, currentBalance);

    // Check maxDrawdown rule (drawdown % is vs challenge initial balance, e.g. $10k)
    if (rule.maxDrawdown !== undefined) {
      const maxDrawdownMode = rule.maxDrawdownMode ?? 'trailing';
      const drawdown = maxDrawdownMode === 'static'
        ? Math.max(0, rule.initialBalance - simulatedBalance)
        : simulatedPeakBalance - simulatedBalance;
      const drawdownPercentage = (drawdown / rule.initialBalance) * 100;

      if (drawdownPercentage > rule.maxDrawdown) {
        if (maxDrawdownMode === 'static') {
          const staticFloor = rule.initialBalance * (1 - rule.maxDrawdown / 100);
          violations.push(
            `Trade would cause maximum drawdown violation: ${drawdownPercentage.toFixed(2)}% > ${rule.maxDrawdown}% (mode: static, floor: ${staticFloor.toFixed(2)}, challenge initial: ${rule.initialBalance}, current balance: ${currentBalance.toFixed(2)}, simulated balance: ${simulatedBalance.toFixed(2)})`
          );
        } else {
          violations.push(
            `Trade would cause maximum drawdown violation: ${drawdownPercentage.toFixed(2)}% > ${rule.maxDrawdown}% (mode: trailing, peak equity: ${simulatedPeakBalance.toFixed(2)}, challenge initial: ${rule.initialBalance}, current balance: ${currentBalance.toFixed(2)}, simulated balance: ${simulatedBalance.toFixed(2)})`
          );
        }
      }
    }

    // Check dailyDrawdown rule
    if (rule.dailyDrawdown !== undefined) {
      const today = getUtcTodayString();

      const currentDailyPnL = dailyPnLAll.get(today) || 0;
      const simulatedDailyPnL = currentDailyPnL - totalWorstCaseLoss;
      const dailyLimitAmount = (rule.dailyDrawdown / 100) * rule.initialBalance;
      const dailyDrawdownMode = rule.dailyDrawdownMode ?? 'trailing';
      const inferredDayStartEquity = currentBalance - currentDailyPnL;
      const dayStartEquity = dayStartBalance ?? inferredDayStartEquity;

      if (dailyDrawdownMode === 'swing') {
        const dailyFloor = dayStartEquity - dailyLimitAmount;
        if (simulatedBalance <= dailyFloor) {
          violations.push(
            `Trade would cause daily drawdown violation: simulated equity ${simulatedBalance.toFixed(2)} <= floor ${dailyFloor.toFixed(2)} (mode: swing, day start equity: ${dayStartEquity.toFixed(2)}, daily limit: ${dailyLimitAmount.toFixed(2)} = ${rule.dailyDrawdown}% of initial balance ${rule.initialBalance})`
          );
        }
      } else if (dailyDrawdownMode === 'trailing') {
        const { realizedPeakPnL } = projectTodayRealizedPnLAndPeak(completedTrades, today);
        const realizedPeakEquity = dayStartEquity + realizedPeakPnL;
        const intradayPeakEquity = Math.max(dayStartEquity, realizedPeakEquity, currentBalance);
        const trailingDailyFloor = intradayPeakEquity - dailyLimitAmount;
        if (simulatedBalance <= trailingDailyFloor) {
          violations.push(
            `Trade would cause daily drawdown violation: simulated equity ${simulatedBalance.toFixed(2)} <= floor ${trailingDailyFloor.toFixed(2)} (mode: trailing, intraday peak equity: ${intradayPeakEquity.toFixed(2)}, daily limit: ${dailyLimitAmount.toFixed(2)} = ${rule.dailyDrawdown}% of initial balance ${rule.initialBalance})`
          );
        }
      } else {
        const dayStartPercentLimit = (rule.dailyDrawdown / 100) * dayStartEquity;
        if (simulatedDailyPnL < -dayStartPercentLimit) {
          violations.push(
            `Trade would cause daily drawdown violation: ${simulatedDailyPnL.toFixed(2)} USDT < -${dayStartPercentLimit.toFixed(2)} USDT (mode: dayStartPercent, daily limit: ${rule.dailyDrawdown}% of day start equity ${dayStartEquity.toFixed(2)})`
          );
        }
      }
    }

    results.push({
      allowed: violations.length === 0,
      violations,
      propFirmName: rule.displayName
    });
  }

  return results;
}
