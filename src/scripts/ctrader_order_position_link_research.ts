#!/usr/bin/env node
/**
 * cTrader Order-Position Link Research
 *
 * Queries cTrader open orders and our DB to diagnose whether orders are properly
 * linked to positions (positionId). Orphaned orders show "requesting position"
 * as blank in the cTrader web app and don't auto-cancel when the position closes.
 *
 * Usage:
 *   tsx src/scripts/ctrader_order_position_link_research.ts
 *   tsx src/scripts/ctrader_order_position_link_research.ts --order-id 4123825
 *   tsx src/scripts/ctrader_order_position_link_research.ts --account-id 12345678
 *   npm run ctrader-order-link-research
 */

import dotenv from 'dotenv';
import { CTraderConnection } from '../lib/ctrader/CTraderConnection.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { DatabaseManager } from '../db/schema.js';
import { AccountConfig } from '../types/config.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const envPath = path.join(projectRoot, '.env-investigation');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

function extractPositionId(o: any): string | undefined {
  const raw = o.positionId ?? o.position_id;
  if (raw == null) return undefined;
  const num = protobufLongToNumber(raw);
  return num != null ? String(num) : String(raw);
}

function extractOrderId(o: any): string {
  const raw = o.orderId ?? o.id;
  const num = protobufLongToNumber(raw);
  return num != null ? String(num) : (raw != null ? String(raw) : '?');
}

const getAccountCredentials = (account: AccountConfig | null) => {
  const environment = (process.env.CTRADER_ENVIRONMENT as 'demo' | 'live') ||
    (account?.demo ? 'demo' : 'live');
  return {
    clientId: process.env.CTRADER_CLIENT_ID,
    clientSecret: process.env.CTRADER_CLIENT_SECRET,
    accessToken: process.env.CTRADER_ACCESS_TOKEN,
    refreshToken: process.env.CTRADER_REFRESH_TOKEN,
    accountId: process.env.CTRADER_ACCOUNT_ID,
    environment
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const orderIdArg = args.find(a => a.startsWith('--order-id='))?.split('=')[1];
  const accountIdOverride = args.find(a => a.startsWith('--account-id='))?.split('=')[1];

  const configPath = path.join(projectRoot, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const account = (config.accounts || []).find(
    (a: AccountConfig) => a.name === 'ctrader_demo' && a.exchange === 'ctrader'
  );

  let creds = getAccountCredentials(account);
  if (accountIdOverride) {
    creds = { ...creds, accountId: accountIdOverride };
  }
  if (!creds.clientId || !creds.clientSecret || !creds.accessToken || !creds.accountId) {
    console.error('❌ Missing CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN, or CTRADER_ACCOUNT_ID');
    process.exit(1);
  }

  let client = new CTraderClient({ ...creds } as CTraderClientConfig);
  await client.connect();
  await client.authenticate();

  const db = new DatabaseManager();
  await db.initialize();

  console.log('\n=== cTrader Order-Position Link Research ===\n');
  console.log(`Account: ${creds.accountId} | Environment: ${creds.environment}`);
  if (orderIdArg) console.log(`Looking for order: ${orderIdArg}\n`);

  // 1. Fetch reconcile
  let rawReconcile = await client.getReconcile();
  let orderArr = rawReconcile.order ?? rawReconcile.orders ?? [];
  let orderCount = Array.isArray(orderArr) ? orderArr.length : 0;

  // If 0 orders and user asked about a specific order, try all accounts - order may be on different account
  if (orderCount === 0 && orderIdArg && creds.accessToken) {
    console.log(`No orders on account ${creds.accountId}. Checking other accounts for order ${orderIdArg}...`);
    try {
      const allAccounts = await CTraderConnection.getAccessTokenAccounts(creds.accessToken);
      await client.disconnect();
      let foundAccount: string | null = null;
      for (const acc of allAccounts || []) {
        const accId = String(acc.ctidTraderAccountId ?? acc.id ?? '');
        if (!accId || accId === 'undefined') continue;
        if (accId === creds.accountId) continue; // already checked
        const isLive = acc.live === true;
        const altClient = new CTraderClient({
          ...creds,
          accountId: accId,
          environment: isLive ? 'live' : 'demo'
        } as CTraderClientConfig);
        try {
          await altClient.connect();
          await altClient.authenticate();
          const altReconcile = await altClient.getReconcile();
          const altOrders = altReconcile.order ?? altReconcile.orders ?? [];
          const found = Array.isArray(altOrders)
            ? altOrders.find((o: any) => String(extractOrderId(o)) === String(orderIdArg))
            : null;
          if (found || (Array.isArray(altOrders) && altOrders.length > 0)) {
            console.log(`\n✓ Found on account ${accId} (${acc.live ? 'LIVE' : 'DEMO'})`);
            console.log(`  Use: CTRADER_ACCOUNT_ID=${accId} or --account-id=${accId}\n`);
            foundAccount = accId;
            client = altClient;
            creds = { ...creds, accountId: accId };
            rawReconcile = altReconcile;
            orderArr = altOrders;
            orderCount = Array.isArray(altOrders) ? altOrders.length : 0;
            break;
          }
        } catch (accErr) {
          console.log(`  Account ${accId}: ${accErr instanceof Error ? accErr.message : accErr}`);
        } finally {
          if (!foundAccount) await altClient.disconnect();
        }
      }
      if (!foundAccount) {
        console.log('  Order not found on any account. Reconnecting to primary account.');
        await client.connect();
        await client.authenticate();
      }
    } catch (e) {
      console.log(`  (Could not check other accounts: ${e instanceof Error ? e.message : e})\n`);
      await client.connect();
      await client.authenticate();
    }
  }

  console.log(`[DEBUG] Reconcile | orders: ${orderCount}`);
  if (orderCount > 0) {
    const firstOrder = orderArr[0];
    console.log(`[DEBUG] First order: orderId=${extractOrderId(firstOrder)}`);
  }
  console.log('');

  // 2. Fetch open orders and positions
  const [positions, orders] = await Promise.all([
    client.getOpenPositions(),
    client.getOpenOrders()
  ]);

  console.log('--- cTrader Open Positions ---');
  if (positions.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const p of positions) {
      const posId = extractPositionId(p);
      const sym = p.symbolName || p.symbol || '?';
      const side = p.tradeSide || p.side || '?';
      const vol = p.volume ?? p.quantity ?? '?';
      console.log(`  positionId: ${posId} | ${sym} ${side} | vol: ${vol}`);
    }
    console.log('');
  }

  console.log('--- cTrader Open Orders (positionId = "requesting position" in web app) ---');
  if (orders.length === 0) {
    console.log('  (none)\n');
  } else {
    const orphaned: any[] = [];
    for (const o of orders) {
      const orderId = extractOrderId(o);
      const positionId = extractPositionId(o);
      const closingOrder = o.closingOrder ?? o.closing_order ?? '?';
      const td = o.tradeData || {};
      const symbolId = typeof td.symbolId === 'object' && td.symbolId?.low != null ? td.symbolId.low : td.symbolId;
      const limitPrice = o.limitPrice ?? o.executionPrice ?? o.stopPrice ?? '?';
      const vol = typeof td.volume === 'object' && td.volume?.low != null ? td.volume.low : td.volume ?? o.volume ?? '?';

      const linked = positionId != null && positionId !== '';
      if (!linked) orphaned.push({ orderId, symbolId, limitPrice });

      console.log(`  orderId: ${orderId} | positionId: ${positionId ?? '(BLANK - orphaned)'} | closingOrder: ${closingOrder} | symbolId: ${symbolId} | price: ${limitPrice} | vol: ${vol}`);
    }
    if (orphaned.length > 0) {
      console.log(`\n  ⚠️  ${orphaned.length} order(s) have NO positionId (orphaned - will not auto-cancel when position closes)`);
    }
    console.log('');
  }

  // 2. Our DB: active cTrader trades and their orders
  const activeTrades = (await db.getActiveTrades()).filter(t => t.exchange === 'ctrader');
  console.log('--- Our DB: Active cTrader Trades ---');
  if (activeTrades.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const trade of activeTrades) {
      const tradeOrders = await db.getOrdersByTradeId(trade.id);
      const pendingOrders = tradeOrders.filter(o => o.status === 'pending' && o.order_id);
      console.log(`  trade ${trade.id} | ${trade.trading_pair} | position_id: ${trade.position_id ?? '(not set)'} | pending orders: ${pendingOrders.length}`);

      for (const ord of pendingOrders) {
        const exchangeOrder = orders.find((o: any) => extractOrderId(o) === String(ord.order_id));
        const positionId = exchangeOrder ? extractPositionId(exchangeOrder) : '(not on exchange?)';
        const expectedPosId = trade.position_id ?? '(trade has no position_id)';
        const mismatch = positionId && expectedPosId && positionId !== expectedPosId ? ' ⚠️ MISMATCH' : '';
        const orphaned = !positionId || positionId === '(not on exchange?)' ? ' ⚠️ ORPHANED' : '';
        console.log(`    → order ${ord.order_id} (${ord.order_type}) | exchange positionId: ${positionId} | expected: ${expectedPosId}${mismatch}${orphaned}`);
      }
    }
    console.log('');
  }

  // 3. Cross-reference: our pending orders vs exchange
  const allPendingDbOrders = (
    await Promise.all(activeTrades.map(t => db.getOrdersByTradeId(t.id)))
  ).flat().filter((o: any) => o.status === 'pending' && o.order_id);

  const dbOrderIds = new Set(allPendingDbOrders.map((o: any) => String(o.order_id)));
  const exchangeOrderIds = new Set(orders.map((o: any) => extractOrderId(o)));
  const onExchangeNotInDb = [...exchangeOrderIds].filter(id => !dbOrderIds.has(id));
  const inDbNotOnExchange = [...dbOrderIds].filter(id => !exchangeOrderIds.has(id));

  if (onExchangeNotInDb.length > 0 || inDbNotOnExchange.length > 0) {
    console.log('--- Cross-Reference ---');
    if (onExchangeNotInDb.length > 0) {
      console.log(`  Orders on exchange but NOT in our DB (possible orphaned from closed trades): ${onExchangeNotInDb.join(', ')}`);
      for (const oid of onExchangeNotInDb) {
        const o = orders.find((x: any) => extractOrderId(x) === oid);
        if (o) {
          const posId = extractPositionId(o);
          console.log(`    → ${oid} has positionId: ${posId ?? '(BLANK)'}`);
        }
      }
    }
    if (inDbNotOnExchange.length > 0) {
      console.log(`  Orders in our DB but NOT on exchange (filled/cancelled?): ${inDbNotOnExchange.join(', ')}`);
    }
    console.log('');
  }

  console.log('=== Summary ===');
  console.log(`Positions: ${positions.length} | Open orders: ${orders.length} | Active cTrader trades: ${activeTrades.length}`);
  console.log('\nIf "positionId" is blank for orders, they are not linked to a position.');
  console.log('Unlinked orders do NOT auto-cancel when the position closes.');
  console.log('Ensure placeLimitOrder is called with positionId when placing TP/SL orders.\n');

  await client.disconnect();
};

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
