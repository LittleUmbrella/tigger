#!/usr/bin/env tsx
/**
 * Query message by internal database ID
 */

import { DatabaseManager } from '../db/schema.js';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const envInvestigationPath = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');

if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('Usage: tsx src/scripts/query_message_by_db_id.ts <db_id>');
    process.exit(1);
  }

  const dbId = parseInt(args[0]);
  const db = new DatabaseManager();
  await db.initialize();
  
  // Query by internal database ID (PostgreSQL)
  const result = await (db as any).adapter.pool.query('SELECT * FROM messages WHERE id = $1', [dbId]);
  
  if (result.rows.length > 0) {
    const message = result.rows[0];
    console.log('Found message:');
    console.log(`  ID: ${message.id}`);
    console.log(`  message_id: ${message.message_id}`);
    console.log(`  channel: ${message.channel}`);
    console.log(`  date: ${message.date}`);
    console.log(`  content: ${message.content.substring(0, 300)}...`);
    console.log(`\nTo investigate this message, use:`);
    console.log(`  npm run investigate -- "/investigate message:${message.message_id} channel:${message.channel}"`);
  } else {
    console.log(`Message with ID ${dbId} not found`);
  }
  
  await db.close();
}

main().catch(console.error);

