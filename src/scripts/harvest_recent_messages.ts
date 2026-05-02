#!/usr/bin/env node
/**
 * Pull the newest N Discord messages for a channel into the **trading bot** database (config.json /
 * DATABASE_URL), so the running bot can parse them via replay/unparsed polling.
 *
 * Uses `limitFetchedTotal`: the limit counts Discord API messages returned per run (including duplicates).
 * Omit `--limit-new-inserts-only` to get that behavior; with that flag, the limit counts new DB rows only.
 *
 * Usage:
 *   npm run harvest-recent -- --channel 1486846570531000412 --limit 40
 *   npm run harvest-recent -- -c 1486846570531000412 --platform discord-selfbot
 *   npm run harvest-recent -- -c CHANNEL --limit-new-inserts-only -n 100
 */

import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs-extra';
import { DatabaseManager } from '../db/schema.js';
import { BotConfig } from '../types/config.js';
import { harvestMessages } from '../evaluation/messageHarvester.js';

const program = new Command();

program
  .name('harvest-recent-messages')
  .description(
    'Harvest the latest N Discord messages into the production DB from config.json (fetched-message limit by default)'
  )
  .requiredOption('-c, --channel <id>', 'Discord (or Telegram) channel ID')
  .option('-n, --limit <n>', 'How many Discord messages to walk from newest (default: 40)', '40')
  .option(
    '-p, --platform <platform>',
    'discord-selfbot | discord | telegram',
    'discord-selfbot'
  )
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--db-path <path>', 'Override database path/url (otherwise from config / DATABASE_URL)')
  .option('--db-type <type>', 'Override database type: sqlite | postgresql')
  .option(
    '--limit-new-inserts-only',
    'Use legacy limit semantics: stop after N new rows inserted (duplicates do not advance the counter)'
  )
  .option('--download-images', 'Download image attachments references', false)
  .option('-d, --delay <ms>', 'Delay between batches in ms or "auto"', 'auto')
  .action(async (options) => {
    const configPath = options.config || 'config.json';
    if (!fs.existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }

    const config: BotConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));

    const rawDbType = (options.dbType || config.database?.type || 'sqlite').toLowerCase();
    const dbType =
      rawDbType === 'postgres' || rawDbType === 'postgresql' ? 'postgresql' : 'sqlite';
    const dbPathResolved =
      options.dbPath ||
      (dbType === 'sqlite'
        ? config.database?.path || 'data/trading_bot.db'
        : config.database?.url || process.env.DATABASE_URL || '');

    if (dbType === 'postgresql' && !dbPathResolved) {
      console.error(
        'PostgreSQL selected but no URL. Set config.database.url or DATABASE_URL, or pass --db-path.'
      );
      process.exit(1);
    }

    const limit = Math.max(0, parseInt(String(options.limit), 10) || 0);
    if (limit <= 0) {
      console.error('--limit must be a positive integer');
      process.exit(1);
    }

    const platform =
      options.platform === 'discord'
        ? 'discord'
        : options.platform === 'telegram'
          ? 'telegram'
          : 'discord-selfbot';

    let delayNum: number | 'auto';
    const d = options.delay;
    delayNum = d === 'auto' ? 'auto' : parseInt(String(d), 10) || 0;

    const db = new DatabaseManager({
      type: dbType,
      path: dbType === 'sqlite' ? dbPathResolved : undefined,
      url: dbType === 'postgresql' ? dbPathResolved : undefined,
    });
    await db.initialize();

    try {
      const result = await harvestMessages(db, {
        channel: String(options.channel),
        platform,
        limit,
        limitFetchedTotal: !options.limitNewInsertsOnly,
        delay: delayNum,
        downloadImages: Boolean(options.downloadImages),
      });

      console.log('\nHarvest complete');
      console.log(`   Fetched (API total counted): ${result.totalMessages}`);
      console.log(`   New rows inserted:          ${result.newMessages}`);
      console.log(`   Skipped (filtered/dup/etc): ${result.skippedMessages}`);
      console.log(`   Errors:                     ${result.errors}`);
      console.log(`   Last message id (hint):      ${result.lastMessageId}`);
      console.log(
        `\nTip: run unparsed processing with \`npm run replay-messages -- --channel ${options.channel}\` if needed.\n`
      );
      process.exit(0);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      await db.close().catch(() => undefined);
    }
  });

program.parse();
