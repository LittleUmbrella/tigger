#!/usr/bin/env tsx
/**
 * Query orders for trades - usage: npx tsx src/scripts/query_trade_orders.ts [tradeId1] [tradeId2] ...
 * Example: npx tsx src/scripts/query_trade_orders.ts 228 229
 */
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseManager } from '../db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envInvestigation = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envInvestigation)) dotenv.config({ path: envInvestigation });
else if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

async function main() {
  const db = new DatabaseManager();
  await db.initialize();
  const tids = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
  if (tids.length === 0) tids.push(228, 229); // default: message 1680 trades
  for (const tid of tids) {
    const trade = await db.getTradeWithMessage(tid);
    if (!trade) {
      console.log('Trade', tid, 'not found');
      continue;
    }
    const orders = await db.getOrdersByTradeId(tid);
    console.log('\nTrade', tid, '(' + trade.account_name + '):');
    console.log('  status:', trade.status, '| exit_price:', trade.exit_price, '| stop_loss_breakeven:', trade.stop_loss_breakeven);
    console.log('  Orders:');
    for (const o of orders) {
      const qty = (o as any).quantity != null ? ` qty=${(o as any).quantity}` : '';
      const tpIdx = (o as any).tp_index != null ? ` tp${(o as any).tp_index}` : '';
      console.log('   -', o.order_type + tpIdx, o.price != null ? '@' + o.price : '', o.status, qty, o.order_id || '(no id)');
    }
  }
  await db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
