import { DatabaseManager, Trade } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
import { RestClientV5 } from 'bybit-api';
import { getBybitField } from '../utils/bybitFieldHelper.js';

/**
 * Helper function to close a position
 */
export async function closePosition(
  trade: Trade,
  db: DatabaseManager,
  isSimulation: boolean,
  bybitClient?: RestClientV5
): Promise<void> {
  if (isSimulation) {
    // In simulation, just mark as closed
    await db.updateTrade(trade.id, {
      status: 'closed',
      exit_filled_at: dayjs().toISOString()
    });
    logger.info('Simulated position close', {
      tradeId: trade.id,
      tradingPair: trade.trading_pair
    });
  } else if (trade.exchange === 'bybit' && bybitClient && trade.position_id) {
    const symbol = trade.trading_pair.replace('/', '');
    
    // Get current position info
    const positions = await bybitClient.getPositionInfo({ category: 'linear', symbol });

    if (positions.retCode === 0 && positions.result && positions.result.list) {
      const position = positions.result.list.find((p: any) => {
        const positionIdx = getBybitField<string | number>(p, 'positionIdx', 'position_idx');
        return p.symbol === symbol && positionIdx?.toString() === trade.position_id;
      });

      const positionSize = getBybitField<string>(position, 'size');
      if (position && parseFloat(positionSize || '0') !== 0) {
        // Close the position by placing an opposite order
        const side = position.side === 'Buy' ? 'Sell' : 'Buy';
        const qty = parseFloat(positionSize || '0');

        const closeOrder = await bybitClient.submitOrder({
          category: 'linear',
          symbol: symbol,
          side: side,
          orderType: 'Market',
          qty: qty.toString(),
          timeInForce: 'IOC',
          reduceOnly: true,
          closeOnTrigger: false,
          positionIdx: parseInt(trade.position_id || '0') as 0 | 1 | 2
        });

        if (closeOrder.retCode === 0 && closeOrder.result) {
          logger.info('Position closed on exchange', {
            tradeId: trade.id,
            tradingPair: trade.trading_pair,
            orderId: getBybitField<string>(closeOrder.result, 'orderId', 'order_id') || 'unknown'
          });

          // Update trade status - the monitor will detect the closure and update with PNL
          await db.updateTrade(trade.id, {
            status: 'closed',
            exit_filled_at: dayjs().toISOString()
          });
        } else {
          throw new Error(`Failed to close position: ${JSON.stringify(closeOrder)}`);
        }
      } else {
        // Position already closed
        await db.updateTrade(trade.id, {
          status: 'closed',
          exit_filled_at: dayjs().toISOString()
        });
      }
    }
  }
}

