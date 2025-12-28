export interface ParsedOrder {
  tradingPair: string;
  leverage: number;
  entryPrice?: number; // Optional for market/current price orders
  stopLoss: number;
  takeProfits: number[];
  signalType: 'long' | 'short';
  entryTargets?: number[]; // Multiple entry prices
}

