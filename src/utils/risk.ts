import { Trade, DatabaseManager } from '../db/schema.js';
import { logger } from './logger.js';
import dayjs from 'dayjs';

const toUtcDateString = (iso: string): string => {
  return new Date(iso).toISOString().slice(0, 10);
};

/** UTC calendar date string (YYYY-MM-DD) for "today" in risk / drawdown rules. */
export function getUtcTodayString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Worst-case quote loss if a position hits its stop: |entry − SL| × quantity
 * (quantity in base units: Bybit linear coin qty; cTrader base units per sizing).
 */
export function calculatePotentialLoss(
  entryPrice: number,
  stopLoss: number,
  quantity: number
): number {
  if (!stopLoss || stopLoss <= 0) {
    return Infinity;
  }

  const priceDiff = Math.abs(entryPrice - stopLoss);
  return priceDiff * quantity;
}

export interface ChannelPortfolioMaxRiskParams {
  /** Human percent: 1 = 1%. Cap on total worst-case loss vs balance (drawdown-style). */
  maxRiskPercent: number;
  /** Worst-case loss already on the account (open positions / pending adds). */
  existingWorstCaseLoss: number;
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  /** Denominator for the percentage cap (typically current wallet balance). */
  referenceBalance: number;
}

/**
 * Portfolio cap: block if existing exposure already exceeds the limit, or existing + this trade would.
 *
 * @returns violation message if blocked, otherwise `undefined`.
 */
export function getChannelMaxPortfolioRiskViolation(
  params: ChannelPortfolioMaxRiskParams
): string | undefined {
  const { maxRiskPercent, existingWorstCaseLoss, entryPrice, stopLoss, quantity, referenceBalance } = params;
  if (!isFinite(referenceBalance) || referenceBalance <= 0) {
    return `Cannot enforce max risk: invalid reference balance (${referenceBalance})`;
  }
  const limit = (maxRiskPercent / 100) * referenceBalance;
  const newTradeRisk = calculatePotentialLoss(entryPrice, stopLoss, quantity);

  if (!isFinite(existingWorstCaseLoss) || existingWorstCaseLoss < 0) {
    return `Cannot enforce max risk: invalid existing worst-case exposure (${existingWorstCaseLoss})`;
  }

  if (existingWorstCaseLoss > limit) {
    return (
      `Account worst-case exposure (${existingWorstCaseLoss.toFixed(2)}) already exceeds max risk ` +
      `(${limit.toFixed(2)}, ${maxRiskPercent}% of balance)`
    );
  }

  const totalWorstCase = existingWorstCaseLoss + newTradeRisk;
  if (totalWorstCase > limit) {
    return (
      `Total worst-case exposure (${totalWorstCase.toFixed(2)} = existing ${existingWorstCaseLoss.toFixed(2)} + ` +
      `new trade ${newTradeRisk.toFixed(2)}) would exceed max risk (${limit.toFixed(2)}, ${maxRiskPercent}% of balance)`
    );
  }

  return undefined;
}

/** When set, applies {@link getChannelMaxPortfolioRiskViolation}; negative values are ignored (logged). */
export function enforceChannelMaxPortfolioRiskConfigured(params: {
  maxRisk?: number;
  existingWorstCaseLoss: number;
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  referenceBalance: number;
  channel: string;
  messageId?: string | number;
  tradingPair?: string;
}): void {
  const {
    maxRisk,
    existingWorstCaseLoss,
    entryPrice,
    stopLoss,
    quantity,
    referenceBalance,
    channel,
    messageId,
    tradingPair,
  } = params;
  if (maxRisk === undefined || maxRisk === null) return;
  if (maxRisk < 0) {
    logger.warn('Ignoring invalid maxRisk (must be >= 0)', {
      channel,
      messageId,
      maxRisk,
    });
    return;
  }
  const violation = getChannelMaxPortfolioRiskViolation({
    maxRiskPercent: maxRisk,
    existingWorstCaseLoss,
    entryPrice,
    stopLoss,
    quantity,
    referenceBalance,
  });
  if (violation) {
    logger.warn('Trade blocked by max risk (portfolio)', {
      channel,
      messageId,
      tradingPair,
      entryPrice,
      stopLoss,
      quantity,
      referenceBalance,
      existingWorstCaseLoss,
      maxRisk,
    });
    throw new Error(`Max risk: ${violation}`);
  }
}

/** Completed trades for a channel (closed / stopped / completed), for equity and daily PnL projection. */
export async function loadCompletedTradesForChannel(
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
 * Completed trades for a settlement account (all channels), for prop / drawdown projection on that account.
 * Prefer this over {@link loadCompletedTradesForChannel} when pre-trade rules apply to the whole Bybit/cTrader account
 * and `currentBalance` comes from the exchange (not a single channel's DB stream).
 */
export async function loadCompletedTradesForAccount(
  db: DatabaseManager,
  accountName: string
): Promise<Trade[]> {
  const allTrades = await db.getActiveTrades();
  const closedTrades = await db.getClosedTrades();
  const accountTrades = [...allTrades, ...closedTrades].filter(
    (t) => t.account_name === accountName
  );
  return accountTrades.filter(
    (t) => t.status === 'closed' || t.status === 'stopped' || t.status === 'completed'
  );
}

/** Daily realized PnL by UTC date — independent of challenge starting balance. */
export function buildDailyPnLMap(completedTrades: Trade[]): Map<string, number> {
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
 * Peak equity and DB-derived balance from completed trades vs a starting balance.
 * Used for drawdown-style simulation from trade history.
 */
export function projectRunningBalanceAndPeak(
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
