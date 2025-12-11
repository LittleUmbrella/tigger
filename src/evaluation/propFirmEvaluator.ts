import { PropFirmRule } from './propFirmRules.js';
import { Trade } from '../db/schema.js';
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

/**
 * Prop Firm Evaluator
 * 
 * Evaluates trading performance against prop firm rules
 */
export class PropFirmEvaluator {
  private rule: PropFirmRule;
  private accountState: AccountState;

  constructor(rule: PropFirmRule) {
    this.rule = rule;
    this.accountState = {
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
  }

  /**
   * Add a closed trade to the evaluation
   */
  addTrade(trade: Trade): void {
    if (trade.status !== 'closed' && trade.status !== 'stopped' && trade.status !== 'completed') {
      // Track open trades
      if (trade.status === 'active' || trade.status === 'filled') {
        this.accountState.openTrades.push(trade);
      }
      return;
    }

    // Remove from open trades if it was there
    this.accountState.openTrades = this.accountState.openTrades.filter(t => t.id !== trade.id);

    // Add to trades list
    this.accountState.trades.push(trade);

    // Update balance
    if (trade.pnl !== undefined) {
      this.accountState.currentBalance += trade.pnl;
      this.accountState.equity = this.accountState.currentBalance;

      // Update peak balance
      if (this.accountState.currentBalance > this.accountState.peakBalance) {
        this.accountState.peakBalance = this.accountState.currentBalance;
      }

      // Track daily P&L
      if (trade.exit_filled_at) {
        const tradeDate = dayjs(trade.exit_filled_at).format('YYYY-MM-DD');
        const currentDailyPnL = this.accountState.dailyPnL.get(tradeDate) || 0;
        this.accountState.dailyPnL.set(tradeDate, currentDailyPnL + trade.pnl);

        // Track trading days
        this.accountState.tradingDays.add(tradeDate);

        // Track daily trades
        const currentDailyTrades = this.accountState.dailyTrades.get(tradeDate) || 0;
        this.accountState.dailyTrades.set(tradeDate, currentDailyTrades + 1);
      }
    }
  }

  /**
   * Update equity based on open trades
   */
  updateEquity(openTradesUnrealizedPnL: number): void {
    this.accountState.equity = this.accountState.currentBalance + openTradesUnrealizedPnL;
  }

  /**
   * Evaluate all rules
   */
  evaluate(): EvaluationResult {
    this.accountState.violations = [];

    // Evaluate each rule category
    this.evaluateProfitTarget();
    this.evaluateMaxDrawdown();
    this.evaluateDailyDrawdown();
    this.evaluateMinTradingDays();
    this.evaluateMinTradesPerDay();
    this.evaluateMaxRiskPerTrade();
    this.evaluateStopLossRequirement();
    this.evaluateMaxProfitLimits();
    this.evaluateShortTradePercentage();
    this.evaluateReverseTrading();

    // Calculate metrics
    const metrics = this.calculateMetrics();

    // Determine if passed (no error-level violations)
    const hasErrors = this.accountState.violations.some(v => v.severity === 'error');
    const passed = !hasErrors;

    return {
      propFirmName: this.rule.displayName,
      passed,
      violations: this.accountState.violations,
      metrics,
      startDate: this.getStartDate(),
      endDate: this.getEndDate(),
    };
  }

  /**
   * Evaluate profit target
   */
  private evaluateProfitTarget(): void {
    if (this.rule.profitTarget === undefined) return;

    const totalPnLPercentage = ((this.accountState.currentBalance - this.accountState.initialBalance) / this.accountState.initialBalance) * 100;

    if (totalPnLPercentage < this.rule.profitTarget) {
      this.accountState.violations.push({
        rule: 'profitTarget',
        message: `Profit target not met: ${totalPnLPercentage.toFixed(2)}% < ${this.rule.profitTarget}%`,
        timestamp: new Date().toISOString(),
        severity: 'error',
        details: {
          current: totalPnLPercentage,
          required: this.rule.profitTarget,
        },
      });
    }
  }

  /**
   * Evaluate maximum drawdown
   */
  private evaluateMaxDrawdown(): void {
    if (this.rule.maxDrawdown === undefined) return;

    const maxDrawdown = this.accountState.peakBalance - Math.min(
      ...this.accountState.trades.map(t => {
        if (t.exit_filled_at && t.pnl !== undefined) {
          // Calculate balance at time of trade
          const tradesBefore = this.accountState.trades.filter(
            t2 => t2.exit_filled_at && dayjs(t2.exit_filled_at).isBefore(dayjs(t.exit_filled_at))
          );
          const balanceAtTrade = this.accountState.initialBalance + 
            tradesBefore.reduce((sum, t2) => sum + (t2.pnl || 0), 0) + (t.pnl || 0);
          return balanceAtTrade;
        }
        return this.accountState.initialBalance;
      }),
      this.accountState.currentBalance
    );

    const maxDrawdownPercentage = (maxDrawdown / this.accountState.initialBalance) * 100;

    if (maxDrawdownPercentage > this.rule.maxDrawdown) {
      this.accountState.violations.push({
        rule: 'maxDrawdown',
        message: `Maximum drawdown exceeded: ${maxDrawdownPercentage.toFixed(2)}% > ${this.rule.maxDrawdown}%`,
        timestamp: new Date().toISOString(),
        severity: 'error',
        details: {
          current: maxDrawdownPercentage,
          limit: this.rule.maxDrawdown,
        },
      });
    }
  }

  /**
   * Evaluate daily drawdown
   */
  private evaluateDailyDrawdown(): void {
    if (this.rule.dailyDrawdown === undefined) return;

    const dailyDrawdownLimit = (this.rule.dailyDrawdown / 100) * this.accountState.initialBalance;

    for (const [date, dailyPnL] of this.accountState.dailyPnL.entries()) {
      if (dailyPnL < -dailyDrawdownLimit) {
        this.accountState.violations.push({
          rule: 'dailyDrawdown',
          message: `Daily drawdown exceeded on ${date}: ${dailyPnL.toFixed(2)} USDT < -${dailyDrawdownLimit.toFixed(2)} USDT`,
          timestamp: new Date().toISOString(),
          severity: 'error',
          details: {
            date,
            dailyPnL,
            limit: -dailyDrawdownLimit,
          },
        });
      }
    }
  }

  /**
   * Evaluate minimum trading days
   */
  private evaluateMinTradingDays(): void {
    if (this.rule.minTradingDays === undefined) return;

    if (this.accountState.tradingDays.size < this.rule.minTradingDays) {
      this.accountState.violations.push({
        rule: 'minTradingDays',
        message: `Minimum trading days not met: ${this.accountState.tradingDays.size} < ${this.rule.minTradingDays}`,
        timestamp: new Date().toISOString(),
        severity: 'error',
        details: {
          current: this.accountState.tradingDays.size,
          required: this.rule.minTradingDays,
        },
      });
    }
  }

  /**
   * Evaluate minimum trades per day
   */
  private evaluateMinTradesPerDay(): void {
    if (this.rule.minTradesPerDay === undefined) return;

    for (const [date, tradeCount] of this.accountState.dailyTrades.entries()) {
      if (tradeCount < this.rule.minTradesPerDay) {
        this.accountState.violations.push({
          rule: 'minTradesPerDay',
          message: `Minimum trades per day not met on ${date}: ${tradeCount} < ${this.rule.minTradesPerDay}`,
          timestamp: new Date().toISOString(),
          severity: 'warning',
          details: {
            date,
            current: tradeCount,
            required: this.rule.minTradesPerDay,
          },
        });
      }
    }
  }

  /**
   * Evaluate maximum risk per trade
   */
  private evaluateMaxRiskPerTrade(): void {
    if (this.rule.maxRiskPerTrade === undefined) return;

    const maxRiskAmount = (this.rule.maxRiskPerTrade / 100) * this.accountState.initialBalance;

    for (const trade of this.accountState.trades) {
      if (trade.entry_price && trade.stop_loss) {
        const riskAmount = Math.abs(trade.entry_price - trade.stop_loss) * (trade.risk_percentage / 100) * this.accountState.initialBalance;
        
        if (riskAmount > maxRiskAmount) {
          this.accountState.violations.push({
            rule: 'maxRiskPerTrade',
            message: `Trade ${trade.id} exceeds maximum risk per trade: ${riskAmount.toFixed(2)} USDT > ${maxRiskAmount.toFixed(2)} USDT`,
            timestamp: trade.created_at,
            severity: 'error',
            details: {
              tradeId: trade.id,
              riskAmount,
              limit: maxRiskAmount,
            },
          });
        }
      }
    }
  }

  /**
   * Evaluate stop-loss requirement
   */
  private evaluateStopLossRequirement(): void {
    if (!this.rule.stopLossRequired) return;

    for (const trade of this.accountState.trades) {
      if (!trade.stop_loss || trade.stop_loss === 0) {
        this.accountState.violations.push({
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

  /**
   * Evaluate maximum profit limits
   */
  private evaluateMaxProfitLimits(): void {
    // Check daily profit limit
    if (this.rule.maxProfitPerDay !== undefined) {
      for (const [date, dailyPnL] of this.accountState.dailyPnL.entries()) {
        if (dailyPnL > this.rule.maxProfitPerDay) {
          this.accountState.violations.push({
            rule: 'maxProfitPerDay',
            message: `Daily profit limit exceeded on ${date}: ${dailyPnL.toFixed(2)} USDT > ${this.rule.maxProfitPerDay} USDT`,
            timestamp: new Date().toISOString(),
            severity: 'error',
            details: {
              date,
              dailyPnL,
              limit: this.rule.maxProfitPerDay,
            },
          });
        }
      }
    }

    // Check per-trade profit limit
    if (this.rule.maxProfitPerTrade !== undefined) {
      for (const trade of this.accountState.trades) {
        if (trade.pnl && trade.pnl > this.rule.maxProfitPerTrade) {
          this.accountState.violations.push({
            rule: 'maxProfitPerTrade',
            message: `Trade ${trade.id} exceeds maximum profit per trade: ${trade.pnl.toFixed(2)} USDT > ${this.rule.maxProfitPerTrade} USDT`,
            timestamp: trade.exit_filled_at || trade.created_at,
            severity: 'error',
            details: {
              tradeId: trade.id,
              profit: trade.pnl,
              limit: this.rule.maxProfitPerTrade,
            },
          });
        }
      }
    }
  }

  /**
   * Evaluate short trade percentage
   */
  private evaluateShortTradePercentage(): void {
    if (this.rule.minTradeDuration === undefined || this.rule.maxShortTradesPercentage === undefined) return;

    const shortTrades = this.accountState.trades.filter(trade => {
      if (!trade.entry_filled_at || !trade.exit_filled_at) return false;
      const duration = dayjs(trade.exit_filled_at).diff(dayjs(trade.entry_filled_at), 'second');
      return duration < this.rule.minTradeDuration!;
    });

    const shortTradePercentage = (shortTrades.length / this.accountState.trades.length) * 100;

    if (shortTradePercentage > this.rule.maxShortTradesPercentage) {
      this.accountState.violations.push({
        rule: 'maxShortTradesPercentage',
        message: `Too many short trades: ${shortTradePercentage.toFixed(2)}% > ${this.rule.maxShortTradesPercentage}%`,
        timestamp: new Date().toISOString(),
        severity: 'error',
        details: {
          current: shortTradePercentage,
          limit: this.rule.maxShortTradesPercentage,
          shortTrades: shortTrades.length,
          totalTrades: this.accountState.trades.length,
        },
      });
    }
  }

  /**
   * Evaluate reverse trading rule
   */
  private evaluateReverseTrading(): void {
    if (this.rule.reverseTradingAllowed !== false) return;
    if (this.rule.reverseTradingTimeLimit === undefined) return;

    // Check for overlapping opposite trades
    const sortedTrades = [...this.accountState.trades].sort((a, b) => {
      const timeA = a.entry_filled_at ? dayjs(a.entry_filled_at).valueOf() : 0;
      const timeB = b.entry_filled_at ? dayjs(b.entry_filled_at).valueOf() : 0;
      return timeA - timeB;
    });

    for (let i = 0; i < sortedTrades.length; i++) {
      const trade1 = sortedTrades[i];
      if (!trade1.entry_filled_at || !trade1.exit_filled_at) continue;

      // Determine trade direction (simplified: check if entry < exit for long, entry > exit for short)
      const isLong1 = trade1.entry_price < (trade1.exit_price || trade1.entry_price);

      for (let j = i + 1; j < sortedTrades.length; j++) {
        const trade2 = sortedTrades[j];
        if (!trade2.entry_filled_at || !trade2.exit_filled_at) continue;

        const isLong2 = trade2.entry_price < (trade2.exit_price || trade2.entry_price);

        // Check if opposite directions
        if (isLong1 !== isLong2) {
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
            if (overlapSeconds >= this.rule.reverseTradingTimeLimit!) {
              this.accountState.violations.push({
                rule: 'reverseTrading',
                message: `Reverse trading violation: trades ${trade1.id} and ${trade2.id} overlap for ${overlapSeconds}s > ${this.rule.reverseTradingTimeLimit}s`,
                timestamp: overlapStart.toISOString(),
                severity: 'error',
                details: {
                  trade1Id: trade1.id,
                  trade2Id: trade2.id,
                  overlapSeconds,
                  limit: this.rule.reverseTradingTimeLimit,
                },
              });
            }
          }
        }
      }
    }
  }

  /**
   * Calculate evaluation metrics
   */
  private calculateMetrics(): EvaluationResult['metrics'] {
    const totalPnL = this.accountState.currentBalance - this.accountState.initialBalance;
    const totalPnLPercentage = (totalPnL / this.accountState.initialBalance) * 100;

    // Calculate max drawdown
    let maxDrawdown = 0;
    let maxDrawdownPercentage = 0;
    let runningBalance = this.accountState.initialBalance;
    let peakBalance = this.accountState.initialBalance;

    for (const trade of this.accountState.trades.sort((a, b) => {
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
        const drawdownPercentage = (drawdown / this.accountState.initialBalance) * 100;
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
          maxDrawdownPercentage = drawdownPercentage;
        }
      }
    }

    // Calculate win rate
    const winningTrades = this.accountState.trades.filter(t => (t.pnl || 0) > 0).length;
    const losingTrades = this.accountState.trades.filter(t => (t.pnl || 0) < 0).length;
    const winRate = this.accountState.trades.length > 0
      ? (winningTrades / this.accountState.trades.length) * 100
      : 0;

    return {
      initialBalance: this.accountState.initialBalance,
      finalBalance: this.accountState.currentBalance,
      totalPnL,
      totalPnLPercentage,
      maxDrawdown,
      maxDrawdownPercentage,
      peakBalance,
      tradingDays: this.accountState.tradingDays.size,
      totalTrades: this.accountState.trades.length,
      winningTrades,
      losingTrades,
      winRate,
    };
  }

  /**
   * Get start date of evaluation
   */
  private getStartDate(): string {
    if (this.accountState.trades.length === 0) {
      return new Date().toISOString();
    }
    const firstTrade = this.accountState.trades.reduce((earliest, trade) => {
      if (!earliest) return trade;
      if (!trade.created_at) return earliest;
      return dayjs(trade.created_at).isBefore(dayjs(earliest.created_at)) ? trade : earliest;
    });
    return firstTrade.created_at;
  }

  /**
   * Get end date of evaluation
   */
  private getEndDate(): string {
    if (this.accountState.trades.length === 0) {
      return new Date().toISOString();
    }
    const lastTrade = this.accountState.trades.reduce((latest, trade) => {
      if (!latest) return trade;
      if (!trade.exit_filled_at) return latest;
      return dayjs(trade.exit_filled_at).isAfter(dayjs(latest.exit_filled_at || latest.created_at)) ? trade : latest;
    });
    return lastTrade.exit_filled_at || lastTrade.created_at;
  }
}

