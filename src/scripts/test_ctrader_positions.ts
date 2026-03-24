#!/usr/bin/env node
/**
 * List cTrader open positions and pending orders
 * Verifies what's actually on the exchange.
 *
 * Usage:
 *   tsx src/scripts/test_ctrader_positions.ts
 *   npm run test-ctrader-positions
 *   npm run test-ctrader-positions -- --order-id=4541858   # same getOrderDetails path as monitor entry reconciliation
 *
 * Loads config.json database settings, prints pending trades, and for each cTrader pending row runs
 * previewCtraderPendingTradeBotOutcome (same logic order as live monitor, read-only).
 */

import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  CTraderClient,
  CTraderClientConfig,
  isCtraderOrderStatusFilled
} from '../clients/ctraderClient.js';
import { AccountConfig, BotConfig } from '../types/config.js';
import { CTRADER_RECONCILE_TIMEOUT_MS } from '../monitors/shared.js';
import { DatabaseManager, Trade } from '../db/schema.js';
import { previewCtraderPendingTradeBotOutcome } from '../monitors/ctraderMonitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const envPath = path.join(projectRoot, '.env-investigation');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config({ path: path.join(projectRoot, '.env') });
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

const fetchPendingTradesFromDb = async (config: BotConfig): Promise<Trade[]> => {
  const db = new DatabaseManager(config.database);
  await db.initialize();
  try {
    const pending = await db.getTradesByStatus('pending');
    pending.sort((a, b) => b.id - a.id);
    return pending;
  } finally {
    await db.close();
  }
};

const main = async () => {
  const orderIdArg = process.argv.find((a) => a.startsWith('--order-id='))?.split('=')[1]?.trim();

  const configPath = path.join(projectRoot, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as BotConfig;

  let pendingTrades: Trade[] = [];
  try {
    pendingTrades = await fetchPendingTradesFromDb(config);
    console.log('\n=== PENDING TRADES (database) ===');
    if (pendingTrades.length === 0) {
      console.log('  (none)\n');
    } else {
      for (const t of pendingTrades) {
        console.log(
          `  id=${t.id}  exchange=${t.exchange}  channel=${t.channel}  pair=${t.trading_pair}  order_id=${t.order_id ?? '-'}  position_id=${t.position_id ?? '-'}  expires_at=${t.expires_at}  account=${t.account_name ?? '-'}`
        );
      }
      console.log(`\n  (${pendingTrades.length} pending)\n`);
    }
  } catch (err) {
    console.error('⚠️ Could not load pending trades from database:', err);
  }

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

  console.log('\n📋 Fetching open positions and pending orders from cTrader...\n');

  // Same reconcile path as cTrader trade monitor (ProtoOAReconcileReq + optional symbol enrichment)
  const reconcileT0 = Date.now();
  const reconciled = await Promise.race([
    client.getOpenPositionsAndOrders(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`reconcile timeout after ${CTRADER_RECONCILE_TIMEOUT_MS}ms`)),
        CTRADER_RECONCILE_TIMEOUT_MS
      )
    )
  ]);
  const reconcileMs = Date.now() - reconcileT0;
  console.log(
    `getOpenPositionsAndOrders (monitor reconcile path): ${reconcileMs}ms → ${reconciled.positions.length} position(s), ${reconciled.orders.length} order(s)\n`
  );

  const ctraderPending = pendingTrades.filter((t) => t.exchange === 'ctrader');
  if (ctraderPending.length > 0) {
    console.log('=== LIVE BOT PREVIEW (read-only, same order as monitor) ===');
    for (const t of ctraderPending) {
      try {
        const p = await previewCtraderPendingTradeBotOutcome(t, client, {
          preFetched: { positions: reconciled.positions, orders: reconciled.orders },
        });
        const flags = [
          p.wouldPromoteActiveViaOpenPosition && 'promote_via_open_position',
          p.wouldCancelDueToExpiry && 'cancel_expiry',
          p.wouldMarkClosed && 'close_completed',
          p.wouldMarkActive && 'activate',
          p.wouldRemainPending && 'stay_pending',
        ].filter(Boolean);
        console.log(`  trade_id=${p.tradeId}  →  ${flags.join(', ') || '(none)'}`);
        console.log(`    ${p.summary}`);
        console.log(
          `    entry_fill: filled=${p.entryFillCheck.filled}` +
            (p.entryFillCheck.alreadyClosed != null
              ? ` alreadyClosed=${p.entryFillCheck.alreadyClosed}`
              : '') +
            (p.entryFillCheck.positionId != null ? ` positionId=${p.entryFillCheck.positionId}` : '') +
            (p.entryFillCheck.exitPrice != null ? ` exit=${p.entryFillCheck.exitPrice}` : '') +
            (p.entryFillCheck.pnl != null ? ` pnl=${p.entryFillCheck.pnl}` : '')
        );
      } catch (e) {
        console.log(`  trade_id=${t.id}  →  preview error: ${e}`);
      }
    }
    console.log('');
  }

  const positions = await client.getOpenPositions();
  const orders = await client.getOpenOrders();

  console.log('=== OPEN POSITIONS ===');
  if (positions.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const p of positions) {
      const sym = p.symbolName || p.symbol || '?';
      const side = p.tradeSide || p.side || '?';
      const vol = p.volume ?? p.quantity ?? '?';
      const price = p.avgPrice ?? p.averagePrice ?? p.price ?? '?';
      const sl = p.stopLoss ?? '-';
      const tp = p.takeProfit ?? '-';
      console.log(`  ${sym} ${side} | vol: ${vol} | avg: ${price} | SL: ${sl} | TP: ${tp} | posId: ${p.positionId ?? p.id}`);
    }
    console.log('');
  }

  console.log('=== PENDING ORDERS ===');
  if (orders.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const o of orders) {
      const orderId = typeof o.orderId === 'object' && o.orderId?.low != null ? o.orderId.low : o.orderId ?? o.id;
      const type = o.orderType ?? '?';
      const status = o.orderStatus ?? '?';
      const limitPrice = o.limitPrice ?? o.executionPrice ?? o.stopPrice ?? '?';
      const td = o.tradeData || {};
      const vol = typeof td.volume === 'object' && td.volume?.low != null ? td.volume.low : td.volume ?? o.volume ?? '?';
      const symbolId = typeof td.symbolId === 'object' && td.symbolId?.low != null ? td.symbolId.low : td.symbolId;
      console.log(`  orderId: ${orderId} | symbolId: ${symbolId} | ${type} | status: ${status} | limit: ${limitPrice} | vol: ${vol}`);
    }
    console.log('');
  }

  console.log(`Summary: ${positions.length} position(s), ${orders.length} order(s)`);

  if (orderIdArg) {
    const od = await client.getOrderDetails(orderIdArg);
    console.log('\n=== getOrderDetails (monitor entry reconciliation) ===');
    if (!od?.order) {
      console.log(`  No order payload for id ${orderIdArg}`);
    } else {
      const st = od.order.orderStatus ?? od.order.order_status;
      const filled = isCtraderOrderStatusFilled(od.order);
      const dealCount = Array.isArray(od.deals) ? od.deals.length : 0;
      console.log(
        `  orderId=${orderIdArg}  orderStatus=${st}  isCtraderOrderStatusFilled=${filled}  deals=${dealCount}`
      );
    }
  }

  await client.disconnect();
};

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
