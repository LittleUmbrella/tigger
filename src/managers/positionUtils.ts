import { DatabaseManager, Trade } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';
// @ts-ignore - bybit-api types may not be complete
import { RESTClient } from 'bybit-api';

/**
 * Helper function to close a position
 */
export async function closePosition(
  trade: Trade,
  db: DatabaseManager,
  isSimulation: boolean,
  bybitClient?: RESTClient
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
    const positions = await bybitClient.getPositionInfo({
      category: 'linear',
      symbol: symbol
    });

    if (positions.retCode === 0 && positions.result?.list) {
      const position = positions.result.list.find((p: any) => 
        p.symbol === symbol && p.positionIdx?.toString() === trade.position_id
      );

      if (position && parseFloat(position.size || '0') !== 0) {
        // Close the position by placing an opposite order
        const side = position.side === 'Buy' ? 'Sell' : 'Buy';
        const qty = position.size;

        const closeOrder = await bybitClient.submitOrder({
          category: 'linear',
          symbol: symbol,
          side: side,
          orderType: 'Market',
          qty: qty,
          reduceOnly: true,
          positionIdx: parseInt(trade.position_id)
        });

        if (closeOrder.retCode === 0) {
          logger.info('Position closed on exchange', {
            tradeId: trade.id,
            tradingPair: trade.trading_pair,
            orderId: closeOrder.result?.orderId
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

