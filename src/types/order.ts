export interface ParsedOrder {
  tradingPair: string;
  leverage: number;
  entryPrice: number;
  stopLoss: number;
  takeProfits: number[];
  signalType: 'long' | 'short';
  entryTargets?: number[]; // Multiple entry prices
}

