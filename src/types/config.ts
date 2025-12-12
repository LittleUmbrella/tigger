export interface HarvesterConfig {
  name: string;
  channel: string;
  apiId: number;
  phone?: string;
  password?: string;
  accessHash?: string;
  pollInterval?: number; // milliseconds
  downloadImages?: boolean; // Whether to download and store images from messages (default: false)
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

export interface ParserConfig {
  name: string;
  channel: string;
  ollama?: OllamaConfig; // LLM fallback configuration (only for LLM parsers)
  // Parser-specific config can be added here
}

/**
 * Exchange account configuration
 */
export interface AccountConfig {
  name: string; // Unique name for this account (e.g., 'main', 'account1', 'testnet')
  exchange: 'bybit' | string; // Exchange type
  apiKey?: string; // API key (can also use environment variables)
  apiSecret?: string; // API secret (can also use environment variables)
  testnet?: boolean; // Whether to use testnet
  // Environment variable names to use if apiKey/apiSecret not provided
  // Format: { apiKey: 'BYBIT_API_KEY', apiSecret: 'BYBIT_API_SECRET' }
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
  accounts?: string | string[]; // Account name(s) to use (from accounts config). If not specified, uses default account or env vars
  [key: string]: any; // Allow additional initiator-specific config
}

export interface MonitorConfig {
  type: 'bybit' | 'dex';
  testnet?: boolean;
  pollInterval?: number; // milliseconds
  entryTimeoutDays?: number; // days to wait for entry before cancelling
}

export interface ChannelSetConfig {
  channel: string;
  harvester: string; // Reference to harvester name
  parser: string; // Reference to parser name
  initiator: string; // Reference to initiator name
  monitor: 'bybit' | 'dex'; // Reference to monitor type
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
