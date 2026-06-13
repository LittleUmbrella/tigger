export type TickTpLevelStatus = 'pending' | 'in_flight' | 'filled';

export type TickTpLevel = {
  index: number;
  price: number;
  volumeLots: number;
  status: TickTpLevelStatus;
};

export type TickTpWatch = {
  tradeId: number;
  positionId: string;
  channel: string;
  messageId: string;
  accountName: string;
  symbol: string;
  symbolId: number;
  direction: 'long' | 'short';
  remainingVolumeLots: number;
  levels: TickTpLevel[];
  closingInFlight: boolean;
};

export type SpotQuote = { bid: number; ask: number; symbolId: number; timestampMs?: number };
