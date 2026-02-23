#!/usr/bin/env tsx
/**
 * Loggly connection diagnostic
 *
 * Tests Loggly API configuration and search capability.
 * Run: npm run loggly-diagnose
 *
 * Requires .env-investigation or .env to be loaded (use: npx dotenv -e .env-investigation -- tsx src/scripts/loggly_diagnose.ts)
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createLogglyApiClient,
  getLogglyConfigStatus,
} from '../utils/logglyApiClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Load env
const envInvestigation = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envInvestigation)) {
  dotenv.config({ path: envInvestigation });
  console.log('Loaded .env-investigation');
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log('Loaded .env');
} else {
  dotenv.config();
}

async function main() {
  console.log('\n🔍 Loggly configuration diagnostic\n');

  const status = getLogglyConfigStatus();
  console.log('Config status:', {
    configured: status.configured,
    subdomain: status.subdomain ? `${status.subdomain}.loggly.com` : '(not set)',
    tokenSource: status.tokenSource ?? '(none)',
    missing: status.missing.length ? status.missing : 'none',
  });

  if (!status.configured) {
    console.log('\n❌ Loggly is NOT configured.');
    console.log('\n' + status.hint);
    console.log('\nFor investigation Loggly searches, add to .env-investigation:');
    console.log('  LOGGLY_SUBDOMAIN=your-subdomain');
    console.log('  LOGGLY_API_TOKEN=your-api-token');
    console.log('\nGet an API token: Loggly Dashboard → Settings → API Tokens');
    process.exit(1);
  }

  console.log('\n✅ Config looks good. Testing API connection...\n');

  const client = createLogglyApiClient();
  if (!client) {
    console.log('❌ createLogglyApiClient returned null despite configured status');
    process.exit(1);
  }

  try {
    // Simple search - last 1 hour, any logs
    const result = await client.search({
      query: '*',
      from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      until: new Date().toISOString(),
      size: 5,
    });

    const count = result.events?.length ?? result.total_events ?? 0;
    console.log('✅ Loggly API responding. Sample search returned', count, 'event(s)');

    if (result.events?.length) {
      console.log('\nSample event (first field):', JSON.stringify(result.events[0], null, 2).slice(0, 300) + '...');
    }

    console.log('\n✅ Loggly searches are working.\n');
    process.exit(0);
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log('❌ Loggly API error:', err.message);

    if (err.message.includes('401')) {
      console.log('\nPossible fixes:');
      console.log('  - Use a valid API token (not the customer token for logging)');
      console.log('  - Loggly Dashboard → Settings → API Tokens → Create');
      console.log('  - If using Basic Auth, set LOGGLY_USERNAME to your Loggly login email');
    }

    process.exit(1);
  }
}

main();
