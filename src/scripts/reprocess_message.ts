#!/usr/bin/env tsx
/**
 * Reprocess a specific message through the trading pipeline.
 *
 * Unlike replay_messages (which starts the full orchestrator for all unparsed messages),
 * this script targets a single message by ID, resets its parsed flag, optionally cleans
 * up stale trades, and runs it through processMessages directly — no harvester or monitor
 * side-effects.
 *
 * Usage:
 *   tsx src/scripts/reprocess_message.ts --message-id <id> --channel <channel>
 *   tsx src/scripts/reprocess_message.ts --message-id <id> --channel <channel> --cleanup-trades
 *   tsx src/scripts/reprocess_message.ts --message-id <id> --channel <channel> --force --cleanup-trades
 *   tsx src/scripts/reprocess_message.ts --message-id <id> --channel <channel> --dry-run
 */

import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs-extra';
import { DatabaseManager, Trade } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { BotConfig, ChannelSetConfig, InitiatorConfig } from '../types/config.js';
import { processMessages } from '../initiators/signalInitiator.js';
import { getInitiator } from '../initiators/initiatorRegistry.js';

const program = new Command();

const resolveChannelConfig = (config: BotConfig, channel: string) => {
  const channelConfig = config.channels.find(c => c.channel === channel);
  if (!channelConfig) return null;

  const initiatorConfig = config.initiators.find(
    i => i.name === channelConfig.initiator || i.type === channelConfig.initiator
  );

  const monitorConfig = config.monitors.find(m => m.type === channelConfig.monitor);

  return { channelConfig, initiatorConfig, monitorConfig };
};

program
  .name('reprocess-message')
  .description('Reprocess a single message through the trading pipeline by message ID')
  .requiredOption('--message-id <id>', 'Source message ID (Telegram/Discord ID)')
  .requiredOption('--channel <channel>', 'Channel the message belongs to')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--cleanup-trades', 'Cancel existing trades for this message before reprocessing')
  .option('--force', 'Bypass duplicate-trade check (sets forcePlaceTrade on initiator context)')
  .option('--dry-run', 'Show message details and what would happen, but do not reprocess')
  .action(async (options) => {
    try {
      const configPath = options.config || 'config.json';
      if (!fs.existsSync(configPath)) {
        console.error(`Config file not found: ${configPath}`);
        process.exit(1);
      }

      const config: BotConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));

      const dbType = config.database?.type || 'sqlite';
      const dbPath = config.database?.path || config.database?.url || 'data/trading_bot.db';
      const db = new DatabaseManager({
        type: dbType,
        path: dbType === 'sqlite' ? dbPath : undefined,
        url: dbType === 'postgresql' ? dbPath : undefined,
      });
      await db.initialize();

      const { messageId, channel, force, dryRun, cleanupTrades } = options;

      // --- Look up the message ---
      const message = await db.getMessageByMessageId(messageId, channel);
      if (!message) {
        console.error(`Message not found: message_id=${messageId}, channel=${channel}`);
        await db.close();
        process.exit(1);
      }

      console.log('\n--- Message ---');
      console.log(`  ID (internal): ${message.id}`);
      console.log(`  Message ID:    ${message.message_id}`);
      console.log(`  Channel:       ${message.channel}`);
      console.log(`  Date:          ${message.date}`);
      console.log(`  Parsed:        ${message.parsed}`);
      console.log(`  Sender:        ${message.sender || '(none)'}`);
      console.log(`  Content:\n${message.content.split('\n').map(l => `    ${l}`).join('\n')}`);

      // --- Show existing trades ---
      const existingTrades = await db.getTradesByMessageId(messageId, channel);
      if (existingTrades.length > 0) {
        console.log(`\n--- Existing Trades (${existingTrades.length}) ---`);
        for (const t of existingTrades) {
          console.log(`  Trade #${t.id}: ${t.trading_pair} ${t.direction || '?'} | status=${t.status} | account=${t.account_name || 'default'} | pnl=${t.pnl ?? 'n/a'}`);
        }
      } else {
        console.log('\n  No existing trades for this message.');
      }

      // --- Resolve channel config ---
      const resolved = resolveChannelConfig(config, channel);
      if (!resolved) {
        console.error(`Channel ${channel} not found in config`);
        await db.close();
        process.exit(1);
      }

      const { channelConfig, initiatorConfig, monitorConfig } = resolved;

      if (!initiatorConfig) {
        console.error(`Initiator '${channelConfig.initiator}' not found in config`);
        await db.close();
        process.exit(1);
      }

      const initiatorName = initiatorConfig.name || initiatorConfig.type;
      if (!initiatorName) {
        console.error('Initiator name not specified in config');
        await db.close();
        process.exit(1);
      }

      const initiatorFunction = getInitiator(initiatorName);
      if (!initiatorFunction) {
        console.error(`Initiator '${initiatorName}' not registered`);
        await db.close();
        process.exit(1);
      }

      const entryTimeoutMinutes =
        channelConfig.entryTimeoutMinutes ?? monitorConfig?.entryTimeoutMinutes ?? 2880;

      console.log(`\n--- Config ---`);
      console.log(`  Parser:       ${channelConfig.parser}`);
      console.log(`  Initiator:    ${initiatorName}`);
      console.log(`  Monitor:      ${channelConfig.monitor}`);
      console.log(`  Timeout:      ${entryTimeoutMinutes} min`);
      console.log(`  Force:        ${!!force}`);
      console.log(`  Cleanup:      ${!!cleanupTrades}`);

      if (dryRun) {
        console.log('\n[dry-run] Would reset parsed=false and reprocess. Exiting.');
        await db.close();
        process.exit(0);
      }

      // --- Cleanup existing trades ---
      if (cleanupTrades && existingTrades.length > 0) {
        const activeTrades = existingTrades.filter(
          t => t.status === 'pending' || t.status === 'active' || t.status === 'filled'
        );
        for (const trade of activeTrades) {
          await db.updateTrade(trade.id, { status: 'cancelled' });
          const orders = await db.getOrdersByTradeId(trade.id);
          for (const order of orders) {
            if (order.status === 'pending') {
              await db.updateOrder(order.id, { status: 'cancelled' });
            }
          }
          console.log(`  Cancelled trade #${trade.id} (${trade.trading_pair}) and its pending orders`);
        }
        if (activeTrades.length === 0) {
          console.log('  No active trades to clean up.');
        }
      }

      // --- Reset parsed flag ---
      if (message.parsed) {
        await db.updateMessage(messageId, channel, { parsed: false } as any);
        console.log('\n  Reset parsed → false');
      } else {
        console.log('\n  Message already unparsed, no reset needed.');
      }

      // Refetch the message so the processMessages function sees parsed=false
      const freshMessage = await db.getMessageByMessageId(messageId, channel);
      if (!freshMessage) {
        console.error('Failed to refetch message after reset');
        await db.close();
        process.exit(1);
      }

      // --- Reprocess ---
      console.log('\n  Processing message...\n');

      // Wrap the initiator to inject forcePlaceTrade when --force is used
      const wrappedInitiator = force
        ? async (ctx: Parameters<typeof initiatorFunction>[0]) => {
            ctx.forcePlaceTrade = true;
            return initiatorFunction(ctx);
          }
        : initiatorFunction;

      await processMessages(
        [freshMessage],
        initiatorConfig,
        channel,
        entryTimeoutMinutes,
        db,
        false,           // isSimulation
        undefined,       // priceProvider
        channelConfig.parser,
        config.accounts,
        channelConfig.baseLeverage,
        channelConfig.riskPercentage,
        wrappedInitiator,
        initiatorName,
        channelConfig.accountFilters,
        channelConfig.propFirms,
        channelConfig.tradeObfuscation,
        channelConfig.slAdjustmentTolerancePercent,
        channelConfig.useLimitOrderForEntry,
        channelConfig.maxSkippablePastTPs,
        channelConfig.useMarketRangeForEntry,
        channelConfig.maxRisk
      );

      // --- Show result ---
      const updatedMessage = await db.getMessageByMessageId(messageId, channel);
      const newTrades = await db.getTradesByMessageId(messageId, channel);
      const addedTrades = newTrades.filter(
        t => !existingTrades.some(et => et.id === t.id)
      );

      console.log('--- Result ---');
      console.log(`  Parsed: ${updatedMessage?.parsed}`);
      if (addedTrades.length > 0) {
        console.log(`  New trades created: ${addedTrades.length}`);
        for (const t of addedTrades) {
          console.log(`    Trade #${t.id}: ${t.trading_pair} ${t.direction || '?'} | status=${t.status} | account=${t.account_name || 'default'}`);
        }
      } else {
        console.log('  No new trades created.');
        if (updatedMessage?.parsed) {
          console.log('  Message was marked parsed — likely a parse failure, duplicate, or non-retryable error (check logs).');
        } else {
          console.log('  Message still unparsed — may have hit a retryable error (check logs).');
        }
      }

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('Reprocess failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      logger.error('Reprocess failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      process.exit(1);
    }
  });

program.parse(process.argv);
