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
 * Build account state from existing trades for a channel
 */
async function buildAccountState(
  db: DatabaseManager,
  channel: string,
  initialBalance: number
): Promise<{
  currentBalance: number;
  peakBalance: number;
  dailyPnL: Map<string, number>;
  trades: Trade[];
  openTrades: Trade[];
}> {
  // Get all trades for this channel
  const allTrades = await db.getActiveTrades();
  const closedTrades = await db.getClosedTrades();
  
  const channelTrades = [...allTrades, ...closedTrades].filter(t => t.channel === channel);
  
  // Separate closed and open trades
  const completedTrades = channelTrades.filter(t => 
    t.status === 'closed' || t.status === 'stopped' || t.status === 'completed'
  );
  const openTrades = channelTrades.filter(t => 
    t.status === 'active' || t.status === 'filled'
  );
  
  // Calculate current balance from completed trades
  let currentBalance = initialBalance;
  let runningBalance = initialBalance;
  let peakBalance = initialBalance;
  const dailyPnL = new Map<string, number>();
  
  // Sort trades chronologically by exit time (or created_at if no exit)
  const sortedTrades = [...completedTrades].sort((a, b) => {
    const timeA = a.exit_filled_at ? dayjs(a.exit_filled_at).valueOf() : dayjs(a.created_at).valueOf();
    const timeB = b.exit_filled_at ? dayjs(b.exit_filled_at).valueOf() : dayjs(b.created_at).valueOf();
    return timeA - timeB;
  });
  
  // Process trades chronologically to track peak balance correctly
  for (const trade of sortedTrades) {
    if (trade.pnl !== undefined && trade.exit_filled_at) {
      runningBalance += trade.pnl;
      
      // Update peak balance if we've reached a new high
      if (runningBalance > peakBalance) {
        peakBalance = runningBalance;
      }
      
      // Track daily P&L
      const tradeDate = toUtcDateString(trade.exit_filled_at);
      const currentDailyPnL = dailyPnL.get(tradeDate) || 0;
      dailyPnL.set(tradeDate, currentDailyPnL + trade.pnl);
    }
  }
  
  // Set current balance to the running balance after processing all trades
  currentBalance = runningBalance;
  
  return {
    currentBalance,
    peakBalance,
    dailyPnL,
    trades: completedTrades,
    openTrades
  };
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
  
  // Challenge initial balance for drawdown % (e.g. $10k for Hyrotrader) - NOT current exchange balance
  const challengeInitialBalance = propFirmConfigs.length > 0
    ? resolveChallengeInitialBalance(propFirmConfigs[0])
    : initialBalance;
  
  // Build account state from trades (peak balance, daily PnL). Use challenge initial for consistency.
  const accountState = await buildAccountState(db, channel, challengeInitialBalance);
  
  // For live trading: exchange balance is source of truth. Otherwise use DB-derived balance.
  const currentBalance = currentBalanceFromExchange ?? accountState.currentBalance;
  
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
    const simulatedPeakBalance = Math.max(accountState.peakBalance, currentBalance);
    
    // Check maxDrawdown rule (drawdown % is vs challenge initial balance, e.g. $10k)
    if (rule.maxDrawdown !== undefined) {
      const drawdown = simulatedPeakBalance - simulatedBalance;
      const drawdownPercentage = (drawdown / rule.initialBalance) * 100;
      
      if (drawdownPercentage > rule.maxDrawdown) {
        violations.push(
          `Trade would cause maximum drawdown violation: ${drawdownPercentage.toFixed(2)}% > ${rule.maxDrawdown}% (current balance: ${currentBalance.toFixed(2)}, simulated balance: ${simulatedBalance.toFixed(2)})`
        );
      }
    }
    
    // Check dailyDrawdown rule
    if (rule.dailyDrawdown !== undefined) {
      const today = getUtcTodayString();
      
      const currentDailyPnL = accountState.dailyPnL.get(today) || 0;
      const simulatedDailyPnL = currentDailyPnL - totalWorstCaseLoss;

      const dailyDrawdownLimit = rule.dailyDrawdownMode === 'swing'
        ? (rule.dailyDrawdown / 100) * (dayStartBalance ?? rule.initialBalance)
        : (rule.dailyDrawdown / 100) * (
            accountState.dailyPnL.has(today)
              ? currentBalance - (accountState.dailyPnL.get(today) || 0)
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

