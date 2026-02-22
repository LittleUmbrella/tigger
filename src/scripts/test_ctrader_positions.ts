#!/usr/bin/env node
/**
 * List cTrader open positions and pending orders
 * Verifies what's actually on the exchange.
 *
 * Usage:
 *   tsx src/scripts/test_ctrader_positions.ts
 *   npm run test-ctrader-positions
 */

import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { AccountConfig } from '../types/config.js';

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

const main = async () => {
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

  console.log('\n📋 Fetching open positions and pending orders from cTrader...\n');

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

  await client.disconnect();
};

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
