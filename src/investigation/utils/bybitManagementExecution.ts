/**
 * Bybit management execution verification
 *
 * Queries Bybit execution history to confirm that management commands
 * (e.g. partial close, move SL to breakeven) actually executed on the exchange.
 */

import { RestClientV5 } from 'bybit-api';
import { logger } from '../../utils/logger.js';
import { getBybitField } from '../../utils/bybitFieldHelper.js';
import { serializeErrorForLog } from '../../utils/errorUtils.js';

export interface BybitClosingExecution {
  execId: string;
  orderId: string;
  symbol: string;
  execQty: string;
  closedSize: string;
  execTime: string;
  execPrice?: string;
  side?: string;
}

export interface BybitManagementExecutionResult {
  closingExecutionsCount: number;
  closingExecutions: BybitClosingExecution[];
  error?: string;
}

/**
 * Query Bybit for closing executions in a time window.
 * Executions with closedSize > 0 represent partial or full position closes.
 * Use this to verify that a management command (e.g. "secure half and hold with BE") executed.
 */
export async function queryBybitClosingExecutions(
  bybitClient: RestClientV5,
  fromTimestamp: number,
  toTimestamp: number,
  symbol?: string
): Promise<BybitManagementExecutionResult> {
  const result: BybitManagementExecutionResult = {
    closingExecutionsCount: 0,
    closingExecutions: []
  };

  try {
    const response = await bybitClient.getExecutionList({
      category: 'linear',
      ...(symbol && { symbol: symbol.replace('/', '') }),
      startTime: fromTimestamp,
      endTime: Math.min(toTimestamp, fromTimestamp + 7 * 24 * 60 * 60 * 1000), // Bybit max 7 days
      limit: 100
    });

    if (response.retCode !== 0 || !response.result?.list) {
      return result;
    }

    const list = response.result.list as any[];
    const closingExecutions = list.filter((e: any) => {
      const closedSize = getBybitField<string>(e, 'closedSize', 'closed_size') || '0';
      return parseFloat(closedSize) > 0;
    });

    result.closingExecutionsCount = closingExecutions.length;
    result.closingExecutions = closingExecutions.map((e: any) => ({
      execId: getBybitField<string>(e, 'execId', 'exec_id') || '',
      orderId: getBybitField<string>(e, 'orderId', 'order_id') || '',
      symbol: getBybitField<string>(e, 'symbol', 'symbol') || '',
      execQty: getBybitField<string>(e, 'execQty', 'exec_qty') || '0',
      closedSize: getBybitField<string>(e, 'closedSize', 'closed_size') || '0',
      execTime: getBybitField<string>(e, 'execTime', 'exec_time') || '',
      execPrice: getBybitField<string>(e, 'execPrice', 'exec_price'),
      side: getBybitField<string>(e, 'side', 'side')
    }));

    if (closingExecutions.length > 0) {
      logger.info('Bybit closing executions found', {
        count: closingExecutions.length,
        window: `[${new Date(fromTimestamp).toISOString()}, ${new Date(toTimestamp).toISOString()}]`,
        symbol: symbol || 'all'
      });
    }
  } catch (error) {
    logger.warn('Failed to query Bybit closing executions', {
      error: serializeErrorForLog(error)
    });
    result.error = serializeErrorForLog(error);
  }

  return result;
}
