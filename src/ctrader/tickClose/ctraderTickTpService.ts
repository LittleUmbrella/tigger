import { CTraderClient } from '../../clients/ctraderClient.js';
import { DatabaseManager } from '../../db/schema.js';
import { serializeErrorForLog } from '../../utils/errorUtils.js';
import { logger } from '../../utils/logger.js';
import { normalizeCTraderSymbol } from '../../utils/ctraderSymbolUtils.js';
import { protobufLongToNumber } from '../../utils/protobufLong.js';
import { CTraderSpotStream } from './ctraderSpotStream.js';
import { buildWatchFromTrade, filledTpIndicesFromOrders } from './hydrateTickTpWatches.js';
import { TickTpRegistry } from './tickTpRegistry.js';
import { findNextTriggeredLevel } from './tickTrigger.js';
import type { TickTpWatch } from './types.js';

const toNumber = (value: unknown): number | undefined => {
  const n = protobufLongToNumber(value);
  return n != null && Number.isFinite(n) ? n : undefined;
};

const parseTpCount = (rawTakeProfits: string | undefined): number => {
  try {
    const parsed = JSON.parse(rawTakeProfits ?? '[]');
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
};

const inferPrecision = (volumeStep: number | undefined, quantity: number | undefined): number => {
  if (volumeStep != null && volumeStep > 0) {
    const decimals = String(volumeStep).split('.')[1];
    return decimals ? decimals.length : 0;
  }
  if (quantity != null && Number.isFinite(quantity)) {
    const decimals = String(quantity).split('.')[1];
    return decimals ? decimals.length : 2;
  }
  return 2;
};

const REGISTRY_DIAGNOSTIC_INTERVAL_MS = 5 * 60 * 1000;

export class CTraderTickTpService {
  public readonly registry = new TickTpRegistry();
  private readonly spotStream: CTraderSpotStream;
  private isStarted = false;
  private diagnosticInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly accountName: string,
    private readonly client: CTraderClient,
    private readonly db: DatabaseManager,
    private readonly onBreakevenCheck?: (tradeId: number, filledTpCount: number) => Promise<void>
  ) {
    this.spotStream = new CTraderSpotStream(client);
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;

    this.spotStream.start((quote) => {
      void this.handleQuote(quote.symbolId, quote.bid, quote.ask);
    });

    const activeTrades = await this.db.getActiveTrades();
    for (const trade of activeTrades) {
      if (trade.exchange !== 'ctrader') continue;
      if ((trade.account_name ?? '') !== this.accountName) continue;
      if (trade.status !== 'active') continue;
      if (parseTpCount(trade.take_profits) <= 1) continue;
      if (!trade.quantity || trade.quantity <= 0) continue;

      try {
        const symbol = normalizeCTraderSymbol(trade.trading_pair);
        const symbolInfo = await this.client.getSymbolInfo(symbol);
        const symbolId = toNumber(symbolInfo?.symbolId);
        if (symbolId == null) {
          logger.warn('Tick-close hydrate skipped: missing symbolId', {
            tradeId: trade.id,
            accountName: this.accountName,
            symbol,
            exchange: 'ctrader',
          });
          continue;
        }

        const lotSize = toNumber(symbolInfo?.lotSize);
        if (lotSize == null || lotSize <= 0) {
          logger.warn('Tick-close hydrate skipped: invalid lotSize', {
            tradeId: trade.id,
            accountName: this.accountName,
            symbol,
            lotSize: symbolInfo?.lotSize,
            exchange: 'ctrader',
          });
          continue;
        }

        const rawMin = toNumber(symbolInfo?.minVolume);
        const rawMax = toNumber(symbolInfo?.maxVolume);
        const rawStep = toNumber(symbolInfo?.stepVolume) ?? toNumber(symbolInfo?.volumeStep);
        const minVolume = rawMin != null && rawMin >= 0 ? rawMin / lotSize : undefined;
        const maxVolume = rawMax != null && rawMax > 0 ? rawMax / lotSize : undefined;
        const volumeStep = rawStep != null && rawStep > 0 ? rawStep / lotSize : undefined;
        const decimalPrecision = inferPrecision(volumeStep, trade.quantity);

        const orders = await this.db.getOrdersByTradeId(trade.id);
        const filledTpIndices = filledTpIndicesFromOrders(orders);
        const watch = buildWatchFromTrade({
          trade,
          symbolId,
          totalVolumeLots: trade.quantity,
          filledTpIndices,
          volumeStep,
          minVolume,
          maxVolume,
          decimalPrecision,
        });
        if (!watch) continue;

        watch.symbol = symbol;
        this.register(watch);
      } catch (error) {
        logger.error('Failed to hydrate tick-close watch', {
          tradeId: trade.id,
          accountName: this.accountName,
          exchange: 'ctrader',
          error: serializeErrorForLog(error),
        });
      }
    }

    this.diagnosticInterval = setInterval(() => {
      this.logRegistrySnapshot();
    }, REGISTRY_DIAGNOSTIC_INTERVAL_MS);
    this.logRegistrySnapshot();
  }

  register(watch: TickTpWatch): void {
    const alreadyTrackingSymbol = this.registry.getBySymbolId(watch.symbolId).length > 0;
    this.registry.register(watch);
    if (alreadyTrackingSymbol) return;
    void this.spotStream.ensureSubscribed(watch.symbolId).catch((error) => {
      logger.error('Failed to ensure cTrader spot subscription for tick-close', {
        tradeId: watch.tradeId,
        accountName: this.accountName,
        symbolId: watch.symbolId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error),
      });
    });
  }

  unregister(tradeId: number): void {
    const watch = this.registry.getByTradeId(tradeId);
    if (!watch) return;
    this.registry.unregister(tradeId);
    if (this.registry.getBySymbolId(watch.symbolId).length > 0) return;
    void this.spotStream.releaseSymbol(watch.symbolId).catch((error) => {
      logger.warn('Failed to release cTrader spot subscription for tick-close', {
        tradeId,
        accountName: this.accountName,
        symbolId: watch.symbolId,
        exchange: 'ctrader',
        error: serializeErrorForLog(error),
      });
    });
  }

  getFilledTpCount(tradeId: number): number {
    return this.registry.getFilledTpCount(tradeId);
  }

  async stop(): Promise<void> {
    if (this.diagnosticInterval) {
      clearInterval(this.diagnosticInterval);
      this.diagnosticInterval = undefined;
    }
    const symbolIds = this.registry.allSymbolIds();
    this.spotStream.stop();
    await Promise.all(
      symbolIds.map(async (symbolId) => {
        try {
          await this.spotStream.releaseSymbol(symbolId);
        } catch (error) {
          logger.warn('Failed to release cTrader symbol on tick-close stop', {
            accountName: this.accountName,
            symbolId,
            exchange: 'ctrader',
            error: serializeErrorForLog(error),
          });
        }
      })
    );
    this.isStarted = false;
  }

  private logRegistrySnapshot(): void {
    const watches = this.registry.allWatches();
    logger.info('Tick-close registry snapshot', {
      accountName: this.accountName,
      watchCount: watches.length,
      subscribedSymbolIds: this.registry.allSymbolIds(),
      watches: watches.map((w) => ({
        tradeId: w.tradeId,
        positionId: w.positionId,
        channel: w.channel,
        messageId: w.messageId,
        symbol: w.symbol,
        symbolId: w.symbolId,
        direction: w.direction,
        remainingVolumeLots: w.remainingVolumeLots,
        closingInFlight: w.closingInFlight,
        filledTpCount: w.levels.filter((l) => l.status === 'filled').length,
        levels: w.levels.map((l) => ({
          index: l.index,
          price: l.price,
          volumeLots: l.volumeLots,
          status: l.status,
        })),
        lastSpotAtMs: this.spotStream.getLastSpotAt(w.symbolId),
      })),
      exchange: 'ctrader',
    });
  }

  private async handleQuote(symbolId: number, bid: number, ask: number): Promise<void> {
    const watches = this.registry.getBySymbolId(symbolId);
    for (const watch of watches) {
      if (watch.closingInFlight) continue;

      const nextLevel = findNextTriggeredLevel(watch.direction, { bid, ask }, watch.levels);
      if (!nextLevel) continue;

      watch.closingInFlight = true;
      nextLevel.status = 'in_flight';

      try {
        await this.client.closePosition(watch.positionId, nextLevel.volumeLots, watch.symbol);
        nextLevel.status = 'filled';
        watch.remainingVolumeLots = Math.max(0, watch.remainingVolumeLots - nextLevel.volumeLots);
        watch.closingInFlight = false;

        const filledAt = new Date().toISOString();
        void this.db
          .insertOrder({
            trade_id: watch.tradeId,
            order_type: 'take_profit',
            order_id: `tick-close-${watch.tradeId}-${nextLevel.index}`,
            price: nextLevel.price,
            quantity: nextLevel.volumeLots,
            tp_index: nextLevel.index,
            status: 'filled',
            filled_at: filledAt,
          })
          .catch((error) => {
            logger.error('Failed to persist tick-close TP fill order', {
              tradeId: watch.tradeId,
              tpIndex: nextLevel.index,
              accountName: this.accountName,
              exchange: 'ctrader',
              error: serializeErrorForLog(error),
            });
          });

        if (this.onBreakevenCheck) {
          try {
            await this.onBreakevenCheck(watch.tradeId, this.getFilledTpCount(watch.tradeId));
          } catch (error) {
            logger.warn('Tick-close breakeven callback failed', {
              tradeId: watch.tradeId,
              accountName: this.accountName,
              exchange: 'ctrader',
              error: serializeErrorForLog(error),
            });
          }
        }
      } catch (error) {
        nextLevel.status = 'pending';
        watch.closingInFlight = false;
        logger.error('Tick-close level close failed', {
          tradeId: watch.tradeId,
          accountName: this.accountName,
          tpIndex: nextLevel.index,
          positionId: watch.positionId,
          exchange: 'ctrader',
          error: serializeErrorForLog(error),
        });
      }
    }
  }
}
