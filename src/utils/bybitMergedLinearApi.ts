/**
 * Merged linear USDT + USDC REST fetches (Bybit v5 often requires settleCoin).
 */

import { RestClientV5 } from 'bybit-api';
import { getBybitField } from './bybitFieldHelper.js';
import { isOpenLinearPosition } from './bybitLinearExposure.js';
import { withBybitRateLimitRetry } from './bybitRateLimitRetry.js';

export function linearPositionRowKey(p: Record<string, unknown>): string {
  const sym = String(getBybitField<string>(p, 'symbol') ?? '');
  const idx = String(getBybitField<string | number>(p, 'positionIdx', 'position_idx') ?? '0');
  return `${sym}:${idx}`;
}

export async function fetchMergedOpenLinearPositions(client: RestClientV5): Promise<Record<string, unknown>[]> {
  const settleCoins = ['USDT', 'USDC'] as const;
  const merged = new Map<string, Record<string, unknown>>();

  for (const settleCoin of settleCoins) {
    const res = await withBybitRateLimitRetry(
      () => client.getPositionInfo({ category: 'linear', settleCoin }),
      { label: `getPositionInfo linear ${settleCoin}` }
    );
    if (res.retCode !== 0) {
      throw new Error(
        `getPositionInfo failed (${settleCoin}): retCode=${res.retCode} retMsg=${res.retMsg || ''}`
      );
    }
    const list = (res.result?.list || []) as unknown as Record<string, unknown>[];
    for (const row of list) {
      merged.set(linearPositionRowKey(row), row);
    }
  }

  return [...merged.values()].filter(isOpenLinearPosition);
}

export async function fetchMergedLinearActiveOrders(client: RestClientV5): Promise<Record<string, unknown>[]> {
  const settleCoins = ['USDT', 'USDC'] as const;
  const merged = new Map<string, Record<string, unknown>>();

  for (const settleCoin of settleCoins) {
    const res = await withBybitRateLimitRetry(
      () => client.getActiveOrders({ category: 'linear', settleCoin }),
      { label: `getActiveOrders linear ${settleCoin}` }
    );
    if (res.retCode !== 0) {
      throw new Error(
        `getActiveOrders failed (${settleCoin}): retCode=${res.retCode} retMsg=${res.retMsg || ''}`
      );
    }
    const list = (res.result?.list || []) as unknown as Record<string, unknown>[];
    for (const row of list) {
      const id = String(getBybitField<string>(row, 'orderId', 'order_id') ?? '');
      merged.set(id || `anon:${merged.size}`, row);
    }
  }

  return [...merged.values()];
}
