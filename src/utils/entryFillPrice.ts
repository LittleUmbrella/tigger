/**
 * Resolve the actual entry fill price for breakeven logic.
 *
 * For entry ranges, the order price is the worst price (limit); the actual fill
 * is often better. BE (break-even) should use the fill price, not the order price.
 *
 * Priority: entry order's filled_price in DB > position avgPrice from exchange > trade.entry_price
 */
import { Trade, DatabaseManager } from '../db/schema.js';
import { getBybitField } from './bybitFieldHelper.js';
import { normalizeCTraderSymbol } from './ctraderSymbolUtils.js';
import { logger } from './logger.js';
import { serializeErrorForLog } from './errorUtils.js';
import { withBybitRateLimitRetry } from './bybitRateLimitRetry.js';
import type { RestClientV5 } from 'bybit-api';
import type { CTraderClient } from '../clients/ctraderClient.js';

export async function getEntryFillPrice(
  trade: Trade,
  db: DatabaseManager,
  options?: { bybitClient?: RestClientV5; ctraderClient?: CTraderClient }
): Promise<number> {
  // 1. Entry order's filled_price (most reliable when set)
  const orders = await db.getOrdersByTradeId(trade.id);
  const entryOrder = orders.find((o) => o.order_type === 'entry');
  if (
    entryOrder?.status === 'filled' &&
    entryOrder.filled_price != null &&
    entryOrder.filled_price > 0
  ) {
    return entryOrder.filled_price;
  }

  // 2. Position avgPrice from exchange (real-time source of truth)
  if (options?.bybitClient && trade.exchange === 'bybit' && trade.position_id) {
    try {
      const symbol = trade.trading_pair.replace('/', '');
      const positions = await withBybitRateLimitRetry(() =>
        options.bybitClient!.getPositionInfo({
          category: 'linear',
          symbol,
        })
      );
      if (positions.retCode === 0 && positions.result?.list) {
        const position = positions.result.list.find((p: any) => {
          const pSize = parseFloat(getBybitField<string>(p, 'size') || '0');
          const positionIdx = getBybitField<string | number>(
            p,
            'positionIdx',
            'position_idx'
          );
          return (
            p.symbol === symbol &&
            pSize !== 0 &&
            String(positionIdx ?? '0') === String(trade.position_id ?? '0')
          );
        });
        if (position) {
          const avgPrice = parseFloat(
            getBybitField<string>(position, 'avgPrice', 'avg_price') ||
              getBybitField<string>(position, 'avgEntryPrice', 'avg_entry_price') ||
              '0'
          );
          if (avgPrice > 0) {
            logger.debug('Using Bybit position avgPrice for BE', {
              tradeId: trade.id,
              fillPrice: avgPrice,
              orderPrice: trade.entry_price,
            });
            return avgPrice;
          }
        }
      }
    } catch (err) {
      logger.debug('Could not fetch Bybit position for fill price', {
        tradeId: trade.id,
        error: serializeErrorForLog(err),
      });
    }
  }

  if (options?.ctraderClient && trade.exchange === 'ctrader') {
    try {
      const symbol = normalizeCTraderSymbol(trade.trading_pair);
      const positions = await options.ctraderClient.getOpenPositions();
      const position = positions.find((p: any) => {
        const positionSymbol = p.symbolName || p.symbol;
        const volume = Math.abs(p.volume || p.quantity || 0);
        return positionSymbol === symbol && volume > 0;
      });
      if (position) {
        const avgPrice = parseFloat(
          position.avgPrice || position.averagePrice || position.price || '0'
        );
        if (avgPrice > 0) {
          logger.debug('Using cTrader position avgPrice for BE', {
            tradeId: trade.id,
            fillPrice: avgPrice,
            orderPrice: trade.entry_price,
          });
          return avgPrice;
        }
      }
    } catch (err) {
      logger.debug('Could not fetch cTrader position for fill price', {
        tradeId: trade.id,
        error: serializeErrorForLog(err),
      });
    }
  }

  // 3. Fallback to trade.entry_price (order price; may be worse than actual fill)
  return trade.entry_price;
}
