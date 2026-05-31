/** Resume mock-exchange simulation for pending eval trades (after interrupted run). */
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseManager } from '../db/schema.js';
import { createCTraderHistoricalPriceProvider } from '../utils/ctraderHistoricalPriceProvider.js';
import { createMockExchange } from '../evaluation/mockExchange.js';
import { calculatePositionSize, calculateQuantity, getQuantityPrecisionFromRiskAmount } from '../utils/positionSizing.js';
import { getCTraderSymbolInfo } from '../initiators/symbolValidator.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envInv = path.join(projectRoot, '.env-investigation');
dotenv.config({ path: fs.existsSync(envInv) ? envInv : path.join(projectRoot, '.env') });

const CHANNEL = process.argv[2] || '2845421508';
const INITIAL_BALANCE = 5000;
const BASE_LEVERAGE = 20;
const MAX_DURATION_DAYS = 7;

async function main() {
  const db = new DatabaseManager({ type: 'sqlite', path: 'data/evaluation.db' });
  await db.initialize();

  const priceProvider = createCTraderHistoricalPriceProvider(
    '2026-04-30T00:00:00.000Z',
    0,
    {
      clientId: process.env.CTRADER_CLIENT_ID || '',
      clientSecret: process.env.CTRADER_CLIENT_SECRET || '',
      accessToken: process.env.CTRADER_ACCESS_TOKEN || '',
      refreshToken: process.env.CTRADER_REFRESH_TOKEN,
      accountId: process.env.CTRADER_ACCOUNT_ID || '',
      environment: process.env.CTRADER_ENVIRONMENT === 'live' ? 'live' : 'demo',
    }
  );

  const client = priceProvider.getCTraderClient?.();
  if (client) {
    await client.connect();
    await client.authenticate();
  }

  const pending = (await db.getTradesByStatus('pending')).filter((t) => t.channel === CHANNEL);
  const active = (await db.getTradesByStatus('active')).filter((t) => t.channel === CHANNEL);
  const trades = [...pending, ...active].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  console.log(`Resuming simulation for ${trades.length} trades on channel ${CHANNEL}`);

  for (const [index, trade] of trades.entries()) {
    if (!trade.entry_price || !trade.stop_loss || !trade.risk_percentage) continue;

    const slDiff = Math.abs(trade.entry_price - trade.stop_loss);
    if (slDiff === 0) continue;

    const positionSize = calculatePositionSize(
      INITIAL_BALANCE,
      trade.risk_percentage,
      trade.entry_price,
      trade.stop_loss,
      trade.leverage || BASE_LEVERAGE,
      BASE_LEVERAGE
    );
    const riskInAsset = positionSize / trade.entry_price;
    const decimalPrecision = getQuantityPrecisionFromRiskAmount(riskInAsset);
    const quantity = calculateQuantity(positionSize, trade.entry_price, decimalPrecision);

    if (quantity > 0) {
      await db.updateTrade(trade.id, { quantity });
      const orders = await db.getOrdersByTradeId(trade.id);
      const entry = orders.find((o) => o.order_type === 'entry');
      if (entry) await db.updateOrder(entry.id, { quantity });
    }

    const exchange = createMockExchange(trade, db, priceProvider, 1, false);
    await exchange.initialize(MAX_DURATION_DAYS);
    await exchange.process();

    const statuses = ['pending', 'active', 'closed', 'stopped', 'cancelled'] as const;
    let finalStatus = 'unknown';
    for (const status of statuses) {
      const row = (await db.getTradesByStatus(status)).find((t) => t.id === trade.id);
      if (row) {
        finalStatus = row.status;
        break;
      }
    }
    console.log(`  trade #${trade.id} → ${finalStatus}`);
  }

  const closed = (await db.getTradesByStatus('closed')).filter((t) => t.channel === CHANNEL);
  const stopped = (await db.getTradesByStatus('stopped')).filter((t) => t.channel === CHANNEL);
  const cancelled = (await db.getTradesByStatus('cancelled')).filter((t) => t.channel === CHANNEL);
  const filled = [...closed, ...stopped].filter((t) => t.entry_filled_at);
  const pnl = filled.reduce((s, t) => s + (t.pnl || 0), 0);

  console.log('\nResume complete');
  console.log(`  Entry fills: ${filled.length}`);
  console.log(`  Cancelled: ${cancelled.length}`);
  console.log(`  PnL (filled only): $${pnl.toFixed(2)}`);

  await db.close();
  if (client) await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
