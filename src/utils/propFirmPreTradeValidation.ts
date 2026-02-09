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
 * Check if a trade would violate prop firm rules if it resulted in total loss
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
  dayStartBalance: number | undefined = undefined
): Promise<PreTradeValidationResult[]> {
  const results: PreTradeValidationResult[] = [];
  
  // Calculate potential loss
  const potentialLoss = calculatePotentialLoss(entryPrice, stopLoss, quantity);
  const totalWorstCaseLoss = potentialLoss + additionalWorstCaseLoss;
  
  // Build current account state
  const accountState = await buildAccountState(db, channel, initialBalance);
  
  // Validate against each prop firm
  for (const propFirmConfig of propFirmConfigs) {
    let rule: PropFirmRule | null = null;
    
    if (typeof propFirmConfig === 'string') {
      // Predefined prop firm
      rule = getPropFirmRule(propFirmConfig, {
        initialBalance
      });
    } else {
      // Custom prop firm configuration
      rule = createCustomPropFirmRule(
        propFirmConfig.name,
        propFirmConfig.displayName || propFirmConfig.name,
        {
          initialBalance: propFirmConfig.initialBalance || initialBalance,
          profitTarget: propFirmConfig.profitTarget,
          maxDrawdown: propFirmConfig.maxDrawdown,
          dailyDrawdown: propFirmConfig.dailyDrawdown,
          minTradingDays: propFirmConfig.minTradingDays,
          minTradesPerDay: propFirmConfig.minTradesPerDay,
          maxRiskPerTrade: propFirmConfig.maxRiskPerTrade,
          stopLossRequired: propFirmConfig.stopLossRequired,
          stopLossTimeLimit: propFirmConfig.stopLossTimeLimit,
          maxProfitPerDay: propFirmConfig.maxProfitPerDay,
          maxProfitPerTrade: propFirmConfig.maxProfitPerTrade,
          minTradeDuration: propFirmConfig.minTradeDuration,
          maxShortTradesPercentage: propFirmConfig.maxShortTradesPercentage,
          reverseTradingAllowed: propFirmConfig.reverseTradingAllowed,
          reverseTradingTimeLimit: propFirmConfig.reverseTradingTimeLimit,
          customRules: propFirmConfig.customRules,
        }
      );
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
    const simulatedBalance = accountState.currentBalance - totalWorstCaseLoss;
    const simulatedPeakBalance = Math.max(accountState.peakBalance, accountState.currentBalance);
    
    // Check maxDrawdown rule
    if (rule.maxDrawdown !== undefined) {
      const drawdown = simulatedPeakBalance - simulatedBalance;
      const drawdownPercentage = (drawdown / rule.initialBalance) * 100;
      
      if (drawdownPercentage > rule.maxDrawdown) {
        violations.push(
          `Trade would cause maximum drawdown violation: ${drawdownPercentage.toFixed(2)}% > ${rule.maxDrawdown}% (current balance: ${accountState.currentBalance.toFixed(2)}, simulated balance: ${simulatedBalance.toFixed(2)})`
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
              ? accountState.currentBalance - (accountState.dailyPnL.get(today) || 0)
              : accountState.currentBalance
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

