#!/usr/bin/env node
/**
 * Replay a message as if it was just harvested
 * This is useful for testing that a message creates a trade with orders on the actual exchange
 * 
 * Usage:
 *   tsx src/scripts/replay_message.ts --message-id <id> --channel <channel>
 *   tsx src/scripts/replay_message.ts --db-id <id>
 *   tsx src/scripts/replay_message.ts --content <content> --channel <channel> --date <date>
 */

import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs-extra';
import { DatabaseManager, Message } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { BotConfig } from '../types/config.js';
import { parseMessage } from '../parsers/signalParser.js';
import { processUnparsedMessages } from '../initiators/signalInitiator.js';
import { registerParser } from '../parsers/parserRegistry.js';
import { getInitiator, InitiatorContext, getRegisteredInitiators } from '../initiators/initiatorRegistry.js';
import { InitiatorConfig } from '../types/config.js';
import { emojiHeavyParser } from '../parsers/emojiHeavyParser.js';
import { vipCryptoSignals } from '../parsers/channels/2427485240/vip-future.js';
import { ronnieCryptoSignals } from '../parsers/channels/3241720654/ronnie-crypto-signals.js';
import '../initiators/index.js'; // Register built-in initiators
import '../managers/index.js'; // Register built-in managers

// Register built-in parsers
registerParser('emoji_heavy', emojiHeavyParser);
registerParser('vip_crypto_signals', vipCryptoSignals);
registerParser('ronnie_crypto_signals', ronnieCryptoSignals);

const program = new Command();

program
  .name('replay-message')
  .description('Replay a message as if it was just harvested')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)')
  .option('--db-type <type>', 'Database type: sqlite or postgresql')
  // Options for getting message
  .option('--message-id <id>', 'Telegram message_id (requires --channel)')
  .option('--channel <channel>', 'Channel name/ID (required with --message-id, --db-id, or --content)')
  .option('--db-id <id>', 'Database internal ID (id field, requires --channel)')
  .option('--content <content>', 'Message content (creates new message, requires --channel and --date)')
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

      let message: Message | null = null;
      let channel: string;

      // Get or create message
      if (options.dbId) {
        // Get by database ID (requires channel for efficiency)
        if (!options.channel) {
          console.error('❌ --channel is required when using --db-id');
          await db.close();
          process.exit(1);
        }
        channel = options.channel;
        // Get all messages from channel and find by ID
        const messages = await db.getMessagesByChannel(channel);
        message = messages.find(m => m.id === Number(options.dbId)) || null;
        if (!message) {
          console.error(`❌ Message with database ID ${options.dbId} not found in channel ${channel}`);
          await db.close();
          process.exit(1);
        }
      } else if (options.messageId && options.channel) {
        // Get by message_id and channel
        message = await db.getMessageByMessageId(Number(options.messageId), options.channel);
        if (!message) {
          console.error(`❌ Message with message_id ${options.messageId} in channel ${options.channel} not found`);
          await db.close();
          process.exit(1);
        }
        channel = options.channel;
      } else if (options.content && options.channel && options.date) {
        // Create new message
        const messageId = Date.now(); // Use timestamp as message_id for new messages
        const date = new Date(options.date).toISOString();
        
        try {
          await db.insertMessage({
            message_id: messageId,
            channel: options.channel,
            content: options.content,
            sender: options.sender || '',
            date: date,
            reply_to_message_id: undefined,
            image_paths: undefined
          });
          
          message = await db.getMessageByMessageId(messageId, options.channel);
          if (!message) {
            console.error(`❌ Failed to retrieve created message`);
            await db.close();
            process.exit(1);
          }
          channel = options.channel;
          logger.info('Created new message for replay', {
            messageId,
            channel,
            contentPreview: options.content.substring(0, 100)
          });
        } catch (error) {
          console.error(`❌ Failed to create message:`, error instanceof Error ? error.message : String(error));
          await db.close();
          process.exit(1);
        }
      } else {
        console.error('❌ Must provide one of: --db-id, (--message-id + --channel), or (--content + --channel + --date)');
        program.help();
        await db.close();
        process.exit(1);
      }

      if (!message) {
        console.error('❌ Message not found');
        await db.close();
        process.exit(1);
      }

      // Find channel config
      const channelConfig = config.channels.find(c => c.channel === channel);
      if (!channelConfig) {
        console.error(`❌ Channel ${channel} not found in config`);
        await db.close();
        process.exit(1);
      }

      // Find parser config
      const parserConfig = config.parsers.find(p => p.name === channelConfig.parser);
      if (!parserConfig) {
        console.error(`❌ Parser ${channelConfig.parser} not found in config`);
        await db.close();
        process.exit(1);
      }

      // Find initiator config
      const initiatorConfig = config.initiators.find(i => 
        (i.name || i.type) === channelConfig.initiator
      );
      if (!initiatorConfig) {
        console.error(`❌ Initiator ${channelConfig.initiator} not found in config`);
        await db.close();
        process.exit(1);
      }

      // Find monitor config
      const monitorConfig = config.monitors.find(m => m.type === channelConfig.monitor);
      if (!monitorConfig) {
        console.error(`❌ Monitor ${channelConfig.monitor} not found in config`);
        await db.close();
        process.exit(1);
      }

      logger.info('Replaying message', {
        messageId: message.message_id,
        channel,
        contentPreview: message.content.substring(0, 100),
        parser: parserConfig.name,
        initiator: initiatorConfig.name || initiatorConfig.type
      });

      // Mark message as unparsed
      logger.debug('Marking message as unparsed', {
        messageId: message.message_id,
        channel,
        currentParsed: message.parsed,
        messageDbId: message.id
      });
      await db.updateMessage(message.message_id, channel, { parsed: false });
      
      // Verify the update worked by re-fetching the message
      const updatedMessage = await db.getMessageByMessageId(message.message_id, channel);
      logger.info('Marked message as unparsed', {
        messageId: message.message_id,
        channel,
        wasParsed: message.parsed,
        nowParsed: updatedMessage?.parsed,
        messageDbId: message.id
      });

      // Parse the message
      const parsed = parseMessage(message.content, parserConfig.name);
      if (!parsed) {
        console.error('❌ Message could not be parsed');
        logger.error('Parser returned null', {
          messageId: message.message_id,
          channel,
          parser: parserConfig.name,
          content: message.content
        });
        await db.close();
        process.exit(1);
      }

      logger.info('Message parsed successfully', {
        messageId: message.message_id,
        channel,
        tradingPair: parsed.tradingPair,
        signalType: parsed.signalType,
        leverage: parsed.leverage,
        entryPrice: parsed.entryPrice,
        stopLoss: parsed.stopLoss,
        takeProfits: parsed.takeProfits
      });

      // Process the message through the initiator
      const entryTimeoutDays = monitorConfig.entryTimeoutDays || 2;
      const isSimulation = config.simulation?.enabled || false;
      
      logger.info('Initiating trade', {
        messageId: message.message_id,
        channel,
        initiator: initiatorConfig.name || initiatorConfig.type,
        entryTimeoutDays,
        isSimulation
      });

      // For replay, process the specific message directly instead of querying
      // This avoids timing issues with the database update
      const initiatorName = initiatorConfig.name || initiatorConfig.type;
      if (!initiatorName) {
        logger.error('Initiator name not specified in config', { channel });
        await db.close();
        process.exit(1);
      }

      const initiatorFunction = getInitiator(initiatorName);
      if (!initiatorFunction) {
        const availableInitiators = getRegisteredInitiators();
        logger.error('Initiator not found in registry', {
          channel,
          initiatorName,
          availableInitiators
        });
        await db.close();
        process.exit(1);
      }

      // Create context for the initiator
      const mergedInitiatorConfig: InitiatorConfig = {
        ...initiatorConfig,
        baseLeverage: channelConfig.baseLeverage !== undefined ? channelConfig.baseLeverage : initiatorConfig.baseLeverage
      };

      const context: InitiatorContext = {
        channel,
        riskPercentage: initiatorConfig.riskPercentage,
        entryTimeoutDays,
        message: updatedMessage || message, // Use updated message if available
        order: parsed,
        db,
        isSimulation,
        priceProvider: undefined,
        config: mergedInitiatorConfig,
        accounts: config.accounts
      };

      // Call the initiator directly
      await initiatorFunction(context);
      
      // Mark message as parsed after successful initiation
      await db.markMessageParsed(message.id);

      // Check if trade was created
      const trades = await db.getTradesByMessageId(message.message_id, channel);
      if (trades.length > 0) {
        logger.info('Trade created successfully', {
          messageId: message.message_id,
          channel,
          tradeCount: trades.length,
          trades: trades.map(t => ({
            id: t.id,
            tradingPair: t.trading_pair,
            status: t.status,
            entryPrice: t.entry_price,
            stopLoss: t.stop_loss,
            takeProfits: JSON.parse(t.take_profits)
          }))
        });
        console.log('\n✅ Trade created successfully!');
        console.log(`   Trade ID(s): ${trades.map(t => t.id).join(', ')}`);
        console.log(`   Trading Pair: ${trades[0].trading_pair}`);
        console.log(`   Status: ${trades[0].status}`);
        console.log(`   Entry Price: ${trades[0].entry_price}`);
        console.log(`   Stop Loss: ${trades[0].stop_loss}`);
        console.log(`   Take Profits: ${JSON.parse(trades[0].take_profits).join(', ')}`);
      } else {
        logger.warn('No trade was created', {
          messageId: message.message_id,
          channel
        });
        console.log('\n⚠️  Message was parsed but no trade was created');
        console.log('   This might be expected if:');
        console.log('   - Entry price conditions are not met');
        console.log('   - Account balance is insufficient');
        console.log('   - Trade already exists for this message');
      }

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Replay failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      logger.error('Replay failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      process.exit(1);
    }
  });

program.parse(process.argv);

