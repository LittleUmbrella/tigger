import type { CTraderClient, CTraderSpotQuoteHandler } from '../../clients/ctraderClient.js';
import type { SpotQuote } from './types.js';

export class CTraderSpotStream {
  private lastSpotAt = new Map<number, number>();
  private unsubscribeHandler?: () => void;

  constructor(private readonly client: CTraderClient) {}

  start(onQuote: (quote: SpotQuote) => void): void {
    if (this.unsubscribeHandler) return;
    const handler: CTraderSpotQuoteHandler = ({ symbolId, bid, ask, timestampMs }) => {
      this.lastSpotAt.set(symbolId, Date.now());
      onQuote({ symbolId, bid, ask, timestampMs });
    };
    this.unsubscribeHandler = this.client.onSpotQuote(handler);
  }

  stop(): void {
    this.unsubscribeHandler?.();
    this.unsubscribeHandler = undefined;
  }

  async ensureSubscribed(symbolId: number): Promise<void> {
    await this.client.addPersistentSpotSubscription(symbolId);
  }

  async releaseSymbol(symbolId: number): Promise<void> {
    await this.client.removePersistentSpotSubscription(symbolId);
  }

  getLastSpotAt(symbolId: number): number | undefined {
    return this.lastSpotAt.get(symbolId);
  }
}
