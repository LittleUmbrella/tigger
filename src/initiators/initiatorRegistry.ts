import { InitiatorConfig, AccountConfig, AccountFilter, PairRule, TradeToleranceConfig } from '../types/config.js';
import type { ResolvedTradingPause } from '../utils/tradingPause.js';
import { ParsedOrder } from '../types/order.js';
import { DatabaseManager, Message } from '../db/schema.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { logger } from '../utils/logger.js';
import type { CTraderClient } from '../clients/ctraderClient.js';

/**
 * Context passed to initiator functions
 */
export interface InitiatorContext {
  channel: string;
  riskPercentage: number;
  entryTimeoutMinutes: number;
  message: Message;
  order: ParsedOrder;
  db: DatabaseManager;
  isSimulation: boolean;
  priceProvider?: HistoricalPriceProvider;
  config: InitiatorConfig; // Full initiator config for initiator-specific settings
  accounts?: AccountConfig[]; // Available accounts configuration
  accountFilters?: AccountFilter[]; // Channel-level account filtering rules
  currentBalance?: number; // Current account balance at the time of trade creation (for evaluation mode)
  /**
   * Human percent (1 = 1%): max total worst-case loss (existing open exposure + this trade) vs account balance.
   * Same exposure math as drawdown pre-trade (`additionalWorstCaseLoss` + `calculatePotentialLoss` in `risk.ts`).
   */
  maxRisk?: number;
  forcePlaceTrade?: boolean; // If true, bypass existing-trade check (for manual retries when DB has stale data)
  slAdjustmentTolerancePercent?: number; // Per-channel: when price past SL, max overshoot % to allow proportional SL adjustment (0 = reject)
  /** Per-channel: passed from `ChannelSetConfig`; initiators interpret it (limit-at-quote vs native market where implemented). Default true when omitted. */
  useLimitOrderForEntry?: boolean;
  /** cTrader market orders only: max number of TPs to skip when price has already moved past them (0 = reject, default) */
  maxSkippablePastTPs?: number;
  /** cTrader: MARKET_RANGE entry; boundary TP index follows maxSkippablePastTPs */
  useMarketRangeForEntry?: boolean;
  /** Channel trade tolerance (SL amend uses signalStopLoss + sl config, not double-applied). */
  tradeTolerance?: TradeToleranceConfig;
  /** Parser stop loss before tradeTolerance (for absolute SL reconcile on exchange). */
  signalStopLoss?: number;
  /**
   * Channel-level minimum reward-to-risk ratio (reward / risk). Account-level overrides when set.
   */
  minRiskReward?: number;
  /**
   * Channel-level override for stacked same-symbol trades (cTrader). Resolved with account via
   * `resolveAllowConcurrentSymbolTrades`; default false.
   */
  allowConcurrentSymbolTrades?: boolean;
  /** Reuse orchestrator-pooled cTrader clients (avoids connect/auth per trade). */
  getCTraderClient?: (accountName?: string) => Promise<CTraderClient | undefined>;
  /** Channel-level per-pair rules (see `ChannelSetConfig.pairRules`). */
  pairRules?: PairRule[];
  /** Resolved pause lists from BotConfig; skipped in simulation. Empty lists = no pauses. */
  tradingPause?: ResolvedTradingPause;
}

/**
 * Initiator function type - initiates a trade based on parsed order data
 */
export type InitiatorFunction = (context: InitiatorContext) => Promise<void>;

/**
 * Registry of initiators by name
 */
const initiatorRegistry = new Map<string, InitiatorFunction>();

/**
 * Register an initiator function with a name
 */
export const registerInitiator = (name: string, initiator: InitiatorFunction): void => {
  initiatorRegistry.set(name, initiator);
  logger.info('Initiator registered', { name });
};

/**
 * Get an initiator by name
 */
export const getInitiator = (name: string): InitiatorFunction | undefined => {
  return initiatorRegistry.get(name);
};

/**
 * Check if an initiator exists
 */
export const hasInitiator = (name: string): boolean => {
  return initiatorRegistry.has(name);
};

/**
 * Get all registered initiator names
 */
export const getRegisteredInitiators = (): string[] => {
  return Array.from(initiatorRegistry.keys());
};

