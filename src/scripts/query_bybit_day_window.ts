#!/usr/bin/env tsx
/**
 * Query Bybit (demo accounts from env) for BTCUSDT executions, closed PnL, and position
 * within a single UTC calendar day. Bybit requires startTime/endTime span ≤ 7 days; one day is safe.
 *
 * Usage:
 *   QUERY_BYBIT_DAY=2026-03-13 npx tsx src/scripts/query_bybit_day_window.ts
 *   npm run query-bybit-day
 *
 * Same data as: npm run investigate -- /query-bybit-day day:2026-03-13
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runQueryBybitDayWindow } from '../investigation/utils/queryBybitDayWindow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env-investigation');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config({ path: path.join(projectRoot, '.env') });

async function main() {
  const day = process.env.QUERY_BYBIT_DAY || '2026-03-13';
  const data = await runQueryBybitDayWindow({ day });

  console.log(
    `Day (UTC): ${data.day}  (${data.dayStartIso} .. ${data.dayEndIso})\n`
  );

  for (const a of data.accounts) {
    console.log(`${'='.repeat(72)}\n${a.label}\n${'='.repeat(72)}`);
    if (a.skipped) {
      console.log('Skipped:', a.skipReason);
      continue;
    }
    console.log(
      'getExecutionList:',
      a.execRetCode,
      a.execRetMsg,
      'rows:',
      a.executionCount ?? 0
    );
    console.log('All executions (chronological):');
    console.log(JSON.stringify(a.executions ?? [], null, 2));
    console.log('\nRows with execQty ~= 0.088:', JSON.stringify(a.executionsNear0088 ?? [], null, 2));
    console.log('\ngetClosedPnL:', a.closedRetCode, a.closedRetMsg);
    if (a.closedPnlRows?.length) {
      console.log(JSON.stringify(a.closedPnlRows, null, 2));
    }
    console.log(
      '\nCurrent position (if any): retCode',
      a.positionRetCode,
      JSON.stringify(a.positionList ?? [], null, 2)
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
