#!/usr/bin/env tsx
/**
 * Loggly message query diagnostic - tries multiple query variants to find logs.
 *
 * Usage: npm run loggly-query-message -- 817 3469900302 [messageDateISO]
 * Example: npm run loggly-query-message -- 817 3469900302 2026-02-23T15:49:28.000Z
 *
 * If messageDateISO is omitted, uses now - 24h as center (for recent messages).
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogglyApiClient, getLogglyConfigStatus } from '../utils/logglyApiClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

const messageId = process.argv[2] || '817';
const channel = process.argv[3] || '3469900302';
const messageDateArg = process.argv[4];

async function runQuery(
  client: import('../utils/logglyApiClient.js').LogglyApiClient,
  name: string,
  query: string,
  from: string,
  until: string
): Promise<{ name: string; query: string; count: number; events?: any[] }> {
  const result = await client.search({ query, from, until, size: 50 });
  const count = result.total_events ?? result.events?.length ?? 0;
  return { name, query, count, events: result.events };
}

async function main() {
  console.log('\n🔍 Loggly message query diagnostic\n');
  console.log(`Message ID: ${messageId}, Channel: ${channel}\n`);

  const status = getLogglyConfigStatus();
  if (!status.configured) {
    console.log('❌ Loggly not configured:', status.missing.join(', '));
    process.exit(1);
  }

  const client = createLogglyApiClient();
  if (!client) {
    console.log('❌ Could not create Loggly client');
    process.exit(1);
  }

  const center = messageDateArg
    ? new Date(messageDateArg)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const windowHours = 2;
  const from = new Date(center.getTime() - windowHours * 60 * 60 * 1000).toISOString();
  const until = new Date(center.getTime() + windowHours * 60 * 60 * 1000).toISOString();

  console.log(`Time window: ${from} → ${until}\n`);

  const variants: Array<[string, string]> = [
    ['json.messageId + json.channel', `json.messageId:${messageId} AND json.channel:${channel}`],
    ['messageId + channel (no prefix)', `messageId:${messageId} AND channel:${channel}`],
    ['json.message_id + json.channel', `json.message_id:${messageId} AND json.channel:${channel}`],
    ['Full-text "817" AND "channel"', `"${messageId}" AND "${channel}"`],
    ['Full-text 817 3469900302', `${messageId} ${channel}`],
    ['Tag tigger-bot only', `tag:tigger-bot`],
  ];

  console.log('Trying query variants:\n');

  for (const [name, query] of variants) {
    try {
      const r = await runQuery(client, name, query, from, until);
      const icon = r.count > 0 ? '✅' : '❌';
      console.log(`  ${icon} ${name}`);
      console.log(`     Query: ${query}`);
      console.log(`     Results: ${r.count}\n`);

      if (r.count > 0 && r.events?.length) {
        const sample = r.events[0];
        const event = sample.event ?? sample;
        const keys = typeof event === 'object' ? Object.keys(event).slice(0, 15) : [];
        console.log(`     Sample event keys: ${keys.join(', ')}`);
        if (event?.message) console.log(`     Sample message: ${String(event.message).slice(0, 80)}...`);
        console.log('');
      }
    } catch (e) {
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  console.log('Done. If json.messageId returned 0, check Loggly Dynamic Field Explorer');
  console.log('for the actual field names used for your log type.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
