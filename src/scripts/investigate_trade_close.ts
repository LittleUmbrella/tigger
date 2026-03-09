#!/usr/bin/env tsx
/**
 * Investigate why a trade was closed - queries Bybit API for execution/closed PnL history
 * Usage: npx tsx src/scripts/investigate_trade_close.ts 215
 */
import 'dotenv/config';
import { RestClientV5 } from 'bybit-api';
import { DatabaseManager } from '../db/schema.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { BotConfig } from '../types/config.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const normalizeSymbol = (p: string) => p.replace('/', '').toUpperCase().replace(/USDC?$/, 'USDT');

async function getBybitClient(accountName: string, config: BotConfig | null): Promise<RestClientV5 | null> {
  const account = config?.accounts?.find((a) => a.name === accountName);
  if (!account) return null;
  const keyEnv = account.envVarNames?.apiKey || account.envVars?.apiKey;
  const secretEnv = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
  const apiKey = keyEnv ? process.env[keyEnv] : process.env.BYBIT_API_KEY;
  const apiSecret = secretEnv ? process.env[secretEnv] : process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  const demo = account.demo || false;
  const baseUrl = demo ? 'https://api-demo.bybit.com' : undefined;
  return new RestClientV5({
    key: apiKey,
    secret: apiSecret,
    testnet: account.testnet || false,
    ...(baseUrl && { baseUrl }),
  });
}

async function main() {
  const tradeId = parseInt(process.argv[2] || '215', 10);
  const configPath = process.env.CONFIG_PATH || path.join(projectRoot, 'config.json');
  const config: BotConfig | null = fs.existsSync(configPath)
    ? JSON.parse(await fs.readFile(configPath, 'utf-8'))
    : null;

  const db = new DatabaseManager();
  await db.initialize();
  const trade = await db.getTradeWithMessage(tradeId);
  if (!trade) {
    console.error('Trade not found');
    process.exit(1);
  }

  const accountName = trade.account_name || 'demo';
  const client = await getBybitClient(accountName, config);
  if (!client) {
    console.error('No Bybit client for account', accountName);
    process.exit(1);
  }

  const symbol = normalizeSymbol(trade.trading_pair);
  const orders = await db.getOrdersByTradeId(tradeId);
  const tpOrders = orders.filter((o) => o.order_type === 'take_profit' && o.order_id);

  console.log(`\n=== Trade ${tradeId} (${accountName}) - Bybit investigation ===\n`);

  // 1. Closed PnL - which order closed the position and when
  const startMs = new Date('2026-03-07T15:00:00Z').getTime();
  const endMs = new Date('2026-03-08T12:00:00Z').getTime();
  try {
    const closedPnL = await client.getClosedPnL({
      category: 'linear',
      symbol,
      startTime: startMs,
      endTime: endMs,
      limit: 50,
    });
    if (closedPnL.retCode === 0 && closedPnL.result?.list?.length) {
      const list = closedPnL.result.list as any[];
      const relevant = list.filter(
        (r) =>
          parseFloat(r.avgEntryPrice || '0') > 67000 &&
          parseFloat(r.avgEntryPrice || '0') < 69000 &&
          r.side === 'Sell'
      );
      console.log('Closed PnL records (BTC short, entry ~67800):');
      for (const r of relevant) {
        console.log({
          orderId: r.orderId,
          orderType: r.orderType,
          execType: r.execType,
          side: r.side,
          qty: r.qty,
          closedSize: r.closedSize,
          avgEntryPrice: r.avgEntryPrice,
          avgExitPrice: r.avgExitPrice,
          closedPnl: r.closedPnl,
          createdTime: r.createdTime ? new Date(parseInt(r.createdTime, 10)).toISOString() : null,
          updatedTime: r.updatedTime ? new Date(parseInt(r.updatedTime, 10)).toISOString() : null,
        });
      }
      if (relevant.length === 0) {
        console.log('(No matching records - showing all BTC closed PnL)');
        list.slice(0, 5).forEach((r) => {
          console.log({
            orderId: r.orderId,
            execType: r.execType,
            closedSize: r.closedSize,
            avgExitPrice: r.avgExitPrice,
            updatedTime: r.updatedTime ? new Date(parseInt(r.updatedTime, 10)).toISOString() : null,
          });
        });
      }
    } else {
      console.log('Closed PnL: no results or error', closedPnL.retMsg);
    }
  } catch (e) {
    console.error('Closed PnL error:', e);
  }

  // 2. Execution list - individual fills
  console.log('\n--- Execution list (trades) ---');
  try {
    const execList = await client.getExecutionList({
      category: 'linear',
      symbol,
      startTime: startMs,
      endTime: endMs,
      limit: 100,
    });
    if (execList.retCode === 0 && execList.result?.list?.length) {
      const list = (execList.result as any).list;
      // Filter for executions that could be our TPs (Buy side to close short)
      const buyExecs = list.filter((e: any) => e.side === 'Buy' && e.execType === 'Trade');
      const byOrderId = new Map<string, any[]>();
      for (const e of buyExecs) {
        const oid = getBybitField<string>(e, 'orderId', 'order_id') || '';
        if (!byOrderId.has(oid)) byOrderId.set(oid, []);
        byOrderId.get(oid)!.push(e);
      }
      const ourOrderIds = new Set([trade.order_id, ...tpOrders.map((o) => o.order_id)]);
      let totalClosed = 0;
      for (const [oid, execs] of byOrderId) {
        if (!ourOrderIds.has(oid)) continue;
        const sumQty = execs.reduce((s, x) => s + parseFloat(x.execQty || '0'), 0);
        totalClosed += sumQty;
        const tpOrder = tpOrders.find((o) => o.order_id === oid);
        console.log({
          orderId: oid,
          tpIndex: tpOrder?.tp_index,
          execCount: execs.length,
          totalExecQty: sumQty,
          execPrice: execs[0] ? getBybitField<string>(execs[0], 'execPrice', 'exec_price') : null,
          execTime: execs[0]?.['execTime'] ? new Date(parseInt(execs[0]['execTime'], 10)).toISOString() : null,
        });
      }
      console.log('Total closed from our orders:', totalClosed, '| Position size:', trade.quantity);
    } else {
      console.log('Execution list: no results');
    }
  } catch (e) {
    console.error('Execution list error:', e);
  }

  // 3. Order history - status of each TP
  console.log('\n--- TP order status (from order history) ---');
  for (const o of tpOrders) {
    try {
      const hist = await client.getHistoricOrders({
        category: 'linear',
        symbol,
        orderId: o.order_id!,
        limit: 5,
      });
      if (hist.retCode === 0 && hist.result?.list?.length) {
        const ord = (hist.result as any).list[0];
        const status = getBybitField<string>(ord, 'orderStatus', 'order_status');
        const cumExec = getBybitField<string>(ord, 'cumExecQty', 'cum_exec_qty');
        const cancelType = getBybitField<string>(ord, 'cancelType', 'cancel_type');
        console.log(`  TP${o.tp_index} (${o.price}): orderStatus=${status}, cumExecQty=${cumExec}, cancelType=${cancelType || 'N/A'}`);
      } else {
        console.log(`  TP${o.tp_index}: not found in history`);
      }
    } catch (e) {
      console.log(`  TP${o.tp_index}: error -`, (e as Error).message);
    }
  }

  await db.close();
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
