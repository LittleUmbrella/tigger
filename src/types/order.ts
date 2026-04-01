export interface ParsedOrder {
  tradingPair: string;
  leverage: number;
  entryPrice?: number; // Optional for market/current price orders
  stopLoss: number;
  takeProfits: number[];
  signalType: 'long' | 'short';
  entryTargets?: number[]; // Multiple entry prices
  /** When true, entry/zone prices in the message are informational only; cTrader uses the market order path (not limit-at-touch). */
  marketExecution?: boolean;
}

