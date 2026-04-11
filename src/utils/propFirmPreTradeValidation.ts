import { PropFirmRule, getPropFirmRule, createCustomPropFirmRule } from '../evaluation/propFirmRules.js';
import { Trade, DatabaseManager } from '../db/schema.js';
import { CustomPropFirmConfig } from '../types/config.js';
import { logger } from './logger.js';
import dayjs from 'dayjs';

const toUtcDateString = (iso: string): string => {
  // toISOString() is always UTC; slice(0, 10) -> YYYY-MM-DD
  return new Date(iso).toISOString().slice(0, 10);
};

const getUtcTodayString = (): string => {
  return new Date().toISOString().slice(0, 10);
};

/**
 * Result of pre-trade prop firm validation
 */
export interface PreTradeValidationResult {
  allowed: boolean;
  violations: string[];
  propFirmName: string;
}

/**
 * Calculate potential loss if trade hits stop loss
 */
function calculatePotentialLoss(
  entryPrice: number,
  stopLoss: number,
  quantity: number
): number {
  if (!stopLoss || stopLoss <= 0) {
    // No stop loss means unlimited risk - this would violate maxRiskPerTrade if that rule exists
    return Infinity;
  }
  
  const priceDiff = Math.abs(entryPrice - stopLoss);
  return priceDiff * quantity;
}

/**
 * Load completed channel trades once (used to project peak / daily PnL per challenge initial balance).
 */
async function loadCompletedTradesForChannel(
  db: DatabaseManager,
  channel: string
): Promise<Trade[]> {
  const allTrades = await db.getActiveTrades();
  const closedTrades = await db.getClosedTrades();
  const channelTrades = [...allTrades, ...closedTrades].filter(t => t.channel === channel);
  return channelTrades.filter(
    t => t.status === 'closed' || t.status === 'stopped' || t.status === 'completed'
  );
}

/**
 * Daily realized PnL by UTC date — independent of challenge starting balance.
 */
function buildDailyPnLMap(completedTrades: Trade[]): Map<string, number> {
  const dailyPnL = new Map<string, number>();
  for (const trade of completedTrades) {
    if (trade.pnl !== undefined && trade.exit_filled_at) {
      const tradeDate = toUtcDateString(trade.exit_filled_at);
      const currentDailyPnL = dailyPnL.get(tradeDate) || 0;
      dailyPnL.set(tradeDate, currentDailyPnL + trade.pnl);
    }
  }
  return dailyPnL;
}

/**
 * Peak equity and DB-derived balance for a given challenge initial balance.
 * Must use the same `challengeInitialBalance` as `rule.initialBalance` for max drawdown %.
 */
function projectRunningBalanceAndPeak(
  completedTrades: Trade[],
  challengeInitialBalance: number
): { currentBalance: number; peakBalance: number } {
  let runningBalance = challengeInitialBalance;
  let peakBalance = challengeInitialBalance;

  const sortedTrades = [...completedTrades].sort((a, b) => {
    const timeA = a.exit_filled_at ? dayjs(a.exit_filled_at).valueOf() : dayjs(a.created_at).valueOf();
    const timeB = b.exit_filled_at ? dayjs(b.exit_filled_at).valueOf() : dayjs(b.created_at).valueOf();
    return timeA - timeB;
  });

  for (const trade of sortedTrades) {
    if (trade.pnl !== undefined && trade.exit_filled_at) {
      runningBalance += trade.pnl;
      if (runningBalance > peakBalance) {
        peakBalance = runningBalance;
      }
    }
  }

  return { currentBalance: runningBalance, peakBalance };
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
 */
export async function validateTradeAgainstPropFirms(
  db: DatabaseManager,
  channel: string,
  propFirmConfigs: (string | CustomPropFirmConfig)[],
  initialBalance: number,
  entryPrice: number,
  stopLoss: number,
  quantity: number,
  leverage: number,
  additionalWorstCaseLoss: number = 0,
  dayStartBalance: number | undefined = undefined,
  currentBalanceFromExchange?: number
): Promise<PreTradeValidationResult[]> {
  const results: PreTradeValidationResult[] = [];
  
  // Calculate potential loss
  const potentialLoss = calculatePotentialLoss(entryPrice, stopLoss, quantity);
  const totalWorstCaseLoss = potentialLoss + additionalWorstCaseLoss;

  const completedTrades = await loadCompletedTradesForChannel(db, channel);
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
      if (propFirmConfig.dailyDrawdown !== undefined)   overrides.dailyDrawdown = propFirmConfig.dailyDrawdown;
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
      const drawdown = simulatedPeakBalance - simulatedBalance;
      const drawdownPercentage = (drawdown / rule.initialBalance) * 100;
      
      if (drawdownPercentage > rule.maxDrawdown) {
        violations.push(
          `Trade would cause maximum drawdown violation: ${drawdownPercentage.toFixed(2)}% > ${rule.maxDrawdown}% (peak equity: ${simulatedPeakBalance.toFixed(2)}, challenge initial: ${rule.initialBalance}, current balance: ${currentBalance.toFixed(2)}, simulated balance: ${simulatedBalance.toFixed(2)})`
        );
      }
    }
    
    // Check dailyDrawdown rule
    if (rule.dailyDrawdown !== undefined) {
      const today = getUtcTodayString();
      
      const currentDailyPnL = dailyPnLAll.get(today) || 0;
      const simulatedDailyPnL = currentDailyPnL - totalWorstCaseLoss;

      const dailyDrawdownLimit = rule.dailyDrawdownMode === 'swing'
        ? (rule.dailyDrawdown / 100) * (dayStartBalance ?? rule.initialBalance)
        : (rule.dailyDrawdown / 100) * (
            dailyPnLAll.has(today)
              ? currentBalance - (dailyPnLAll.get(today) || 0)
              : currentBalance
          );
      
      if (simulatedDailyPnL < -dailyDrawdownLimit) {
        violations.push(
          `Trade would cause daily drawdown violation: ${simulatedDailyPnL.toFixed(2)} USDT < -${dailyDrawdownLimit.toFixed(2)} USDT (daily limit: ${rule.dailyDrawdown}% of day start balance)`
        );
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

