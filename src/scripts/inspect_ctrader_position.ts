#!/usr/bin/env tsx
/**
 * Fetch cTrader deals for a position ID (numeric; strip a leading "PID" if you copy from UI).
 *
 * Usage:
 *   npx tsx src/scripts/inspect_ctrader_position.ts 2967561
 *   npx tsx src/scripts/inspect_ctrader_position.ts PID2967561
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envInv = path.join(projectRoot, '.env-investigation');
dotenv.config({ path: fs.existsSync(envInv) ? envInv : path.join(projectRoot, '.env') });

const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'object' && v !== null && 'low' in v) {
    const n = protobufLongToNumber(v as { low: number });
    return n != null && isFinite(n) ? n : null;
  }
  const n = Number(v);
  return isFinite(n) ? n : null;
};

function normalizePositionId(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (s.startsWith('PID')) return s.slice(3);
  return s;
}

const main = async () => {
  const rawArg = process.argv[2];
  if (!rawArg) {
    console.error('Usage: npx tsx src/scripts/inspect_ctrader_position.ts <positionId|PIDpositionId>');
    process.exit(1);
  }
  const positionId = normalizePositionId(rawArg);

  const creds: CTraderClientConfig = {
    clientId: process.env.CTRADER_CLIENT_ID!,
    clientSecret: process.env.CTRADER_CLIENT_SECRET!,
    accessToken: process.env.CTRADER_ACCESS_TOKEN!,
    refreshToken: process.env.CTRADER_REFRESH_TOKEN!,
    accountId: process.env.CTRADER_ACCOUNT_ID!,
    environment: (process.env.CTRADER_ENVIRONMENT as 'demo' | 'live') || 'live'
  };
  if (!creds.clientId || !creds.accountId) {
    console.error('Missing CTRADER_* credentials in .env / .env-investigation');
    process.exit(1);
  }

  const now = Date.now();
  const from = now - 365 * 24 * 60 * 60 * 1000;

  const client = new CTraderClient(creds);
  await client.connect();
  await client.authenticate();

  const deals = await client.getDealListByPositionId(positionId, from, now);
  console.log(`\nPosition ${positionId}: ${deals.length} deal(s) in last 365d window\n`);

  let sumGross = 0;
  for (const d of deals) {
    const dealId = toNum((d as any).dealId ?? (d as any).deal_id);
    const orderId = toNum((d as any).orderId ?? (d as any).order_id);
    const vol = toNum((d as any).volume ?? (d as any).filledVolume) ?? 0;
    const exec = toNum((d as any).executionPrice ?? (d as any).execution_price);
    const ts = toNum((d as any).executionTimestamp ?? (d as any).execution_timestamp);
    const cpd = (d as any).closePositionDetail ?? (d as any).close_position_detail;
    const gross = cpd != null ? toNum(cpd.grossProfit ?? cpd.gross_profit) : null;
    if (gross != null) sumGross += gross;

    console.log(
      JSON.stringify(
        {
          dealId,
          orderId,
          executionTimestamp: ts,
          executionTime: ts != null ? new Date(ts).toISOString() : undefined,
          volumeRaw: vol,
          executionPrice: exec,
          grossProfit: gross,
          closePositionDetail: cpd ?? undefined
        },
        null,
        2
      )
    );
    console.log('---');
  }

  console.log(`Sum of grossProfit on deals (where present): ${sumGross.toFixed(2)}`);
  await client.disconnect();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
