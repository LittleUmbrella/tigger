import { PropFirmRule } from './propFirmRules.js';
import { Trade, Order, DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';

/**
 * Account state for prop firm evaluation
 */
export interface AccountState {
  initialBalance: number;
  currentBalance: number;
  equity: number; // Current equity (balance + unrealized P&L)
  peakBalance: number; // Highest balance reached
  dailyPnL: Map<string, number>; // Date -> P&L for that day
  dailyTrades: Map<string, number>; // Date -> number of trades closed that day
  tradingDays: Set<string>; // Set of dates with at least one closed trade
  trades: Trade[]; // All trades
  openTrades: Trade[]; // Currently open trades
  violations: EvaluationViolation[]; // Rule violations
}

/**
 * Evaluation violation
 */
export interface EvaluationViolation {
  rule: string;
  message: string;
  timestamp: string;
  severity: 'warning' | 'error';
  details?: Record<string, any>;
}

/**
 * Evaluation result
 */
export interface EvaluationResult {
  propFirmName: string;
  passed: boolean;
  violations: EvaluationViolation[];
  metrics: {
    initialBalance: number;
    finalBalance: number;
    totalPnL: number;
    totalPnLPercentage: number;
    maxDrawdown: number;
    maxDrawdownPercentage: number;
    peakBalance: number;
    tradingDays: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
  };
  startDate: string;
  endDate: string;
}

export interface PropFirmEvaluator {
  addTrade: (trade: Trade) => void;
  updateEquity: (openTradesUnrealizedPnL: number) => void;
  evaluate: () => Promise<EvaluationResult>;
}

// Evaluation helper functions
function evaluateProfitTarget(rule: PropFirmRule, accountState: AccountState): void {
  if (rule.profitTarget === undefined) return;

  const totalPnLPercentage = ((accountState.currentBalance - accountState.initialBalance) / accountState.initialBalance) * 100;

  if (totalPnLPercentage < rule.profitTarget) {
    accountState.violations.push({
      rule: 'profitTarget',
      message: `Profit target not met: ${totalPnLPercentage.toFixed(2)}% < ${rule.profitTarget}%`,
      timestamp: new Date().toISOString(),
      severity: 'error',
      details: {
        current: totalPnLPercentage,
        required: rule.profitTarget,
      },
    });
  }
}

function evaluateMaxDrawdown(rule: PropFirmRule, accountState: AccountState): void {
  if (rule.maxDrawdown === undefined) return;

  // Calculate max drawdown by tracking peak balance chronologically
  let runningBalance = accountState.initialBalance;
  let peakBalance = accountState.initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPercentage = 0;

  // Sort trades chronologically by exit time
  const sortedTrades = [...accountState.trades].sort((a, b) => {
    const timeA = a.exit_filled_at ? dayjs(a.exit_filled_at).valueOf() : 0;
    const timeB = b.exit_filled_at ? dayjs(b.exit_filled_at).valueOf() : 0;
    return timeA - timeB;
  });

  for (const trade of sortedTrades) {
    if (trade.pnl !== undefined) {
      runningBalance += trade.pnl;
      // Update peak balance if we've reached a new high
      if (runningBalance > peakBalance) {
        peakBalance = runningBalance;
      }
      // Calculate drawdown from current peak
      const drawdown = peakBalance - runningBalance;
      const drawdownPercentage = (drawdown / accountState.initialBalance) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercentage = drawdownPercentage;
      }
    }
  }

  // Also check current balance if there are open trades
  if (accountState.currentBalance < peakBalance) {
    const currentDrawdown = peakBalance - accountState.currentBalance;
    const currentDrawdownPercentage = (currentDrawdown / accountState.initialBalance) * 100;
    if (currentDrawdown > maxDrawdown) {
      maxDrawdown = currentDrawdown;
      maxDrawdownPercentage = currentDrawdownPercentage;
    }
  }

  if (maxDrawdownPercentage > rule.maxDrawdown) {
    accountState.violations.push({
      rule: 'maxDrawdown',
      message: `Maximum drawdown exceeded: ${maxDrawdownPercentage.toFixed(2)}% > ${rule.maxDrawdown}%`,
      timestamp: new Date().toISOString(),
      severity: 'error',
      details: {
        current: maxDrawdownPercentage,
        limit: rule.maxDrawdown,
      },
    });
  }
}

function evaluateDailyDrawdown(rule: PropFirmRule, accountState: AccountState): void {
  if (rule.dailyDrawdown === undefined) return;

  // Calculate balance at the start of each day to properly calculate daily drawdown limits
  // Daily drawdown should be relative to the balance at the START of the day, not initial balance
  const sortedTrades = [...accountState.trades].sort((a, b) => {
    const timeA = a.exit_filled_at ? dayjs(a.exit_filled_at).valueOf() : 0;
    const timeB = b.exit_filled_at ? dayjs(b.exit_filled_at).valueOf() : 0;
    return timeA - timeB;
  });

  // Track balance by date to find starting balance for each day
  const balanceByDate = new Map<string, number>();
  let runningBalance = accountState.initialBalance;

  // First pass: calculate balance at start of each trading day
  for (const trade of sortedTrades) {
    if (trade.exit_filled_at && trade.pnl !== undefined) {
      const tradeDate = dayjs(trade.exit_filled_at).format('YYYY-MM-DD');
      // Store balance at start of day (before this trade's P&L is applied)
      if (!balanceByDate.has(tradeDate)) {
        balanceByDate.set(tradeDate, runningBalance);
      }
      runningBalance += trade.pnl;
    }
  }

  // Second pass: check daily drawdown violations
  for (const [date, dailyPnL] of accountState.dailyPnL.entries()) {
    // Get balance at start of this day (default to initial balance if no trades before this day)
    const dayStartBalance = balanceByDate.get(date) || accountState.initialBalance;
    const dailyDrawdownLimit = (rule.dailyDrawdown / 100) * dayStartBalance;

    if (dailyPnL < -dailyDrawdownLimit) {
      accountState.violations.push({
        rule: 'dailyDrawdown',
        message: `Daily drawdown exceeded on ${date}: ${dailyPnL.toFixed(2)} USDT < -${dailyDrawdownLimit.toFixed(2)} USDT`,
        timestamp: new Date().toISOString(),
        severity: 'error',
        details: {
          date,
          dailyPnL,
          dayStartBalance,
          limit: -dailyDrawdownLimit,
        },
      });
    }
  }
}

function evaluateMinTradingDays(rule: PropFirmRule, accountState: AccountState): void {
  if (rule.minTradingDays === undefined) return;

  if (accountState.tradingDays.size < rule.minTradingDays) {
    accountState.violations.push({
      rule: 'minTradingDays',
      message: `Minimum trading days not met: ${accountState.tradingDays.size} < ${rule.minTradingDays}`,
      timestamp: new Date().toISOString(),
      severity: 'error',
      details: {
        current: accountState.tradingDays.size,
        required: rule.minTradingDays,
      },
    });
  }
}

function evaluateMinTradesPerDay(rule: PropFirmRule, accountState: AccountState): void {
  if (rule.minTradesPerDay === undefined) return;

  for (const [date, tradeCount] of accountState.dailyTrades.entries()) {
    if (tradeCount < rule.minTradesPerDay) {
      accountState.violations.push({
        rule: 'minTradesPerDay',
        message: `Minimum trades per day not met on ${date}: ${tradeCount} < ${rule.minTradesPerDay}`,
        timestamp: new Date().toISOString(),
        severity: 'warning',
        details: {
          date,
          current: tradeCount,
          required: rule.minTradesPerDay,
        },
      });
    }
  }
}

async function evaluateMaxRiskPerTrade(rule: PropFirmRule, accountState: AccountState, db: DatabaseManager): Promise<void> {
  if (rule.maxRiskPerTrade === undefined) return;

  const maxRiskAmount = (rule.maxRiskPerTrade / 100) * accountState.initialBalance;

  for (const trade of accountState.trades) {
    if (trade.entry_price && trade.stop_loss && trade.quantity) {
      // Get all orders for this trade to calculate remaining quantity over time
      const orders = await db.getOrdersByTradeId(trade.id);
      
      // Get original stop loss from stop_loss order (before breakeven move)
      // If trade.stop_loss_breakeven is true, trade.stop_loss might be the breakeven price
      const stopLossOrder = orders.find(o => o.order_type === 'stop_loss');
      const originalStopLoss = stopLossOrder?.price || trade.stop_loss;
      
      // Determine if SL is at breakeven (within small tolerance)
      const breakevenTolerance = trade.entry_price * 0.001; // 0.1% tolerance
      const isAtBreakeven = trade.stop_loss_breakeven || 
        Math.abs(trade.entry_price - trade.stop_loss) <= breakevenTolerance;
      
      // Calculate initial risk (at entry) using original stop loss
      const originalPriceDiff = Math.abs(trade.entry_price - originalStopLoss);
      const initialQuantity = trade.quantity || 0;
      const leverage = trade.leverage || 1;
      const initialRiskAmount = originalPriceDiff * initialQuantity * leverage;
      
      // Check initial risk (before any TPs or breakeven)
      if (initialRiskAmount > maxRiskAmount) {
        accountState.violations.push({
          rule: 'maxRiskPerTrade',
          message: `Trade ${trade.id} exceeds maximum risk per trade at entry: ${initialRiskAmount.toFixed(2)} USDT > ${maxRiskAmount.toFixed(2)} USDT`,
          timestamp: trade.entry_filled_at || trade.created_at,
          severity: 'error',
          details: {
            tradeId: trade.id,
            riskAmount: initialRiskAmount,
            limit: maxRiskAmount,
            quantity: initialQuantity,
            originalStopLoss,
          },
        });
      }

      // Track risk over time as TPs are filled and SL moves to breakeven
      // Sort orders chronologically by fill time
      const filledOrders = orders
        .filter(o => o.status === 'filled' && o.filled_at)
        .sort((a, b) => {
          const timeA = a.filled_at ? dayjs(a.filled_at).valueOf() : 0;
          const timeB = b.filled_at ? dayjs(b.filled_at).valueOf() : 0;
          return timeA - timeB;
        });

      let remainingQuantity = initialQuantity;
      let filledTPCount = 0;
      
      // If trade.stop_loss_breakeven is true, SL was moved to breakeven at some point
      // We'll check risk chronologically: before breakeven uses original SL, after breakeven risk is 0
      // Since we don't know exactly when breakeven happened, we'll be conservative:
      // - If stop_loss_breakeven is true, we know it happened, so after any TP fill, risk should be 0
      // - Before that, use original SL
      
      // Check risk after each TP fill
      for (const order of filledOrders) {
        if (order.order_type === 'take_profit' && order.quantity) {
          remainingQuantity -= order.quantity;
          remainingQuantity = Math.max(0, remainingQuantity); // Ensure non-negative
          filledTPCount++;
          
          // If SL was moved to breakeven, risk after breakeven is effectively 0
          // We check if the current stop_loss is at breakeven (within tolerance)
          const currentStopLossAtBreakeven = trade.stop_loss_breakeven || 
            Math.abs(trade.entry_price - trade.stop_loss) <= breakevenTolerance;
          
          // Calculate current risk:
          // - If SL is at breakeven, risk is 0 (or very small, just rounding errors)
          // - Otherwise, use original stop loss with remaining quantity
          const effectiveStopLoss = currentStopLossAtBreakeven ? trade.entry_price : originalStopLoss;
          const effectivePriceDiff = Math.abs(trade.entry_price - effectiveStopLoss);
          const currentRiskAmount = effectivePriceDiff * remainingQuantity * leverage;
          
          // Only flag violation if risk is significant (account for floating point precision)
          if (currentRiskAmount > maxRiskAmount + 0.01) { // Small buffer for floating point
            accountState.violations.push({
              rule: 'maxRiskPerTrade',
              message: `Trade ${trade.id} exceeds maximum risk per trade after TP fill: ${currentRiskAmount.toFixed(2)} USDT > ${maxRiskAmount.toFixed(2)} USDT (remaining quantity: ${remainingQuantity.toFixed(2)}, SL at breakeven: ${currentStopLossAtBreakeven})`,
              timestamp: order.filled_at || trade.created_at,
              severity: 'error',
              details: {
                tradeId: trade.id,
                riskAmount: currentRiskAmount,
                limit: maxRiskAmount,
                remainingQuantity,
                filledTPCount,
                slAtBreakeven: currentStopLossAtBreakeven,
                effectiveStopLoss,
                originalStopLoss,
                orderId: order.id,
              },
            });
          }
        }
      }
    }
  }
}

function evaluateStopLossRequirement(rule: PropFirmRule, accountState: AccountState): void {
  if (!rule.stopLossRequired) return;

  for (const trade of accountState.trades) {
    if (!trade.stop_loss || trade.stop_loss === 0) {
      accountState.violations.push({
        rule: 'stopLossRequired',
        message: `Trade ${trade.id} missing required stop-loss`,
        timestamp: trade.created_at,
        severity: 'error',
        details: {
          tradeId: trade.id,
        },
      });
    }
  }
}

function evaluateMaxProfitLimits(rule: PropFirmRule, accountState: AccountState): void {
  // Check daily profit limit
  if (rule.maxProfitPerDay !== undefined) {
    for (const [date, dailyPnL] of accountState.dailyPnL.entries()) {
      if (dailyPnL > rule.maxProfitPerDay) {
        accountState.violations.push({
          rule: 'maxProfitPerDay',
          message: `Daily profit limit exceeded on ${date}: ${dailyPnL.toFixed(2)} USDT > ${rule.maxProfitPerDay} USDT`,
          timestamp: new Date().toISOString(),
          severity: 'error',
          details: {
            date,
            dailyPnL,
            limit: rule.maxProfitPerDay,
          },
        });
      }
    }
  }

  // Check per-trade profit limit
  if (rule.maxProfitPerTrade !== undefined) {
    for (const trade of accountState.trades) {
      if (trade.pnl && trade.pnl > rule.maxProfitPerTrade) {
        accountState.violations.push({
          rule: 'maxProfitPerTrade',
          message: `Trade ${trade.id} exceeds maximum profit per trade: ${trade.pnl.toFixed(2)} USDT > ${rule.maxProfitPerTrade} USDT`,
          timestamp: trade.exit_filled_at || trade.created_at,
          severity: 'error',
          details: {
            tradeId: trade.id,
            profit: trade.pnl,
            limit: rule.maxProfitPerTrade,
          },
        });
      }
    }
  }
}

function evaluateShortTradePercentage(rule: PropFirmRule, accountState: AccountState): void {
  if (rule.minTradeDuration === undefined || rule.maxShortTradesPercentage === undefined) return;

  const shortTrades = accountState.trades.filter(trade => {
    if (!trade.entry_filled_at || !trade.exit_filled_at) return false;
    const duration = dayjs(trade.exit_filled_at).diff(dayjs(trade.entry_filled_at), 'second');
    return duration < rule.minTradeDuration!;
  });

  const shortTradePercentage = (shortTrades.length / accountState.trades.length) * 100;

  if (shortTradePercentage > rule.maxShortTradesPercentage) {
    accountState.violations.push({
      rule: 'maxShortTradesPercentage',
      message: `Too many short trades: ${shortTradePercentage.toFixed(2)}% > ${rule.maxShortTradesPercentage}%`,
      timestamp: new Date().toISOString(),
      severity: 'error',
      details: {
        current: shortTradePercentage,
        limit: rule.maxShortTradesPercentage,
        shortTrades: shortTrades.length,
        totalTrades: accountState.trades.length,
      },
    });
  }
}

function evaluateReverseTrading(rule: PropFirmRule, accountState: AccountState): void {
  if (rule.reverseTradingAllowed !== false) return;
  if (rule.reverseTradingTimeLimit === undefined) return;

  // Check for overlapping opposite trades
  const sortedTrades = [...accountState.trades].sort((a, b) => {
    const timeA = a.entry_filled_at ? dayjs(a.entry_filled_at).valueOf() : 0;
    const timeB = b.entry_filled_at ? dayjs(b.entry_filled_at).valueOf() : 0;
    return timeA - timeB;
  });

  for (let i = 0; i < sortedTrades.length; i++) {
    const trade1 = sortedTrades[i];
    if (!trade1.entry_filled_at || !trade1.exit_filled_at) continue;

    // Determine trade direction: for longs, entry > stop_loss; for shorts, entry < stop_loss
    const isLong1 = trade1.entry_price > trade1.stop_loss;

    for (let j = i + 1; j < sortedTrades.length; j++) {
      const trade2 = sortedTrades[j];
      if (!trade2.entry_filled_at || !trade2.exit_filled_at) continue;

      const isLong2 = trade2.entry_price > trade2.stop_loss;

      // Check if opposite directions AND same trading pair
      // Reverse trading rule applies only to the same symbol with opposite positions (hedging)
      if (isLong1 !== isLong2 && trade1.trading_pair === trade2.trading_pair) {
        // Check if they overlap for more than the time limit
        const trade1Start = dayjs(trade1.entry_filled_at);
        const trade1End = dayjs(trade1.exit_filled_at);
        const trade2Start = dayjs(trade2.entry_filled_at);
        const trade2End = dayjs(trade2.exit_filled_at);

        // Calculate overlap
        const overlapStart = trade1Start.isAfter(trade2Start) ? trade1Start : trade2Start;
        const overlapEnd = trade1End.isBefore(trade2End) ? trade1End : trade2End;

        if (overlapStart.isBefore(overlapEnd)) {
          const overlapSeconds = overlapEnd.diff(overlapStart, 'second');
          if (overlapSeconds >= rule.reverseTradingTimeLimit!) {
            accountState.violations.push({
              rule: 'reverseTrading',
              message: `Reverse trading violation: trades ${trade1.id} and ${trade2.id} (${trade1.trading_pair}) overlap for ${overlapSeconds}s > ${rule.reverseTradingTimeLimit}s`,
              timestamp: overlapStart.toISOString(),
              severity: 'error',
              details: {
                trade1Id: trade1.id,
                trade2Id: trade2.id,
                tradingPair: trade1.trading_pair,
                overlapSeconds,
                limit: rule.reverseTradingTimeLimit,
              },
            });
          }
        }
      }
    }
  }
}

function calculateMetrics(accountState: AccountState): EvaluationResult['metrics'] {
  const totalPnL = accountState.currentBalance - accountState.initialBalance;
  const totalPnLPercentage = (totalPnL / accountState.initialBalance) * 100;

  // Calculate max drawdown
  let maxDrawdown = 0;
  let maxDrawdownPercentage = 0;
  let runningBalance = accountState.initialBalance;
  let peakBalance = accountState.initialBalance;

  for (const trade of accountState.trades.sort((a, b) => {
    const timeA = a.exit_filled_at ? dayjs(a.exit_filled_at).valueOf() : 0;
    const timeB = b.exit_filled_at ? dayjs(b.exit_filled_at).valueOf() : 0;
    return timeA - timeB;
  })) {
    if (trade.pnl !== undefined) {
      runningBalance += trade.pnl;
      if (runningBalance > peakBalance) {
        peakBalance = runningBalance;
      }
      const drawdown = peakBalance - runningBalance;
      const drawdownPercentage = (drawdown / accountState.initialBalance) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercentage = drawdownPercentage;
      }
    }
  }

  // Calculate win rate
  const winningTrades = accountState.trades.filter(t => (t.pnl || 0) > 0).length;
  const losingTrades = accountState.trades.filter(t => (t.pnl || 0) < 0).length;
  const winRate = accountState.trades.length > 0
    ? (winningTrades / accountState.trades.length) * 100
    : 0;

  return {
    initialBalance: accountState.initialBalance,
    finalBalance: accountState.currentBalance,
    totalPnL,
    totalPnLPercentage,
    maxDrawdown,
    maxDrawdownPercentage,
    peakBalance,
    tradingDays: accountState.tradingDays.size,
    totalTrades: accountState.trades.length,
    winningTrades,
    losingTrades,
    winRate,
  };
}

function getStartDate(accountState: AccountState): string {
  if (accountState.trades.length === 0) {
    return new Date().toISOString();
  }
  const firstTrade = accountState.trades.reduce((earliest, trade) => {
    if (!earliest) return trade;
    if (!trade.created_at) return earliest;
    return dayjs(trade.created_at).isBefore(dayjs(earliest.created_at)) ? trade : earliest;
  });
  return firstTrade.created_at;
}

function getEndDate(accountState: AccountState): string {
  if (accountState.trades.length === 0) {
    return new Date().toISOString();
  }
  const lastTrade = accountState.trades.reduce((latest, trade) => {
    if (!latest) return trade;
    if (!trade.exit_filled_at) return latest;
    return dayjs(trade.exit_filled_at).isAfter(dayjs(latest.exit_filled_at || latest.created_at)) ? trade : latest;
  });
  return lastTrade.exit_filled_at || lastTrade.created_at;
}

/**
 * Create Prop Firm Evaluator
 */
export function createPropFirmEvaluator(rule: PropFirmRule, db: DatabaseManager): PropFirmEvaluator {
  const accountState: AccountState = {
    initialBalance: rule.initialBalance,
    currentBalance: rule.initialBalance,
    equity: rule.initialBalance,
    peakBalance: rule.initialBalance,
    dailyPnL: new Map(),
    dailyTrades: new Map(),
    tradingDays: new Set(),
    trades: [],
    openTrades: [],
    violations: [],
  };

  return {
    addTrade: (trade: Trade): void => {
      // Exclude cancelled trades - they never entered, so TPs and SLs don't apply
      if (trade.status === 'cancelled') {
        logger.debug('Skipping cancelled trade (entry never filled)', {
          tradeId: trade.id,
          tradingPair: trade.trading_pair
        });
        return;
      }

      // Only process trades that have a filled entry - if entry wasn't filled, ignore the trade
      // This ensures TPs and SLs are only considered for trades that actually entered
      if (!trade.entry_filled_at) {
        logger.debug('Skipping trade without filled entry', {
          tradeId: trade.id,
          status: trade.status,
          tradingPair: trade.trading_pair
        });
        return;
      }

      if (trade.status !== 'closed' && trade.status !== 'stopped' && trade.status !== 'completed') {
        // Track open trades (but only if they have a filled entry)
        if (trade.status === 'active' || trade.status === 'filled') {
          accountState.openTrades.push(trade);
        }
        return;
      }

      // Remove from open trades if it was there
      accountState.openTrades = accountState.openTrades.filter(t => t.id !== trade.id);

      // Add to trades list
      accountState.trades.push(trade);

      // Update balance
      if (trade.pnl !== undefined) {
        accountState.currentBalance += trade.pnl;
        accountState.equity = accountState.currentBalance;

        // Update peak balance
        if (accountState.currentBalance > accountState.peakBalance) {
          accountState.peakBalance = accountState.currentBalance;
        }

        // Track daily P&L
        if (trade.exit_filled_at) {
          const tradeDate = dayjs(trade.exit_filled_at).format('YYYY-MM-DD');
          const currentDailyPnL = accountState.dailyPnL.get(tradeDate) || 0;
          accountState.dailyPnL.set(tradeDate, currentDailyPnL + trade.pnl);

          // Track trading days
          accountState.tradingDays.add(tradeDate);

          // Track daily trades
          const currentDailyTrades = accountState.dailyTrades.get(tradeDate) || 0;
          accountState.dailyTrades.set(tradeDate, currentDailyTrades + 1);
        }
      }
    },

    updateEquity: (openTradesUnrealizedPnL: number): void => {
      accountState.equity = accountState.currentBalance + openTradesUnrealizedPnL;
    },

    evaluate: async (): Promise<EvaluationResult> => {
      accountState.violations = [];

      // Evaluate each rule category
      evaluateProfitTarget(rule, accountState);
      evaluateMaxDrawdown(rule, accountState);
      evaluateDailyDrawdown(rule, accountState);
      evaluateMinTradingDays(rule, accountState);
      evaluateMinTradesPerDay(rule, accountState);
      await evaluateMaxRiskPerTrade(rule, accountState, db);
      evaluateStopLossRequirement(rule, accountState);
      evaluateMaxProfitLimits(rule, accountState);
      evaluateShortTradePercentage(rule, accountState);
      evaluateReverseTrading(rule, accountState);

      // Calculate metrics
      const metrics = calculateMetrics(accountState);

      // Determine if passed (no error-level violations)
      const hasErrors = accountState.violations.some(v => v.severity === 'error');
      const passed = !hasErrors;

      return {
        propFirmName: rule.displayName,
        passed,
        violations: accountState.violations,
        metrics,
        startDate: getStartDate(accountState),
        endDate: getEndDate(accountState),
      };
    },
  };
}
