#!/usr/bin/env tsx
/**
 * Close all open exchange positions for trades linked to a specific message and channel.
 *
 * Mirrors closeAllTradesManager filtering (status=active, position_id set) but scoped to one message.
 *
 * Usage:
 *   tsx src/scripts/close_message_positions.ts --message-id <id> --channel <channel>
 *   tsx src/scripts/close_message_positions.ts --message-id <id> --channel <channel> --dry-run
 *   tsx src/scripts/close_message_positions.ts --message-id <id> --channel <channel> --accounts demo,main
 *   npm run close-message-positions -- --message-id 15145 --channel 2845421508
 */

import dotenv from 'dotenv';
import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { RestClientV5 } from 'bybit-api';
import { DatabaseManager, Trade } from '../db/schema.js';
import { BotConfig, AccountConfig } from '../types/config.js';
import { closePosition } from '../managers/positionUtils.js';
import { resolveBybitRestClient } from '../utils/resolveBybitRestClient.js';
import { resolveCtraderAccountCredentials } from '../utils/ctraderAccountCredentials.js';
import { CTraderClient } from '../clients/ctraderClient.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const envInvestigation = path.join(projectRoot, '.env-investigation');
if (fs.existsSync(envInvestigation)) {
  dotenv.config({ path: envInvestigation });
} else {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

const bybitClientCache = new Map<string, RestClientV5>();
const ctraderClientCache = new Map<string, CTraderClient>();

const normalizeTradeAccount = (accountName: string | null | undefined): string =>
  accountName?.trim() || 'default';

const parseAccountFilter = (raw: string | undefined): Set<string> | null => {
  if (!raw) return null;
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
};

const tradeMatchesAccountFilter = (trade: Trade, filter: Set<string> | null): boolean => {
  if (!filter) return true;
  return filter.has(normalizeTradeAccount(trade.account_name));
};

const initDatabase = async (config: BotConfig) => {
  const rawDbType = (config.database?.type || 'sqlite').toLowerCase();
  const dbType =
    rawDbType === 'postgres' || rawDbType === 'postgresql' ? 'postgresql' : 'sqlite';
  const dbPath =
    dbType === 'sqlite'
      ? config.database?.path || 'data/trading_bot.db'
      : config.database?.url || process.env.DATABASE_URL || '';
  if (dbType === 'postgresql' && !dbPath) {
    throw new Error(
      'PostgreSQL database selected but no URL provided. Set config.database.url or DATABASE_URL in .env'
    );
  }
  const db = new DatabaseManager({
    type: dbType,
    path: dbType === 'sqlite' ? dbPath : undefined,
    url: dbType === 'postgresql' ? dbPath : undefined,
  });
  await db.initialize();
  return db;
};

const findAccount = (config: BotConfig, accountName: string | undefined): AccountConfig | null => {
  if (!accountName) return null;
  return config.accounts?.find((a) => a.name === accountName) ?? null;
};

const getBybitClient = async (
  accountName: string | undefined,
  configPath: string
): Promise<RestClientV5 | undefined> => {
  const key = accountName || 'default';
  if (bybitClientCache.has(key)) return bybitClientCache.get(key);

  try {
    const session = await resolveBybitRestClient({
      configPath,
      account: accountName,
    });
    bybitClientCache.set(key, session.client);
    return session.client;
  } catch (error) {
    console.error(`Failed to resolve Bybit client for account "${key}":`, serializeErrorForLog(error));
    return undefined;
  }
};

const getCtraderClient = async (
  accountName: string | undefined,
  config: BotConfig
): Promise<CTraderClient | undefined> => {
  const key = accountName || 'default';
  if (ctraderClientCache.has(key)) return ctraderClientCache.get(key);

  const account = findAccount(config, accountName);
  const creds = resolveCtraderAccountCredentials(account);
  if (!creds.clientId || !creds.accessToken || !creds.accountId) {
    console.error(`Missing cTrader credentials for account "${key}"`);
    return undefined;
  }

  const client = new CTraderClient({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret || '',
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    accountId: creds.accountId,
    environment: creds.environment,
  });

  try {
    await client.connect();
    await client.authenticate();
    ctraderClientCache.set(key, client);
    return client;
  } catch (error) {
    console.error(`Failed to connect cTrader client for account "${key}":`, serializeErrorForLog(error));
    return undefined;
  }
};

const disconnectCtraderClients = async () => {
  for (const client of ctraderClientCache.values()) {
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }
};

const formatTrade = (trade: Trade) =>
  `#${trade.id} ${trade.trading_pair} ${trade.direction || '?'} | exchange=${trade.exchange || 'bybit'} | account=${normalizeTradeAccount(trade.account_name)} | position=${trade.position_id}`;

const program = new Command();

program
  .name('close-message-positions')
  .description('Close all open positions for trades linked to a message and channel')
  .requiredOption('--message-id <id>', 'Source message ID (Telegram/Discord ID)')
  .requiredOption('--channel <channel>', 'Channel the message belongs to')
  .option('--accounts <names>', 'Comma-separated account names to close (default: all)')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--dry-run', 'List positions that would be closed without closing them')
  .option('--simulation', 'Mark trades closed in DB only (no exchange calls)')
  .action(async (options) => {
    const configPath = path.resolve(projectRoot, options.config || 'config.json');
    if (!fs.existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }

    const config: BotConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const db = await initDatabase(config);

    const messageId = String(options.messageId);
    const channel = String(options.channel);
    const dryRun = !!options.dryRun;
    const isSimulation = !!options.simulation;
    const accountFilter = parseAccountFilter(options.accounts);

    try {
      const message = await db.getMessageByMessageId(messageId, channel);
      if (!message) {
        console.error(`Message not found: message_id=${messageId}, channel=${channel}`);
        process.exit(1);
      }

      const allTrades = await db.getTradesByMessageId(messageId, channel);
      const closableTrades = allTrades.filter(
        (trade) => trade.status === 'active' && trade.position_id
      );
      const tradesToClose = accountFilter
        ? closableTrades.filter((trade) => tradeMatchesAccountFilter(trade, accountFilter))
        : closableTrades;

      console.log('\n--- Message ---');
      console.log(`  Message ID: ${message.message_id}`);
      console.log(`  Channel:    ${message.channel}`);
      console.log(`  Date:       ${message.date}`);
      console.log(`  Content:    ${message.content.split('\n')[0].slice(0, 120)}${message.content.length > 120 ? '...' : ''}`);
      console.log(`  Accounts:   ${accountFilter ? [...accountFilter].join(', ') : 'all'}`);

      if (accountFilter && tradesToClose.length === 0) {
        const availableAccounts = [
          ...new Set(closableTrades.map((t) => normalizeTradeAccount(t.account_name))),
        ];
        console.log(
          `\nNo closable trades for account filter [${[...accountFilter].join(', ')}].` +
            (availableAccounts.length > 0
              ? ` Available accounts: ${availableAccounts.join(', ')}`
              : ' No active positions on this message.')
        );
        return;
      }

      console.log(`\n--- Trades (${allTrades.length} total, ${tradesToClose.length} to close) ---`);
      if (allTrades.length === 0) {
        console.log('  No trades for this message.');
        return;
      }

      if (accountFilter && closableTrades.length > tradesToClose.length) {
        console.log(
          `  (${closableTrades.length - tradesToClose.length} position(s) on other accounts skipped)`
        );
      }

      for (const trade of allTrades) {
        const willClose = tradesToClose.some((t) => t.id === trade.id);
        const marker = willClose
          ? '→ close'
          : closableTrades.some((t) => t.id === trade.id)
            ? '  skip (account)'
            : '  skip';
        console.log(`  ${marker}  ${formatTrade(trade)} | status=${trade.status}`);
      }

      if (tradesToClose.length === 0) {
        console.log('\nNo active positions with position_id to close.');
        return;
      }

      if (dryRun) {
        console.log(`\n[dry-run] Would close ${tradesToClose.length} position(s). Exiting.`);
        return;
      }

      console.log(`\nClosing ${tradesToClose.length} position(s)...\n`);

      let closed = 0;
      let failed = 0;

      for (const trade of tradesToClose) {
        try {
          const bybitClient =
            trade.exchange !== 'ctrader'
              ? await getBybitClient(trade.account_name, configPath)
              : undefined;
          const ctraderClient =
            trade.exchange === 'ctrader'
              ? await getCtraderClient(trade.account_name, config)
              : undefined;

          if (!isSimulation) {
            if (trade.exchange === 'ctrader' && !ctraderClient) {
              throw new Error(`No cTrader client for account ${trade.account_name || 'default'}`);
            }
            if (trade.exchange !== 'ctrader' && !bybitClient) {
              throw new Error(`No Bybit client for account ${trade.account_name || 'default'}`);
            }
          }

          await closePosition(trade, db, isSimulation, bybitClient, ctraderClient);
          closed++;
          console.log(`  ✓ Closed ${formatTrade(trade)}`);
        } catch (error) {
          failed++;
          console.error(`  ✗ Failed ${formatTrade(trade)}:`, serializeErrorForLog(error));
        }
      }

      console.log(`\nDone: ${closed} closed, ${failed} failed.`);
      if (failed > 0) process.exit(1);
    } finally {
      await disconnectCtraderClients();
      await db.close();
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error('Error:', serializeErrorForLog(error));
  process.exit(1);
});
