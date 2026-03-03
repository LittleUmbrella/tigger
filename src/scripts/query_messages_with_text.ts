#!/usr/bin/env node
/**
 * Query messages containing a specific text string from the database.
 * 
 * Usage:
 *   DATABASE_URL=... npx tsx src/scripts/query_messages_with_text.ts half
 *   DATABASE_URL=... npx tsx src/scripts/query_messages_with_text.ts half --channel 3077664317
 */

import 'dotenv/config';
import { DatabaseManager } from '../db/schema.js';

async function main() {
  const searchText = process.argv[2] || 'half';
  const channelArg = process.argv.find(a => a.startsWith('--channel='));
  const channel = channelArg?.split('=')[1];

  const db = new DatabaseManager();
  await db.initialize();

  try {
    // Use raw pool for custom query - DatabaseManager doesn't expose content search
    // Access adapter.pool (postgres only) via type assertion
    const pool = (db as unknown as { adapter?: { pool?: import('pg').Pool } }).adapter?.pool;
    if (!pool) {
      console.error('PostgreSQL adapter required for this script. Set DATABASE_URL.');
      process.exit(1);
    }

    const query = channel
      ? `SELECT id, message_id, channel, content, date, parsed 
         FROM messages 
         WHERE channel = $1 AND content ILIKE $2 
         ORDER BY date DESC 
         LIMIT 100`
      : `SELECT id, message_id, channel, content, date, parsed 
         FROM messages 
         WHERE content ILIKE $1 
         ORDER BY date DESC 
         LIMIT 100`;
    
    const params = channel ? [channel, `%${searchText}%`] : [`%${searchText}%`];
    const result = await pool.query(query, params);
    
    console.log(`\nFound ${result.rows.length} messages containing "${searchText}"${channel ? ` in channel ${channel}` : ''}:\n`);
    
    for (const row of result.rows) {
      console.log('─'.repeat(80));
      console.log(`ID: ${row.id} | msg: ${row.message_id} | channel: ${row.channel} | date: ${row.date}`);
      console.log(`Content: ${row.content}`);
      console.log('');
    }
  } finally {
    await db.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
