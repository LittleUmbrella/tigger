/**
 * Query Bybit demo accounts (BYBIT_DEMO_* env from config) for executions, closed PnL,
 * and position in a single UTC day. Bybit requires startTime/endTime span ≤ 7 days.
 */

import { RestClientV5 } from 'bybit-api';
import { getBybitField } from '../../utils/bybitFieldHelper.js';

export interface QueryBybitDayWindowOptions {
  /** YYYY-MM-DD (UTC calendar day) */
  day: string;
  /** Default BTCUSDT */
  symbol?: string;
}

export interface QueryBybitDayWindowExecutionRow {
  execQty: string | undefined;
  closedSize: string | undefined;
  execPrice: string | undefined;
  side: string | undefined;
  execType: string | undefined;
  orderType: string | undefined;
  orderId: string | undefined;
  execTime: string | undefined;
  isMaker: string | undefined;
  execTimeIso: string | null;
}

export interface QueryBybitDayWindowClosedRow {
  closedSize: string | undefined;
  closedPnl: string | undefined;
  avgEntryPrice: string | undefined;
  avgExitPrice: string | undefined;
  side: string | undefined;
  orderId: string | undefined;
  createdTime: string | undefined;
  updatedTime: string | undefined;
}

export interface QueryBybitDayWindowAccountResult {
  label: string;
  skipped?: boolean;
  skipReason?: string;
  execRetCode?: number;
  execRetMsg?: string;
  executionCount?: number;
  executions?: QueryBybitDayWindowExecutionRow[];
  executionsNear0088?: QueryBybitDayWindowExecutionRow[];
  closedRetCode?: number;
  closedRetMsg?: string;
  closedPnlRows?: QueryBybitDayWindowClosedRow[];
  positionRetCode?: number;
  positionList?: unknown[];
}

export interface QueryBybitDayWindowResult {
  day: string;
  symbol: string;
  dayStartIso: string;
  dayEndIso: string;
  accounts: QueryBybitDayWindowAccountResult[];
}

function dayBoundsUtc(yyyyMmDd: string): { start: number; end: number; startIso: string; endIso: string } {
  const start = Date.parse(`${yyyyMmDd}T00:00:00.000Z`);
  const end = Date.parse(`${yyyyMmDd}T23:59:59.999Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`Invalid day: ${yyyyMmDd} (expected YYYY-MM-DD)`);
  }
  return {
    start,
    end,
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
  };
}

function makeDemoClient(
  keyVar: string,
  secretVar: string
): RestClientV5 | null {
  const key = process.env[keyVar];
  const secret = process.env[secretVar];
  if (!key || !secret) return null;
  return new RestClientV5({
    key,
    secret,
    testnet: false,
    baseUrl: 'https://api-demo.bybit.com',
  });
}

/**
 * Pull linear executions, closed PnL, and position snapshot for configured demo accounts.
 */
export async function runQueryBybitDayWindow(
  options: QueryBybitDayWindowOptions
): Promise<QueryBybitDayWindowResult> {
  const symbol = (options.symbol || 'BTCUSDT').replace('/', '').toUpperCase();
  const { start, end, startIso, endIso } = dayBoundsUtc(options.day);

  const accountDefs: { label: string; c: RestClientV5 | null }[] = [
    {
      label: 'demo (api-demo)',
      c: makeDemoClient('BYBIT_DEMO_API_KEY', 'BYBIT_DEMO_API_SECRET'),
    },
    {
      label: 'hyrotrader_challenge1 (api-demo)',
      c: makeDemoClient(
        'BYBIT_DEMO_API_KEY_HYROTRADER_CHALLENGE1',
        'BYBIT_DEMO_API_SECRET_HYROTRADER_CHALLENGE1'
      ),
    },
  ];

  const accounts: QueryBybitDayWindowAccountResult[] = [];

  for (const { label, c } of accountDefs) {
    if (!c) {
      accounts.push({
        label,
        skipped: true,
        skipReason: 'Missing API credentials in environment',
      });
      continue;
    }

    const exec = await c.getExecutionList({
      category: 'linear',
      symbol,
      startTime: start,
      endTime: end,
      limit: 100,
    });

    const list = (exec.result?.list as any[]) || [];
    const rows: QueryBybitDayWindowExecutionRow[] = list.map((e) => ({
      execQty: getBybitField(e, 'execQty', 'exec_qty'),
      closedSize: getBybitField(e, 'closedSize', 'closed_size'),
      execPrice: getBybitField(e, 'execPrice', 'exec_price'),
      side: getBybitField(e, 'side'),
      execType: getBybitField(e, 'execType', 'exec_type'),
      orderType: getBybitField(e, 'orderType', 'order_type'),
      orderId: getBybitField(e, 'orderId', 'order_id'),
      execTime: getBybitField(e, 'execTime', 'exec_time'),
      isMaker: getBybitField(e, 'isMaker', 'is_maker'),
      execTimeIso: null,
    }));

    const withTime: QueryBybitDayWindowExecutionRow[] = rows.map((r) => ({
      ...r,
      execTimeIso:
        r.execTime && parseInt(r.execTime, 10) > 0
          ? new Date(parseInt(r.execTime, 10)).toISOString()
          : null,
    }));
    withTime.sort(
      (a, b) => parseInt(a.execTime || '0', 10) - parseInt(b.execTime || '0', 10)
    );

    const near088 = withTime.filter((r) => {
      const q = parseFloat(r.execQty || '0');
      return Math.abs(q - 0.088) < 0.0001;
    });

    const closed = await c.getClosedPnL({
      category: 'linear',
      symbol,
      startTime: start,
      endTime: end,
      limit: 50,
    });

    let closedPnlRows: QueryBybitDayWindowClosedRow[] | undefined;
    if (closed.result?.list?.length) {
      closedPnlRows = (closed.result.list as any[]).map((r) => ({
        closedSize: getBybitField(r, 'closedSize', 'closed_size'),
        closedPnl: getBybitField(r, 'closedPnl', 'closed_pnl'),
        avgEntryPrice: getBybitField(r, 'avgEntryPrice', 'avg_entry_price'),
        avgExitPrice: getBybitField(r, 'avgExitPrice', 'avg_exit_price'),
        side: getBybitField(r, 'side'),
        orderId: getBybitField(r, 'orderId', 'order_id'),
        createdTime: getBybitField(r, 'createdTime', 'created_time'),
        updatedTime: getBybitField(r, 'updatedTime', 'updated_time'),
      }));
    }

    const pos = await c.getPositionInfo({ category: 'linear', symbol });

    accounts.push({
      label,
      execRetCode: exec.retCode,
      execRetMsg: exec.retMsg ?? undefined,
      executionCount: withTime.length,
      executions: withTime,
      executionsNear0088: near088,
      closedRetCode: closed.retCode,
      closedRetMsg: closed.retMsg ?? undefined,
      closedPnlRows,
      positionRetCode: pos.retCode,
      positionList: pos.result?.list ?? [],
    });
  }

  return {
    day: options.day,
    symbol,
    dayStartIso: startIso,
    dayEndIso: endIso,
    accounts,
  };
}
