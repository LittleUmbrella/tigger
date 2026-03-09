#!/usr/bin/env node
/**
 * cTrader Orders Today - Chronology & Reasons
 *
 * Fetches ALL orders (open + closed) from cTrader exchange for today,
 * correlates with DB trades/messages, and explains why each was created.
 *
 * Usage:
 *   tsx src/scripts/ctrader_orders_today.ts
 *   tsx src/scripts/ctrader_orders_today.ts --date 2026-03-09
 *   npm run ctrader-orders-today
 */

import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { DatabaseManager } from '../db/schema.js';
import { AccountConfig } from '../types/config.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

if (fs.existsSync(path.join(projectRoot, '.env-investigation'))) {
  dotenv.config({ path: path.join(projectRoot, '.env-investigation') });
} else {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

// ProtoOAOrderType: MARKET=1, LIMIT=2, STOP=3, STOP_LOSS_TAKE_PROFIT=4, MARKET_RANGE=5, STOP_LIMIT=6
const ORDER_TYPE_NAMES: Record<number, string> = {
  1: 'MARKET',
  2: 'LIMIT',
  3: 'STOP',
  4: 'STOP_LOSS_TAKE_PROFIT',
  5: 'MARKET_RANGE',
  6: 'STOP_LIMIT'
};

// ProtoOAOrderStatus: ACCEPTED=1, FILLED=2, REJECTED=3, EXPIRED=4, CANCELLED=5
const ORDER_STATUS_NAMES: Record<number, string> = {
  1: 'ACCEPTED',
  2: 'FILLED',
  3: 'REJECTED',
  4: 'EXPIRED',
  5: 'CANCELLED'
};

function extractOrderId(o: any): string {
  const raw = o.orderId ?? o.id;
  const num = protobufLongToNumber(raw);
  return num != null ? String(num) : (raw != null ? String(raw) : '?');
}

function extractPositionId(o: any): string | undefined {
  const raw = o.positionId ?? o.position_id;
  if (raw == null) return undefined;
  const num = protobufLongToNumber(raw);
  return num != null ? String(num) : String(raw);
}

function extractTimestamp(ts: any): number | null {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'object' && ts.low != null) return ts.low;
  return null;
}

const getAccountCredentials = (account: AccountConfig | null) => ({
  clientId: process.env.CTRADER_CLIENT_ID,
  clientSecret: process.env.CTRADER_CLIENT_SECRET,
  accessToken: process.env.CTRADER_ACCESS_TOKEN,
  refreshToken: process.env.CTRADER_REFRESH_TOKEN,
  accountId: process.env.CTRADER_ACCOUNT_ID,
  environment: (process.env.CTRADER_ENVIRONMENT as 'demo' | 'live') || (account?.demo ? 'demo' : 'live')
});

interface EnrichedOrder {
  orderId: string;
  symbol: string;
  orderType: string;
  orderStatus: string;
  limitPrice?: number;
  stopPrice?: number;
  volume: number;
  side: string;
  positionId?: string;
  closingOrder: boolean;
  createdAt: number; // ms
  tradeId?: number;
  orderTypeRole?: 'entry' | 'take_profit' | 'stop_loss' | 'breakeven_limit';
  messageId?: string;
  channel?: string;
  contentPreview?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1];
  const targetDate = dateArg ? dayjs(dateArg).utc() : dayjs().utc();
  const dayStart = targetDate.startOf('day').valueOf();
  const dayEnd = targetDate.endOf('day').valueOf();

  const configPath = path.join(projectRoot, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const account = (config.accounts || []).find(
    (a: AccountConfig) => a.name === 'ctrader_demo' && a.exchange === 'ctrader'
  );

  const creds = getAccountCredentials(account);
  if (!creds.clientId || !creds.clientSecret || !creds.accessToken || !creds.accountId) {
    console.error('❌ Missing CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN, or CTRADER_ACCOUNT_ID');
    process.exit(1);
  }

  const client = new CTraderClient({ ...creds } as CTraderClientConfig);
  await client.connect();
  await client.authenticate();

  const db = new DatabaseManager();
  await db.initialize();

  // Build symbolId -> symbolName map
  let symbolIdToName = new Map<number, string>();
  try {
    const symbolList = await (client as any).connection.sendCommand('ProtoOASymbolsListReq', {
      ctidTraderAccountId: parseInt(creds.accountId!, 10)
    });
    const symbols = symbolList?.symbol || [];
    for (const s of symbols) {
      const id = typeof s.symbolId === 'object' && s.symbolId?.low != null ? s.symbolId.low : s.symbolId;
      if (id != null && s.symbolName != null) symbolIdToName.set(id, s.symbolName);
    }
  } catch (e) {
    console.warn('Could not fetch symbol list:', (e as Error).message);
  }

  console.log('\n=== cTrader Orders Today - Chronology & Reasons ===\n');
  console.log(`Account: ${creds.accountId} | Date: ${targetDate.format('YYYY-MM-DD')}`);
  console.log(`Window: ${new Date(dayStart).toISOString()} → ${new Date(dayEnd).toISOString()}\n`);

  // 1. Fetch open orders (from reconcile)
  const openOrders = await client.getOpenOrders();
  const openOrderIds = new Set(openOrders.map((o: any) => extractOrderId(o)));

  // 2. Fetch closed orders for today (API window = orders that *closed* in this range)
  const closedOrders = await client.getClosedOrders(dayStart, dayEnd);
  console.log(`  Fetched: ${openOrders.length} open, ${closedOrders.length} closed (in date window)\n`);

  // 3. Enrich all orders with creation time, symbol name, etc.
  const allEnriched: EnrichedOrder[] = [];

  const enrichOrder = (o: any, statusOverride?: string): EnrichedOrder | null => {
    const orderId = extractOrderId(o);
    const td = o.tradeData || {};
    const symbolId = typeof td.symbolId === 'object' && td.symbolId?.low != null ? td.symbolId.low : td.symbolId;
    const symbol = symbolId != null ? (symbolIdToName.get(symbolId) ?? `Symbol#${symbolId}`) : '?';
    const orderTypeNum = o.orderType ?? td.orderType ?? 0;
    const orderType = ORDER_TYPE_NAMES[orderTypeNum] ?? String(orderTypeNum);
    const orderStatusNum = o.orderStatus ?? td.orderStatus ?? 0;
    const orderStatus = statusOverride ?? (ORDER_STATUS_NAMES[orderStatusNum] ?? String(orderStatusNum));
    const volRaw = td.volume ?? o.volume;
    const volume = typeof volRaw === 'object' && volRaw?.low != null ? volRaw.low / 100 : (volRaw ?? 0) / 100;
    const tradeSide = td.tradeSide ?? o.tradeSide;
    const side = typeof tradeSide === 'number' ? (tradeSide === 1 ? 'BUY' : tradeSide === 2 ? 'SELL' : '?') : tradeSide ?? '?';

    // Creation time: tradeData.openTimestamp or utcLastUpdateTimestamp (cTrader uses ms)
    let createdAt = extractTimestamp(td.openTimestamp) ?? extractTimestamp(o.utcLastUpdateTimestamp);
    if (createdAt != null && createdAt < 1e12) createdAt *= 1000; // Assume seconds if small
    if (createdAt == null) createdAt = dayStart; // Fallback for open orders without timestamp

    return {
      orderId,
      symbol,
      orderType,
      orderStatus,
      limitPrice: o.limitPrice ?? o.limit_price,
      stopPrice: o.stopPrice ?? o.stop_price,
      volume,
      side,
      positionId: extractPositionId(o),
      closingOrder: !!(o.closingOrder ?? o.closing_order),
      createdAt: createdAt as number
    };
  };

  for (const o of openOrders) {
    const enriched = enrichOrder(o, 'OPEN');
    if (enriched) allEnriched.push(enriched); // Include all open orders
  }
  for (const o of closedOrders) {
    const enriched = enrichOrder(o);
    if (enriched) allEnriched.push(enriched);
  }

  // Dedupe by orderId (open takes precedence)
  const byOrderId = new Map<string, EnrichedOrder>();
  for (const e of allEnriched.sort((a, b) => a.createdAt - b.createdAt)) {
    if (!byOrderId.has(e.orderId)) byOrderId.set(e.orderId, e);
  }
  const chronological = [...byOrderId.values()].sort((a, b) => a.createdAt - b.createdAt);

  // 4. Get all cTrader trades from DB
  const activeTrades = (await db.getActiveTrades()).filter(t => t.exchange === 'ctrader');
  const closedTrades = (await db.getClosedTrades()).filter(t => t.exchange === 'ctrader');
  const uniqueTrades = [...activeTrades, ...closedTrades];

  const orderIdToDbOrder = new Map<string, { tradeId: number; orderType: string; trade: any }>();
  for (const trade of uniqueTrades) {
    const orders = await db.getOrdersByTradeId(trade.id);
    for (const ord of orders) {
      if (ord.order_id) orderIdToDbOrder.set(String(ord.order_id), {
        tradeId: trade.id,
        orderType: ord.order_type,
        trade
      });
    }
  }

  // 5. Enrich with message context
  const tradeIdToMessage = new Map<number, { messageId: string; channel: string; content: string }>();
  for (const trade of uniqueTrades) {
    try {
      const msg = await db.getMessageByMessageId(trade.message_id, trade.channel);
      if (msg) tradeIdToMessage.set(trade.id, {
        messageId: msg.message_id,
        channel: msg.channel,
        content: msg.content?.slice(0, 80) ?? ''
      });
    } catch {}
  }

  for (const e of chronological) {
    const dbInfo = orderIdToDbOrder.get(e.orderId);
    if (dbInfo) {
      e.tradeId = dbInfo.tradeId;
      e.orderTypeRole = dbInfo.orderType as any;
      e.messageId = dbInfo.trade.message_id;
      e.channel = dbInfo.trade.channel;
      const msg = tradeIdToMessage.get(dbInfo.tradeId);
      if (msg) e.contentPreview = msg.content;
    }
  }

  // 6. Output chronological report
  console.log('--- Chronological Order History ---\n');

  if (chronological.length === 0) {
    console.log('  No orders created today on cTrader.\n');
  } else {
    for (const e of chronological) {
      const time = dayjs(e.createdAt).utc().format('HH:mm:ss');
      const role = e.orderTypeRole ?? '?';
      const status = e.orderStatus === 'OPEN' ? '(open)' : `(${e.orderStatus.toLowerCase()})`;
      const price = e.limitPrice ?? e.stopPrice ?? '?';
      const reason = e.tradeId != null
        ? `Trade #${e.tradeId} | ${role} | msg ${e.messageId} ${e.channel ? `[ch ${e.channel}]` : ''}`
        : 'No matching trade in DB';
      const preview = e.contentPreview ? `\n      Signal: "${e.contentPreview}..."` : '';

      console.log(`  ${time}  Order ${e.orderId}  ${e.symbol} ${e.side} ${e.volume} @ ${price}  ${status}`);
      console.log(`      Type: ${e.orderType} | Role: ${role} | PositionId: ${e.positionId ?? '-'}`);
      console.log(`      Reason: ${reason}${preview}`);
      console.log('');
    }
  }

  // 7. Group by trade for summary
  const byTrade = new Map<number, EnrichedOrder[]>();
  for (const e of chronological) {
    if (e.tradeId != null) {
      const arr = byTrade.get(e.tradeId) ?? [];
      arr.push(e);
      byTrade.set(e.tradeId, arr);
    }
  }

  console.log('--- Summary by Trade ---\n');
  for (const [tradeId, orders] of byTrade) {
    const trade = uniqueTrades.find(t => t.id === tradeId);
    const msg = tradeIdToMessage.get(tradeId);
    const entry = orders.find(o => o.orderTypeRole === 'entry');
    const tps = orders.filter(o => o.orderTypeRole === 'take_profit');
    const sl = orders.find(o => o.orderTypeRole === 'stop_loss');
    const be = orders.find(o => o.orderTypeRole === 'breakeven_limit');

    console.log(`  Trade #${tradeId} | ${trade?.trading_pair ?? '?'} | ${trade?.status ?? '?'}`);
    console.log(`    Message: ${msg?.messageId ?? trade?.message_id} (ch ${trade?.channel})`);
    if (msg?.content) console.log(`    Content: "${msg.content.slice(0, 60)}..."`);
    console.log(`    Orders: entry=${entry?.orderId ?? '-'} | TPs=${tps.map(t => t.orderId).join(',') || '-'} | SL=${sl?.orderId ?? '-'} | BE=${be?.orderId ?? '-'}`);
    console.log('');
  }

  // 8. Orphaned orders (on exchange but not in DB)
  const dbOrderIds = new Set(orderIdToDbOrder.keys());
  const orphaned = chronological.filter(e => !dbOrderIds.has(e.orderId));
  if (orphaned.length > 0) {
    console.log('--- Orders Not in Our DB ---\n');
    for (const e of orphaned) {
      console.log(`  ${e.orderId} | ${e.symbol} ${e.side} @ ${e.limitPrice ?? e.stopPrice} | ${e.orderStatus}`);
      console.log(`    May be: manually placed, from closed/archived trade, or from another system.`);
      console.log('');
    }
  }

  console.log('=== Done ===\n');
  await client.disconnect();
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
