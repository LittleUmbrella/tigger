#!/usr/bin/env tsx
/**
 * Investigate why a trade was closed - queries Bybit API for execution/closed PnL history
 * Usage: npx tsx src/scripts/investigate_trade_close.ts 228
 * Uses trade's entry_filled_at for time range.
 */
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { RestClientV5 } from 'bybit-api';
import { DatabaseManager } from '../db/schema.js';
import { BotConfig } from '../types/config.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env-investigation');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

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

  console.log(`\n=== Trade ${tradeId} (${accountName}) ${symbol} - Bybit investigation ===`);
  console.log(`Entry: ${trade.entry_price} filled at ${trade.entry_filled_at}\n`);

  const entryTime = trade.entry_filled_at ? new Date(trade.entry_filled_at).getTime() : 0;
  const startMs = entryTime > 0 ? entryTime - 60_000 : Date.now() - 24 * 60 * 60 * 1000;
  const endMs = Date.now();

  // 1. Closed PnL - all closes for this symbol in time range (chronological)
  try {
    const closedPnL = await client.getClosedPnL({
      category: 'linear',
      symbol,
      limit: 50,
      ...(startMs > 0 && { startTime: startMs }),
      ...(endMs > 0 && { endTime: endMs }),
    });
    if (closedPnL.retCode === 0 && closedPnL.result?.list?.length) {
      const list = (closedPnL.result.list as any[])
        .filter((r) => parseFloat(r.createdTime || '0') >= entryTime)
        .sort((a, b) => parseFloat(a.updatedTime || '0') - parseFloat(b.updatedTime || '0'));
      const entryTolerance = trade.entry_price * 0.02;
      const nearEntry = (p: number) => Math.abs(p - trade.entry_price) < entryTolerance;
      const relevant = list.filter(
        (r) => nearEntry(parseFloat(r.avgEntryPrice || '0')) || list.length <= 10
      );
      const show = relevant.length > 0 ? relevant : list.slice(0, 15);
      console.log(`Closed PnL records (entry ~${trade.entry_price}, ${show.length} records):\n`);
      for (const r of show) {
        const ourOrder = [trade.order_id, ...tpOrders.map((o) => o.order_id)].includes(
          getBybitField<string>(r, 'orderId', 'order_id') || ''
        );
        console.log({
          orderId: getBybitField<string>(r, 'orderId', 'order_id'),
          orderType: getBybitField<string>(r, 'orderType', 'order_type'),
          execType: getBybitField<string>(r, 'execType', 'exec_type'),
          side: getBybitField<string>(r, 'side'),
          closedSize: getBybitField<string>(r, 'closedSize', 'closed_size'),
          avgExitPrice: getBybitField<string>(r, 'avgExitPrice', 'avg_exit_price'),
          createdTime: r.createdTime ? new Date(parseInt(r.createdTime, 10)).toISOString() : null,
          ourOrder: ourOrder ? 'YES' : '*** EXTERNAL ***',
        });
      }
    } else {
      console.log('Closed PnL: no results or error', (closedPnL as any).retMsg);
    }
  } catch (e) {
    console.error('Closed PnL error:', e);
  }

  // 2. Execution list - ALL closing executions (to detect market orders or external closes)
  console.log('\n--- Execution list (all closing trades, chronological) ---');
  try {
    const execList = await client.getExecutionList({
      category: 'linear',
      symbol,
      limit: 100,
      ...(startMs > 0 && { startTime: startMs }),
      ...(endMs > 0 && { endTime: endMs }),
    });
    if (execList.retCode === 0 && execList.result?.list?.length) {
      const rawList = ((execList.result as any).list as any[]) || [];
      const list = rawList
        .filter((e: any) => {
          const et = parseFloat(getBybitField<string>(e, 'execTime', 'exec_time') || '0');
          return entryTime <= 0 || et >= entryTime;
        })
        .sort((a: any, b: any) => parseFloat(getBybitField<string>(a, 'execTime', 'exec_time') || '0') - parseFloat(getBybitField<string>(b, 'execTime', 'exec_time') || '0'));
      const ourOrderIds = new Set([trade.order_id, ...tpOrders.map((o) => o.order_id)].filter(Boolean));
      let totalOur = 0;
      let totalAll = 0;
      for (const e of list) {
        const oid = getBybitField<string>(e, 'orderId', 'order_id') || '';
        const execQty = parseFloat(getBybitField<string>(e, 'execQty', 'exec_qty') || '0');
        const execPrice = getBybitField<string>(e, 'execPrice', 'exec_price');
        const orderType = getBybitField<string>(e, 'orderType', 'order_type');
        const execType = getBybitField<string>(e, 'execType', 'exec_type');
        const side = getBybitField<string>(e, 'side');
        const execTime = getBybitField<string>(e, 'execTime', 'exec_time');
        totalAll += execQty;
        if (ourOrderIds.has(oid)) totalOur += execQty;
        const tpOrder = tpOrders.find((o) => o.order_id === oid);
        const source = ourOrderIds.has(oid) ? `TP${tpOrder?.tp_index ?? 'entry'}` : '*** EXTERNAL ***';
        console.log({
          orderId: oid.slice(0, 8) + '...',
          orderType,
          execType,
          side,
          execQty,
          execPrice,
          execTime: execTime ? new Date(parseInt(execTime, 10)).toISOString() : null,
          source,
        });
      }
      console.log(`\nTotal executed: ${totalAll} | From our orders: ${totalOur} | Position size: ${trade.quantity}`);
    } else {
      console.log('Execution list: no results');
    }
  } catch (e) {
    console.error('Execution list error:', e);
  }

  // 3. Order history - status of each TP
  console.log('\n--- TP order status (from order history) ---');
  const cancelledWithoutFill: string[] = [];
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
        if (status === 'Cancelled' && cancelType === 'CancelByReduceOnly' && parseFloat(cumExec || '0') === 0) {
          cancelledWithoutFill.push(`TP${o.tp_index}`);
        }
      } else {
        console.log(`  TP${o.tp_index}: not found in history`);
      }
    } catch (e) {
      console.log(`  TP${o.tp_index}: error -`, (e as Error).message);
    }
  }

  if (cancelledWithoutFill.length > 0) {
    console.log('\n*** INTERPRETATION ***');
    console.log(`TPs ${cancelledWithoutFill.join(', ')} were cancelled with CancelByReduceOnly (0 filled).`);
    console.log('This means the position was FULLY CLOSED by something else before those TPs could fill.');
    console.log('The remainder was closed by: stop loss, position TP, breakeven limit, or a market order.');
  }

  await db.close();
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
