#!/usr/bin/env tsx
/**
 * Query Loggly Script
 * 
 * Standalone script to query Loggly logs directly.
 * Useful for testing and manual investigation.
 * 
 * Usage:
 *   npm run query-loggly -- search "messageId:12345 AND channel:2394142145"
 *   npm run query-loggly -- message 12345 2394142145
 *   npm run query-loggly -- errors "2025-01-15T10:30:00Z" 5
 */

import { createLogglyClient } from '../utils/logglyClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const client = createLogglyClient();
  
  if (!client) {
    console.error('Error: Loggly client not configured.');
    console.error('Set LOGGLY_SUBDOMAIN and LOGGLY_API_TOKEN (or LOGGLY_TOKEN) environment variables.');
    process.exit(1);
  }

  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case 'search': {
        const query = args.join(' ');
        if (!query) {
          console.error('Usage: npm run query-loggly -- search "<query>"');
          process.exit(1);
        }
        const result = await client.search({ query, size: 100 });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'message': {
        const messageId = parseInt(args[0]);
        const channel = args[1];
        if (!messageId || !channel) {
          console.error('Usage: npm run query-loggly -- message <message_id> <channel>');
          process.exit(1);
        }
        const result = await client.searchByMessageId(messageId, channel);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'errors': {
        const timestamp = args[0];
        const windowMinutes = args[1] ? parseInt(args[1]) : 5;
        if (!timestamp) {
          console.error('Usage: npm run query-loggly -- errors <timestamp> [window_minutes]');
          process.exit(1);
        }
        const result = await client.searchErrorsAroundTime(timestamp, windowMinutes);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'bybit': {
        const result = await client.searchBybitErrors();
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'orders': {
        const accountName = args[0];
        const result = await client.searchOrderFailures(undefined, accountName);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        console.log('Usage:');
        console.log('  npm run query-loggly -- search "<query>"');
        console.log('  npm run query-loggly -- message <message_id> <channel>');
        console.log('  npm run query-loggly -- errors <timestamp> [window_minutes]');
        console.log('  npm run query-loggly -- bybit');
        console.log('  npm run query-loggly -- orders [account_name]');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();

