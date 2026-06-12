/**
 * Harvester configuration
 * 
 * IMPORTANT: For security, use envVarNames to reference environment variables instead of
 * storing credentials directly in config.json. This allows config.json to be safely
 * committed to version control.
 */
export interface HarvesterConfig {
  name: string;
  channel: string;
  platform?: 'telegram' | 'discord' | 'discord-selfbot'; // Platform type (default: 'telegram' for backward compatibility)
  // Telegram-specific fields
  apiId?: number; // Required for Telegram
  phone?: string;
  password?: string;
  // Environment variable names that contain sensitive harvester credentials
  // These should be the names of environment variables (e.g., 'TELEGRAM_ACCESS_HASH'), not the actual values
  envVarNames?: {
    apiId?: string; // Name of environment variable containing Telegram API ID
    accessHash?: string; // Name of environment variable containing Telegram access hash (for private channels)
    session?: string; // Name of environment variable containing Telegram session string (allows multiple harvesters with different sessions)
    botToken?: string; // Name of environment variable containing Discord bot token
    userToken?: string; // Name of environment variable containing Discord user token (for self-bot harvesters)
  };
  // Deprecated: Direct credentials (for backward compatibility only)
  // Use envVarNames instead for security
  accessHash?: string; // @deprecated Use envVarNames.accessHash instead
  botToken?: string; // @deprecated Use envVarNames.botToken instead
  guildId?: string; // Discord server/guild ID (optional, can be inferred from channel)
  pollInterval?: number; // milliseconds
  downloadImages?: boolean; // Whether to download and store images from messages (default: false)
  skipOldMessagesOnStartup?: boolean; // Skip messages older than maxMessageAgeMinutes on first startup (default: true)
  maxMessageAgeMinutes?: number; // Maximum age of messages to process on first startup in minutes (default: 10)
}

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  rateLimit?: {
    perChannel?: number;
    perMinute?: number;
  };
}

import type { DatabaseManager } from '../db/schema.js';

export interface ParserConfig {
  name: string;
  channel: string;
  ollama?: OllamaConfig; // LLM fallback configuration (only for LLM parsers)
  db?: DatabaseManager; // DatabaseManager instance (optional, passed at runtime for reply chain support)
  entryPriceStrategy?: 'worst' | 'average'; // Strategy for handling multiple entry prices: 'worst' (default) uses worst price, 'average' uses average price
  // Parser-specific config can be added here
}

/**
 * Exchange account configuration
 * 
 * IMPORTANT: For security, use envVarNames to reference environment variables instead of
 * storing credentials directly in config.json. This allows config.json to be safely
 * committed to version control.
 */
export interface AccountConfig {
  name: string; // Unique name for this account (e.g., 'main', 'account1', 'testnet')
  exchange: 'bybit' | 'ctrader' | string; // Exchange type
  testnet?: boolean; // Whether to use testnet (deprecated: use demo for demo trading)
  demo?: boolean; // Whether to use demo trading (uses api-demo.bybit.com endpoint)
  // Environment variable names that contain the API credentials
  // These should be the names of environment variables (e.g., 'BYBIT_API_KEY'), not the actual values
  // Format: { apiKey: 'BYBIT_API_KEY', apiSecret: 'BYBIT_API_SECRET' }
  // Using envVarNames allows config.json to be safely committed to version control
  envVarNames?: {
    apiKey: string; // Name of environment variable containing the API key
    apiSecret: string; // Name of environment variable containing the API secret
    // cTrader-specific fields (optional)
    accessToken?: string; // Name of environment variable containing the OAuth access token
    refreshToken?: string; // Name of environment variable containing the OAuth refresh token
    accountId?: string; // Name of environment variable containing the cTrader account ID
  };
  // Deprecated: Direct API credentials (for backward compatibility only)
  // Use envVarNames instead for security
  apiKey?: string; // @deprecated Use envVarNames.apiKey instead
  apiSecret?: string; // @deprecated Use envVarNames.apiSecret instead
  // Deprecated: Old field name (for backward compatibility only)
  envVars?: {
    apiKey?: string;
    apiSecret?: string;
  };
  /**
   * Prop firm rules for this trading account (drawdown limits, risk per trade, etc.).
   * Prop rules apply per account, not per channel — channels only route signals to accounts.
   */
  propFirms?: (string | CustomPropFirmConfig)[];
  /**
   * cTrader only: interval in seconds for **account-wide** orphan position reconciliation. Scans all
   * open positions on that account; relinks only when exchange entry label matches the trade row
   * (`tgr-{channel}-{message_id}`). Default 15 when omitted; set to 0 to disable on this account.
   */
  ctraderOrphanPositionReconcileSeconds?: number;
  /**
   * cTrader only: interval in seconds for a slow label-vs-DB audit (open positions → entry labels →
   * fix mismatched active rows, log cross-message linkage). Default 0 (off); typical value 300–900.
   */
  ctraderLabelAuditSweepSeconds?: number;
  /**
   * cTrader only: when true, allow a new trade for a symbol even if this channel already has an
   * active cTrader trade row for that symbol. Overridden by channel `allowConcurrentSymbolTrades`.
   */
  allowConcurrentSymbolTrades?: boolean;
  /**
   * Minimum reward-to-risk ratio (reward / risk). E.g. 2 requires at least 2:1.
   * Used when channel `minRiskReward` is unset; channel overrides when set.
   */
  minRiskReward?: number;
}

export interface InitiatorConfig {
  name: string; // Name of the initiator (e.g., 'bybit', 'dex', etc.)
  type?: string; // Deprecated: kept for backward compatibility, use 'name' instead
  testnet?: boolean; // Deprecated: use accounts instead
  riskPercentage: number; // percentage of account to risk
  baseLeverage?: number; // Default leverage if not specified in message. Also used as confidence indicator for risk adjustment
  accounts?: string | string[]; // Account name(s) to use (from accounts config). If not specified, uses default account or env vars
  [key: string]: any; // Allow additional initiator-specific config
}

export interface MonitorConfig {
  type: 'bybit' | 'dex' | 'ctrader';
  testnet?: boolean;
  pollInterval?: number; // milliseconds
  entryTimeoutMinutes?: number; // minutes to wait for entry before cancelling
  breakevenAfterTPs?: number; // Number of take profits to hit before moving stop loss to breakeven (default: 1)
  /** When true, breakeven threshold scales with total TP count (see computeDynamicBreakevenAfterTPs); breakevenAfterTPs is ignored */
  dynamicBreakevenAfterTPs?: boolean;
  useLimitOrderForBreakeven?: boolean; // When true: conditional limit at BE fill + trigger a few ticks better + backup SL slightly worse (default: false uses setTradingStop at BE only)
  /** cTrader only: use tick data instead of M1 candles for evaluation (more precise, more API calls) */
  ctraderUseTickData?: boolean;
  /** cTrader only: map canonical symbols to broker-specific names (e.g. {"XAUUSD": "GOLD"} if broker uses GOLD) */
  ctraderSymbolMap?: Record<string, string>;
  /** cTrader only: timeout in ms for spot price subscription (default 8000) */
  ctraderSpotPriceTimeoutMs?: number;
  /** cTrader only: max retries for getCurrentPrice (default 3) */
  ctraderSpotPriceMaxRetries?: number;
  /**
   * cTrader only: max age in minutes before probing/re-auth on pooled account sessions (default 15).
   * Set to 0 to disable proactive auth health checks.
   */
  ctraderAuthMaxAgeMinutes?: number;
  /** cTrader only: max concurrent trades to monitor per poll (default 2). Limits historical API burst to stay under 5 req/sec. */
  ctraderMonitorConcurrency?: number;
  /**
   * cTrader only: default interval (seconds) for label-vs-DB audit per account when the account does
   * not set `ctraderLabelAuditSweepSeconds`. 0 = disabled (default).
   */
  ctraderLabelAuditSweepSeconds?: number;
}

export interface AccountFilterRule {
  tradingPairs?: string[]; // Array of trading pairs to match (e.g., ["BTC/USDT", "ETH/USDT"])
  minLeverage?: number; // Minimum leverage to match
  maxLeverage?: number; // Maximum leverage to match
  signalTypes?: ('long' | 'short')[]; // Signal types to match
}

export interface AccountFilter {
  accounts: string | string[]; // Account name(s) to use when rule matches
  rules: AccountFilterRule; // Filtering rules based on order properties
}

/**
 * Per-channel trade tolerance to improve order fill rates.
 * SL, entry, and TP use a single deterministic offset toward a worse price by direction (see field docs).
 * Tolerance is applied before any rounding for exchange symbol constraints (tick size, etc.).
 */
/** Per-pair entry overrides merged onto channel defaults when a pairRules row matches. */
export interface PairRuleEntryOverrides {
  /**
   * false → market-style entry; true → limit-at-touch (cTrader) / limit-at-quote (Bybit).
   * Channel default when omitted on the rule.
   */
  useLimitOrderForEntry?: boolean;
  /** cTrader only — meaningful when useLimitOrderForEntry is false. */
  useMarketRangeForEntry?: boolean;
  /** cTrader only — boundary TP index for MARKET_RANGE. */
  maxSkippablePastTPs?: number;
}

/** Per-pair rules for a channel initiator (first match wins). */
export interface PairRule {
  /** Pairs to match; use "*" as catch-all. Aliases normalize (XAU/USD ≡ XAUUSD). */
  pairs: string[];
  /** Skip this initiator for matched pairs without error (multi-initiator continues). */
  skip?: boolean;
  entry?: PairRuleEntryOverrides;
  signalTypes?: ('long' | 'short')[];
  _comment?: string;
}

export interface TradeToleranceConfig {
  /**
   * Single percent offset moving SL toward a worse outcome for the trade (sign ignored; magnitude only):
   * - long: SL is reduced (farther below entry)
   * - short: SL is increased (farther above entry)
   */
  sl?: number;
  /**
   * Single percent offset moving entry toward a worse fill for the trade (sign ignored; magnitude only):
   * - long: entry is increased (pay more)
   * - short: entry is reduced (sell lower)
   */
  entry?: number;
  /**
   * Single percent offset applied to all TPs in the worse direction for the trade:
   * - long: TP is reduced by this percent
   * - short: TP is increased by this percent
   */
  tp?: number;
}

export interface ChannelSetConfig {
  channel: string;
  /**
   * Telegram/Discord/CSV harvester name from `harvesters`.
   * Omit when `strategy` is set (market-driven signals replace inbound messages).
   */
  harvester?: string;
  /**
   * Registered strategy name (see `src/strategies/`). When set, no harvester runs for this channel;
   * the strategy is responsible for polling/ws and may insert signals via the strategy JSON path.
   */
  strategy?: string;
  /**
   * Passed to the strategy implementation (e.g. symbol, pollIntervalMs). Shape is strategy-specific.
   */
  strategyOptions?: Record<string, unknown>;
  /**
   * Signal parser for harvested messages. Omitted for `strategy` channels (orders come from the strategy via initiators).
   */
  parser?: string;
  initiator: string; // Reference to initiator name
  monitor: 'bybit' | 'dex' | 'ctrader'; // Reference to monitor type
  breakevenAfterTPs?: number; // Per-channel override for number of TPs before breakeven (overrides monitor config)
  dynamicBreakevenAfterTPs?: boolean; // Per-channel override for dynamic breakeven threshold (overrides monitor config)
  entryTimeoutMinutes?: number; // Per-channel override for minutes to wait for entry before cancelling (overrides monitor config)
  riskPercentage?: number; // Per-channel override for percentage of account to risk (overrides initiator config)
  /**
   * Cap total portfolio worst-case loss vs account balance (human percent: 1 = 1%).
   * Blocks if existing open exposure already exceeds the cap, or if exposure + this trade would exceed it.
   * Same worst-case aggregation as prop firm pre-trade drawdown checks.
   */
  maxRisk?: number;
  baseLeverage?: number; // Per-channel base leverage (default leverage if not specified in message, also used as confidence indicator for risk adjustment)
  maxMessageStalenessMinutes?: number; // Maximum age of messages to process in minutes (messages older than this will be skipped)
  accountFilters?: AccountFilter[]; // Signal-based account filtering rules (evaluated in order, first match wins)
  useLimitOrderForBreakeven?: boolean; // When true: conditional limit at BE fill + trigger a few ticks better + backup SL slightly worse (default: false uses setTradingStop at BE only)
  /**
   * Per-channel market-style entry. When true (default), initiators use a limit at the current quote where that path exists (e.g. Bybit omits entry → limit @ last traded price).
   * When false, cTrader places native MARKET orders; other initiators may ignore or reserve this (see initiator implementation).
   */
  useLimitOrderForEntry?: boolean;
  tradeTolerance?: TradeToleranceConfig; // Adjust entry/SL/TP (worse-direction %) to increase order fill likelihood
  /** When current price is past message SL: max overshoot (as % of original entry-to-SL distance) to allow. If within tolerance, SL is moved proportionally. 0 or undefined = reject (default). E.g. 10 = allow up to 10% past SL */
  slAdjustmentTolerancePercent?: number;
  /** cTrader market orders only: max number of TPs to skip when price has already moved past them. Skipped TP quantity is redistributed to remaining valid TPs. 0 or undefined = reject if any TP is past price (default). Same index selects the MARKET_RANGE boundary TP when useMarketRangeForEntry is true (0 = TP1, 1 = TP2, …). */
  maxSkippablePastTPs?: number;
  /** cTrader only: when true, use MARKET_RANGE instead of MARKET for entries (base = current price, slippage capped to boundary TP chosen by maxSkippablePastTPs index). Validate on demo broker. */
  useMarketRangeForEntry?: boolean;
  /**
   * cTrader only: when true, allow stacked signals on the same symbol (skip per-channel symbol dedup).
   * Overrides account-level `allowConcurrentSymbolTrades` for this channel.
   */
  allowConcurrentSymbolTrades?: boolean;
  /**
   * Minimum reward-to-risk ratio (reward / risk). E.g. 2 requires at least 2:1.
   * Overrides account-level `minRiskReward` when set.
   */
  minRiskReward?: number;
  /**
   * Per-pair overrides for this channel initiator (skip, entry mode, etc.). First match wins;
   * unmatched pairs use channel-level defaults.
   */
  pairRules?: PairRule[];
}

export interface SimulationConfig {
  enabled: boolean;
  messagesFile?: string; // Path to CSV file with messages
  startDate?: string; // ISO date string - when to start simulation (optional, uses earliest message if not provided)
  speedMultiplier?: number; // How fast to play back (1.0 = real-time, 10.0 = 10x speed, 0 or Infinity = maximum speed, no delays)
  maxTradeDurationDays?: number; // Maximum days to track a trade before closing (default: 7)
}

/** Live orchestrator loop tuning (harvest wake + intervals). */
export interface OrchestratorConfig {
  /** Parser loop interval in ms (default 1000). */
  parserIntervalMs?: number;
  /** Initiator loop interval in ms (default 1000). */
  initiatorIntervalMs?: number;
}

export interface BotConfig {
  harvesters: HarvesterConfig[];
  parsers: ParserConfig[];
  accounts?: AccountConfig[]; // Exchange accounts configuration
  initiators: InitiatorConfig[];
  monitors: MonitorConfig[];
  channels: ChannelSetConfig[];
  simulation?: SimulationConfig;
  evaluation?: EvaluationConfig;
  orchestrator?: OrchestratorConfig;
  database?: {
    type?: 'sqlite' | 'postgresql';
    path?: string; // For SQLite
    url?: string; // For PostgreSQL connection string (DATABASE_URL env var takes precedence)
  };
}

/**
 * Prop Firm Rule Configuration (for custom prop firms)
 */
export interface CustomPropFirmConfig {
  name: string;
  displayName?: string;
  initialBalance?: number;
  profitTarget?: number;
  maxDrawdown?: number;
  maxDrawdownMode?: 'trailing' | 'static';
  maxDrawdownBasis?: 'initialBalance' | 'peakBalance';
  dailyDrawdown?: number;
  dailyDrawdownMode?: 'dayStartPercent' | 'swing' | 'trailing';
  minTradingDays?: number;
  minTradesPerDay?: number;
  maxRiskPerTrade?: number;
  stopLossRequired?: boolean;
  stopLossTimeLimit?: number;
  maxProfitPerDay?: number;
  maxProfitPerTrade?: number;
  minTradeDuration?: number;
  maxShortTradesPercentage?: number;
  reverseTradingAllowed?: boolean;
  reverseTradingTimeLimit?: number;
  customRules?: Record<string, any>;
}

/**
 * Evaluation Configuration
 */
export interface EvaluationConfig {
  channel: string;
  parser: string; // Parser name to use
  initiator: InitiatorConfig;
  monitor: MonitorConfig;
  propFirms: (string | CustomPropFirmConfig)[]; // Prop firm names or custom configurations
  initialBalance?: number; // Starting balance for evaluation (default: 10000)
  /** Oldest calendar day to include (inclusive). Furthest back in time for messages. */
  startDate?: string;
  /** Newest calendar day to include (inclusive, end-of-day). Latest messages; not the "lookback length". */
  endDate?: string;
  speedMultiplier?: number; // How fast to play back (0 or Infinity = maximum speed, no delays)
  maxTradeDurationDays?: number; // Maximum days to track a trade before closing (default: 7)
  tradeTolerance?: TradeToleranceConfig; // Same shape as channel tradeTolerance
  slAdjustmentTolerancePercent?: number; // When price past SL, max overshoot % to allow proportional adjustment (0 = reject)
  /** Portfolio worst-case exposure cap — same semantics as {@link ChannelSetConfig.maxRisk} */
  maxRisk?: number;
  /** Mirror {@link ChannelSetConfig.allowConcurrentSymbolTrades} for evaluation initiator */
  allowConcurrentSymbolTrades?: boolean;
  /** Mirror {@link ChannelSetConfig.useLimitOrderForEntry} */
  useLimitOrderForEntry?: boolean;
  maxSkippablePastTPs?: number;
  useMarketRangeForEntry?: boolean;
  minRiskReward?: number;
}
