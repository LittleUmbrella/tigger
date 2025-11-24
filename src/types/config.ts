export interface HarvesterConfig {
  name: string;
  channel: string;
  apiId: number;
  phone?: string;
  password?: string;
  accessHash?: string;
  pollInterval?: number; // milliseconds
}

export interface ParserConfig {
  name: string;
  channel: string;
  // Parser-specific config can be added here
}

export interface InitiatorConfig {
  type: 'bybit' | 'dex';
  testnet?: boolean;
  riskPercentage: number; // percentage of account to risk
}

export interface MonitorConfig {
  type: 'bybit' | 'dex';
  pollInterval?: number; // milliseconds
  entryTimeoutDays?: number; // days to wait for entry before cancelling
}

export interface ChannelSetConfig {
  channel: string;
  harvester: string; // Reference to harvester name
  parser: string; // Reference to parser name
  initiator: 'bybit' | 'dex'; // Reference to initiator type
  monitor: 'bybit' | 'dex'; // Reference to monitor type
}

export interface SimulationConfig {
  enabled: boolean;
  messagesFile?: string; // Path to CSV file with messages
  startDate?: string; // ISO date string - when to start simulation (optional, uses earliest message if not provided)
  speedMultiplier?: number; // How fast to play back (1.0 = real-time, 10.0 = 10x speed)
  maxTradeDurationDays?: number; // Maximum days to track a trade before closing (default: 7)
}

export interface BotConfig {
  harvesters: HarvesterConfig[];
  parsers: ParserConfig[];
  initiators: InitiatorConfig[];
  monitors: MonitorConfig[];
  channels: ChannelSetConfig[];
  simulation?: SimulationConfig;
  database?: {
    path?: string;
  };
}
