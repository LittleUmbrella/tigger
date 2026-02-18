#!/usr/bin/env node
/**
 * Replay unparsed messages in a channel through the orchestrator's processing pipeline
 * This processes all unparsed messages in the specified channel, useful for testing or reprocessing messages
 * 
 * Usage:
 *   tsx src/scripts/replay_message.ts --channel <channel>
 *   tsx src/scripts/replay_message.ts --channel <channel> --content <content> --date <date>
 */

import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs-extra';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { BotConfig } from '../types/config.js';
import { startTradeOrchestrator } from '../orchestrator/tradeOrchestrator.js';

const program = new Command();

program
  .name('replay-messages')
  .description('Process all unparsed messages in a channel through the orchestrator pipeline')
  .requiredOption('--channel <channel>', 'Channel name/ID to process unparsed messages from')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)')
  .option('--db-type <type>', 'Database type: sqlite or postgresql')
  .option('--content <content>', 'Optional: Create a new message with this content before processing')
  .option('--date <date>', 'Message date in ISO format (required with --content)')
  .option('--sender <sender>', 'Message sender (optional, for --content)')
  .action(async (options) => {
    try {
      // Load config
      const configPath = options.config || 'config.json';
      if (!fs.existsSync(configPath)) {
        console.error(`❌ Config file not found: ${configPath}`);
        process.exit(1);
      }

      const configContent = await fs.readFile(configPath, 'utf-8');
      const config: BotConfig = JSON.parse(configContent);

      // Determine database settings
      const dbType = options.dbType || config.database?.type || 'sqlite';
      const dbPath = options.dbPath || config.database?.path || config.database?.url || 'data/trading_bot.db';

      // Initialize database
      const db = new DatabaseManager({
        type: dbType,
        path: dbType === 'sqlite' ? dbPath : undefined,
        url: dbType === 'postgresql' ? dbPath : undefined,
      });
      await db.initialize();

      const channel = options.channel;

      // Optionally create a new message before processing
      if (options.content) {
        if (!options.date) {
          console.error('❌ --date is required when using --content');
          await db.close();
          process.exit(1);
        }
        
        // Create new message
        const messageId = String(Date.now()); // Use timestamp as message_id for new messages
        const date = new Date(options.date).toISOString();
        
        try {
          await db.insertMessage({
            message_id: messageId,
            channel: channel,
            content: options.content,
            sender: options.sender || '',
            date: date,
            reply_to_message_id: undefined,
            image_paths: undefined
          });
          
          logger.info('Created new message for processing', {
            messageId,
            channel,
            contentPreview: options.content.substring(0, 200)
          });
        } catch (error) {
          console.error(`❌ Failed to create message:`, error instanceof Error ? error.message : String(error));
          await db.close();
          process.exit(1);
        }
      }

      // Verify channel exists in config
      const channelConfig = config.channels.find(c => c.channel === channel);
      if (!channelConfig) {
        console.error(`❌ Channel ${channel} not found in config`);
        await db.close();
        process.exit(1);
      }

      // Filter config to only include the specified channel
      // This ensures the orchestrator only processes messages for this channel
      const filteredConfig: BotConfig = {
        ...config,
        channels: [channelConfig],
        harvesters: config.harvesters.filter(h => h.channel === channel),
        parsers: config.parsers.filter(p => p.channel === channel)
      };

      logger.info('Starting orchestrator to process unparsed messages', {
        channel
      });

      // Start the orchestrator - it will process all unparsed messages in the channel
      const stopOrchestrator = await startTradeOrchestrator(filteredConfig);

      // Wait for the orchestrator to process messages
      // Parser interval runs every 5 seconds, initiator every 10 seconds
      // Wait long enough for at least one full processing cycle
      logger.info('Waiting for orchestrator to process messages...');
      await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds

      // Stop the orchestrator
      logger.info('Stopping orchestrator');
      await stopOrchestrator();

      // Get count of remaining unparsed messages
      const unparsedCount = (await db.getUnparsedMessages(channel)).length;

      logger.info('Processing complete', {
        channel,
        remainingUnparsed: unparsedCount
      });

      console.log(`\n✅ Finished processing unparsed messages in channel ${channel}`);
      if (unparsedCount === 0) {
        console.log(`   All messages have been processed`);
      } else {
        console.log(`   ${unparsedCount} message(s) remain unparsed`);
        console.log(`   This might be expected if:`);
        console.log(`   - Messages couldn't be parsed`);
        console.log(`   - Entry price conditions are not met`);
        console.log(`   - Account balance is insufficient`);
        console.log(`   - Trades already exist for these messages`);
        console.log(`   - Errors occurred during processing (check logs)`);
      }

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Processing failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      logger.error('Processing failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      process.exit(1);
    }
  });

program.parse(process.argv);

