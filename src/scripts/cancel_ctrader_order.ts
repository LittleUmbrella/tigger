#!/usr/bin/env node
/**
 * Cancel a cTrader order
 *
 * Usage:
 *   tsx src/scripts/cancel_ctrader_order.ts <orderId>
 *   npm run cancel-ctrader-order 3672139
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
  const orderId = process.argv[2];
  if (!orderId) {
    console.error('Usage: npm run cancel-ctrader-order <orderId>');
    console.error('Example: npm run cancel-ctrader-order 3672139');
    process.exit(1);
  }

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

  console.log(`\nCancelling order ${orderId}...\n`);

  await client.cancelOrder(orderId);

  console.log(`✅ Order ${orderId} cancelled successfully\n`);

  await client.disconnect();
};

main().catch((e) => {
  console.error('Error:', e instanceof Error ? e.message : e);
  process.exit(1);
});
