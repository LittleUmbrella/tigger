#!/usr/bin/env tsx
/**
 * Query message by message_id and channel - prints full content
 */

import { DatabaseManager } from '../db/schema.js';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

async function main() {
  const messageId = process.argv[2] || '242';
  const channel = process.argv[3] || '3272135406';

  const db = new DatabaseManager();
  await db.initialize();

  const msg = await db.getMessageByMessageId(messageId, channel);
  if (msg) {
    console.log('=== Full message content ===');
    console.log(msg.content);
    console.log('=== End ===');
    console.log('Length:', msg.content.length);
  } else {
    console.log('Message not found');
  }

  await db.close();
}

main().catch(console.error);
