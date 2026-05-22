#!/usr/bin/env tsx
/**
 * Query Loggly for cTrader startup auth logs (post-deploy verification).
 *
 * Usage:
 *   npm run check-ctrader-startup-auth
 *   tsx src/scripts/check_ctrader_startup_auth_logs.ts
 *   tsx src/scripts/check_ctrader_startup_auth_logs.ts --minutes 60
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogglyApiClient } from '../utils/logglyApiClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const envInvestigation = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envInvestigation)) {
  dotenv.config({ path: envInvestigation });
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const parseMinutes = (): number => {
  const idx = process.argv.indexOf('--minutes');
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = parseInt(process.argv[idx + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 45;
};

async function main() {
  const client = createLogglyApiClient();
  if (!client) {
    console.error('Loggly not configured (LOGGLY_TOKEN, LOGGLY_SUBDOMAIN)');
    process.exit(1);
  }

  const minutes = parseMinutes();
  const until = new Date().toISOString();
  const from = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const r = await client.search({
    query: '"cTrader startup auth"',
    from,
    until,
    size: 50,
  });

  console.log(`\n🔍 cTrader startup auth logs`);
  console.log(`   Window: ${from} → ${until} (${minutes}m)\n`);
  console.log(`   Events: ${r.total_events ?? 0}\n`);

  if (!r.events?.length) {
    console.log('   (none — widen --minutes or confirm deploy/restart ran)\n');
    return;
  }

  for (const e of r.events) {
    const j = e.event?.json ?? {};
    console.log(
      [
        j.timestamp,
        j.level,
        j.message,
        j.accountName ? `acct=${j.accountName}` : '',
        j.missing ? `missing=${j.missing}` : '',
        j.accountId ? `id=${j.accountId}` : '',
        j.accountCount != null ? `count=${j.accountCount}` : '',
        j.total != null ? `total=${j.total}` : '',
        j.succeeded != null ? `ok=${j.succeeded}` : '',
        j.failed != null ? `fail=${j.failed}` : '',
        j.failedAccounts ? `failed=${JSON.stringify(j.failedAccounts)}` : '',
        j.succeededAccounts ? `okAccts=${JSON.stringify(j.succeededAccounts)}` : '',
        j.accountNames ? `accounts=${JSON.stringify(j.accountNames)}` : '',
        j.error ? `err=${String(j.error).slice(0, 120)}` : '',
      ]
        .filter(Boolean)
        .join(' | ')
    );
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
