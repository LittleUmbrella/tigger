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
  platform?: 'telegram' | 'discord'; // Platform type (default: 'telegram' for backward compatibility)
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
  exchange: 'bybit' | string; // Exchange type
  testnet?: boolean; // Whether to use testnet (deprecated: use demo for demo trading)
  demo?: boolean; // Whether to use demo trading (uses api-demo.bybit.com endpoint)
  // Environment variable names that contain the API credentials
  // These should be the names of environment variables (e.g., 'BYBIT_API_KEY'), not the actual values
  // Format: { apiKey: 'BYBIT_API_KEY', apiSecret: 'BYBIT_API_SECRET' }
  // Using envVarNames allows config.json to be safely committed to version control
  envVarNames?: {
    apiKey: string; // Name of environment variable containing the API key
    apiSecret: string; // Name of environment variable containing the API secret
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
  type: 'bybit' | 'dex';
  testnet?: boolean;
  pollInterval?: number; // milliseconds
  entryTimeoutDays?: number; // days to wait for entry before cancelling
  breakevenAfterTPs?: number; // Number of take profits to hit before moving stop loss to breakeven (default: 1)
}

export interface ChannelSetConfig {
  channel: string;
  harvester: string; // Reference to harvester name
  parser: string; // Reference to parser name
  initiator: string; // Reference to initiator name
  monitor: 'bybit' | 'dex'; // Reference to monitor type
  breakevenAfterTPs?: number; // Per-channel override for number of TPs before breakeven (overrides monitor config)
  baseLeverage?: number; // Per-channel base leverage (default leverage if not specified in message, also used as confidence indicator for risk adjustment)
  maxMessageStalenessMinutes?: number; // Maximum age of messages to process in minutes (messages older than this will be skipped)
}

export interface SimulationConfig {
  enabled: boolean;
  messagesFile?: string; // Path to CSV file with messages
  startDate?: string; // ISO date string - when to start simulation (optional, uses earliest message if not provided)
  speedMultiplier?: number; // How fast to play back (1.0 = real-time, 10.0 = 10x speed, 0 or Infinity = maximum speed, no delays)
  maxTradeDurationDays?: number; // Maximum days to track a trade before closing (default: 7)
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
  dailyDrawdown?: number;
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
  startDate?: string; // ISO date string - when to start evaluation (optional, uses earliest message if not provided)
  speedMultiplier?: number; // How fast to play back (0 or Infinity = maximum speed, no delays)
  maxTradeDurationDays?: number; // Maximum days to track a trade before closing (default: 7)
}
