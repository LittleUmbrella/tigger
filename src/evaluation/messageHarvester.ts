/**
 * Message Harvester for Evaluation
 * 
 * Pulls historical messages from Telegram or Discord channels and stores them in the database.
 * This is a re-implementation of the script utility that uses the database instead of flat files.
 */

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import { Client as SelfBotClient, TextChannel as SelfBotTextChannel } from 'discord.js-selfbot-v13';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { downloadMessageImages } from '../utils/imageDownloader.js';
import dayjs from 'dayjs';

export interface HarvestOptions {
  channel: string;
  platform?: 'telegram' | 'discord' | 'discord-selfbot'; // Platform type (default: 'telegram' for backward compatibility)
  // Telegram-specific fields
  accessHash?: string;
  // Discord-specific fields
  botToken?: string; // Discord bot token (can also use DISCORD_BOT_TOKEN env var)
  userToken?: string; // Discord user token for self-bot (can also use DISCORD_USER_TOKEN env var)
  // Common fields
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  keywords?: string[]; // Optional keywords to filter messages
  limit?: number; // Maximum messages to harvest (0 = unlimited)
  delay?: number | 'auto'; // Delay between batches in ms, or 'auto' for random delays
  downloadImages?: boolean; // Whether to download and store images from messages (default: false)
}

export interface HarvestResult {
  totalMessages: number;
  newMessages: number;
  skippedMessages: number;
  errors: number;
  lastMessageId: number;
}

/**
 * Harvest historical messages from a Telegram or Discord channel
 */
export async function harvestMessages(
  db: DatabaseManager,
  options: HarvestOptions
): Promise<HarvestResult> {
  const platform = options.platform || 'telegram'; // Default to telegram for backward compatibility

  if (platform === 'discord') {
    return harvestDiscordMessages(db, options);
  } else if (platform === 'discord-selfbot') {
    return harvestDiscordSelfBotMessages(db, options);
  } else {
    return harvestTelegramMessages(db, options);
  }
}

/**
 * Harvest historical messages from a Telegram channel
 */
async function harvestTelegramMessages(
  db: DatabaseManager,
  options: HarvestOptions
): Promise<HarvestResult> {
  const apiId = parseInt(process.env.TG_API_ID || '', 10);
  const apiHash = process.env.TG_API_HASH;
  const sessionString = process.env.TG_SESSION || '';

  if (!apiId || !apiHash) {
    throw new Error('TG_API_ID and TG_API_HASH environment variables are required');
  }
  if (!sessionString) {
    throw new Error('TG_SESSION environment variable is required');
  }

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  try {
    await client.connect();
    const me = await client.getMe();
    logger.info('Connected to Telegram for message harvesting', {
      channel: options.channel,
      username: me.username || me.firstName
    });

    // Resolve channel entity
    const entity = await resolveTelegramEntity(client, options.channel, options.accessHash);
    logger.info('Resolved channel entity', {
      channel: options.channel,
      title: (entity as any).title || (entity as any).username || options.channel
    });

    // Parse date filters
    const startDate = options.startDate ? dayjs(options.startDate) : null;
    const endDate = options.endDate ? dayjs(options.endDate) : null;

    // Get last message ID from database for this channel
    // Use getMessagesByChannel to get ALL messages (not just unparsed) to find the true max message_id
    const existingMessages = await db.getMessagesByChannel(options.channel);
    let lastMessageId = 0;
    if (existingMessages.length > 0) {
      // Get the highest message_id from existing messages
      const maxMessageId = Math.max(...existingMessages.map(m => m.message_id));
      lastMessageId = maxMessageId;
      logger.info('Resuming from last message ID', {
        channel: options.channel,
        lastMessageId
      });
    }

    const result: HarvestResult = {
      totalMessages: 0,
      newMessages: 0,
      skippedMessages: 0,
      errors: 0,
      lastMessageId: 0,
    };

    // Determine harvest direction:
    // - If lastMessageId > 0 and no startDate, fetch newer messages (forward)
    // - Otherwise, fetch historical messages going backward
    const harvestNewerMessages = lastMessageId > 0 && !startDate;

    // Log harvest mode (store startDate string before narrowing)
    const startDateStr = startDate ? startDate.format() : null;
    if (harvestNewerMessages) {
      logger.info('Harvesting newer messages mode', {
        channel: options.channel,
        lastMessageId,
        startDate: startDateStr
      });
    } else {
      logger.info('Harvesting historical messages mode', {
        channel: options.channel,
        lastMessageId,
        startDate: startDateStr
      });
    }

    // offsetId is used for API pagination (messages older than this ID)
    // For newer messages, we start from 0 (newest) and process forward
    // For historical messages, we start from lastMessageId and go backward
    let offsetId = harvestNewerMessages ? 0 : lastMessageId;
    let lastProcessedId = lastMessageId;
    let batchCount = 0;
    let consecutiveDuplicateBatches = 0;
    const MAX_CONSECUTIVE_DUPLICATE_BATCHES = 3;
    let shouldStop = false; // Flag to stop harvesting when we hit duplicates

    while (true) {
      if (shouldStop) {
        logger.info('Stopping harvest: reached already-processed messages', {
          channel: options.channel
        });
        break;
      }
      batchCount++;
      
      // Calculate delay
      const delayMs = options.delay === 'auto'
        ? Math.floor(Math.random() * (700 - 300 + 1)) + 300
        : (options.delay || 0);

      try {
        // Pass offsetId directly - the Telegram library handles conversion
        // offsetId means "get messages older than this ID"
        // 0 means start from most recent messages
        const history = await client.invoke(new Api.messages.GetHistory({
          peer: entity,
          offsetId: offsetId || 0,
          limit: 20,
          addOffset: 0,
          maxId: 0,
          minId: 0,
          hash: BigInt(0) as any,
        }));

        const messages = ('messages' in history && history.messages) ? history.messages : [];
        if (messages.length === 0) {
          logger.info('No more messages to harvest', { channel: options.channel });
          break;
        }

        // For newer messages, process newest-first; for historical, process oldest-first
        // Telegram API returns messages newest-first
        const ordered = harvestNewerMessages ? messages : [...messages].reverse();
        let batchNewMessages = 0;
        let batchSkipped = 0;
        let alreadyProcessedCount = 0; // Track messages skipped because already processed (for newer messages mode)

        for (const msg of ordered) {
          if (!msg || !('message' in msg) || !msg.message) {
            batchSkipped++;
            logger.debug('Skipping message: no message content', {
              channel: options.channel,
              messageId: msg?.id
            });
            continue;
          }

          // Handle BigInt message IDs properly
          const msgIdBigInt = typeof msg.id === 'bigint' ? msg.id : BigInt(msg.id);
          const msgId = Number(msgIdBigInt);
          if (Number.isNaN(msgId)) {
            batchSkipped++;
            logger.debug('Skipping message: invalid ID', {
              channel: options.channel,
              messageId: msgId
            });
            continue;
          }

          // When harvesting newer messages, skip messages we've already processed
          if (harvestNewerMessages && msgId <= lastMessageId) {
            batchSkipped++;
            alreadyProcessedCount++;
            logger.debug('Skipping message: already processed (newer messages mode)', {
              channel: options.channel,
              messageId: msgId,
              lastMessageId
            });
            continue; // Skip this message but continue processing others
          }

          // Note: For historical harvesting (backward), we don't skip based on lastProcessedId here because:
          // 1. Telegram returns messages newest-first, we reverse to process oldest-first
          // 2. After reversing, we process messages in order: oldest (lowest ID) to newest (highest ID)
          // 3. If we skip based on lastProcessedId, we'd incorrectly skip older messages that come after newer ones
          // 4. The database UNIQUE constraint on (message_id, channel) will handle duplicates
          // 5. We track lastProcessedId to know the highest ID we've processed in this batch

          // Parse date
          let msgDate: Date;
          if ('date' in msg && msg.date) {
            const dateValue = msg.date as any;
            if (dateValue instanceof Date) {
              msgDate = dateValue;
            } else {
              const numValue = typeof dateValue === 'number' ? dateValue : Number(dateValue);
              msgDate = new Date(numValue < 1e12 ? numValue * 1000 : numValue);
            }
          } else {
            msgDate = new Date();
          }

          // Apply date filters
          if (startDate && dayjs(msgDate).isBefore(startDate)) {
            batchSkipped++;
            logger.debug('Skipping message: before start date', {
              channel: options.channel,
              messageId: msgId,
              messageDate: msgDate.toISOString(),
              startDate: startDate.toISOString()
            });
            continue;
          }
          if (endDate && dayjs(msgDate).isAfter(endDate)) {
            batchSkipped++;
            logger.debug('Skipping message: after end date', {
              channel: options.channel,
              messageId: msgId,
              messageDate: msgDate.toISOString(),
              endDate: endDate.toISOString()
            });
            continue;
          }

          // Apply keyword filters
          if (options.keywords && options.keywords.length > 0) {
            const messageText = String(msg.message).toLowerCase();
            const hasKeyword = options.keywords.some(k => messageText.includes(k.toLowerCase()));
            if (!hasKeyword) {
              batchSkipped++;
              logger.debug('Skipping message: no keyword match', {
                channel: options.channel,
                messageId: msgId,
                keywords: options.keywords
              });
              continue;
            }
          }

          // Extract reply_to information
          let replyToMessageId: number | undefined;
          if ('replyTo' in msg && msg.replyTo) {
            const replyTo = msg.replyTo as any;
            if ('replyToMsgId' in replyTo && replyTo.replyToMsgId) {
              replyToMessageId = Number(replyTo.replyToMsgId);
            } else if ('replyToMsgId' in replyTo && typeof replyTo.replyToMsgId === 'bigint') {
              replyToMessageId = Number(replyTo.replyToMsgId);
            }
          }

          // Download images if enabled
          let imagePaths: string[] = [];
          if (options.downloadImages && msg instanceof Api.Message) {
            try {
              imagePaths = await downloadMessageImages(
                { channel: options.channel, downloadImages: options.downloadImages },
                client,
                msg
              );
            } catch (error) {
              logger.warn('Failed to download images for message', {
                channel: options.channel,
                messageId: msgId,
                error: error instanceof Error ? error.message : String(error)
              });
              // Continue with message insertion even if image download fails
            }
          }

          // Insert message into database
          try {
            await db.insertMessage({
              message_id: msgId,
              channel: options.channel,
              content: String(msg.message).replace(/\s+/g, ' ').trim(),
              sender: String((msg as any).fromId?.userId || (msg as any).senderId?.userId || ''),
              date: msgDate.toISOString(),
              reply_to_message_id: replyToMessageId,
              image_paths: imagePaths.length > 0 ? JSON.stringify(imagePaths) : undefined,
            });
            batchNewMessages++;
            result.newMessages++;
            // Update lastProcessedId to track the highest ID we've successfully processed
            lastProcessedId = Math.max(lastProcessedId, msgId);
            result.lastMessageId = Math.max(result.lastMessageId, msgId);
          } catch (error) {
            if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
              // Duplicate message - we've reached messages we've already processed
              // In evaluation mode, this means we can stop harvesting (we've caught up)
              logger.info('Reached already-processed messages, stopping harvest', {
                channel: options.channel,
                messageId: msgId,
                lastProcessedId
              });
              // Set flag to stop harvesting after processing current batch
              shouldStop = true;
              // Break out of the message loop
              break;
            } else {
              logger.warn('Failed to insert message', {
                channel: options.channel,
                messageId: msgId,
                error: error instanceof Error ? error.message : String(error)
              });
              result.errors++;
            }
          }

          // Check limit
          if (options.limit && options.limit > 0 && result.newMessages >= options.limit) {
            logger.info('Reached message limit', {
              channel: options.channel,
              limit: options.limit
            });
            break;
          }
        }

        result.totalMessages += messages.length;
        result.skippedMessages += batchSkipped;

        // For newer messages mode, if all valid messages in batch were already processed, we've caught up
        // Note: We check alreadyProcessedCount against messages.length to account for messages without content/invalid IDs
        if (harvestNewerMessages && alreadyProcessedCount > 0 && alreadyProcessedCount === messages.length) {
          logger.info('Stopping newer messages harvest: all messages in batch already processed', {
            channel: options.channel,
            batch: batchCount,
            alreadyProcessedCount,
            totalMessages: messages.length,
            lastProcessedId
          });
          break;
        }

        if (batchNewMessages > 0) {
          // Reset counter when we find new messages
          consecutiveDuplicateBatches = 0;
          logger.info('Harvested batch', {
            channel: options.channel,
            batch: batchCount,
            newMessages: batchNewMessages,
            skipped: batchSkipped,
            totalNew: result.newMessages
          });
        } else if (batchSkipped > 0) {
          // Log when all messages in a batch were skipped
          consecutiveDuplicateBatches++;
          logger.info('Batch skipped entirely', {
            channel: options.channel,
            batch: batchCount,
            totalMessages: messages.length,
            skipped: batchSkipped,
            consecutiveDuplicateBatches,
            reason: 'all_messages_filtered_or_duplicate'
          });

          // Stop if we've encountered multiple consecutive batches with all duplicates
          // This indicates we've reached the point where everything is already harvested
          if (consecutiveDuplicateBatches >= MAX_CONSECUTIVE_DUPLICATE_BATCHES) {
            logger.info('Stopping harvest: multiple consecutive batches were all duplicates', {
              channel: options.channel,
              consecutiveDuplicateBatches,
              lastProcessedId,
              reason: 'reached_already_harvested_messages'
            });
            break;
          }
        }

        // Check if we should stop
        if (options.limit && options.limit > 0 && result.newMessages >= options.limit) {
          break;
        }

        // For newer messages mode, stop if we've hit already-processed messages
        if (harvestNewerMessages && shouldStop) {
          logger.info('Stopping newer messages harvest: reached already-processed messages', {
            channel: options.channel,
            lastProcessedId
          });
          break;
        }

        // Prepare next offset - handle BigInt message IDs
        const messageIds = messages.map(m => {
          const id = typeof m.id === 'bigint' ? m.id : BigInt(m.id);
          return Number(id);
        }).filter(Number.isFinite);
        
        if (messageIds.length === 0) {
          logger.info('No valid message IDs found', { channel: options.channel });
          break;
        }
        
        const minId = Math.min(...messageIds);
        if (!Number.isFinite(minId) || minId <= 1) {
          logger.info('Reached earliest messages', { channel: options.channel });
          break;
        }
        
        // For newer messages mode, check if we should continue paginating
        if (harvestNewerMessages) {
          // If the minimum ID in this batch is <= lastMessageId, we've caught up
          if (minId <= lastMessageId) {
            logger.info('Stopping newer messages harvest: reached already-processed messages', {
              channel: options.channel,
              minId,
              lastMessageId
            });
            break;
          }
          // Continue paginating backward to get more newer messages
          // Use the minimum ID as the next offset to get older messages (but still newer than lastMessageId)
          const nextOffsetId = Math.max(1, minId - 1);
          // Only check for progress if we're not on the first batch (offsetId > 0)
          // When offsetId is 0, it means "get newest", so we should always continue
          if (offsetId > 0 && nextOffsetId >= offsetId) {
            // We're not making progress, stop
            logger.info('Reached earliest newer messages (no progress)', { 
              channel: options.channel,
              currentOffset: offsetId,
              nextOffset: nextOffsetId
            });
            break;
          }
          logger.debug('Continuing pagination for newer messages', {
            channel: options.channel,
            batch: batchCount,
            currentOffset: offsetId,
            nextOffset: nextOffsetId,
            minId,
            maxId: Math.max(...messageIds),
            lastMessageId
          });
          offsetId = nextOffsetId;
        } else {
          // Historical harvesting (backward) - original logic
          // For next batch, set offsetId to the minimum ID we saw minus 1
          // This tells the API to get messages older than this
          // But only if we haven't already processed all messages in this range
          const nextOffsetId = Math.max(1, minId - 1);
          
          // Special case: when offsetId is 0 (initial state), we should always continue
          // because 0 means "get newest messages" and we want to paginate backward
          if (offsetId === 0) {
            // First batch - always continue to get older messages
            offsetId = nextOffsetId;
            logger.debug('Continuing pagination from initial batch', {
              channel: options.channel,
              batch: batchCount,
              currentOffset: offsetId,
              nextOffset: nextOffsetId,
              minId,
              maxId: Math.max(...messageIds)
            });
          } else if (nextOffsetId >= offsetId) {
            // We're not making progress, stop
            logger.info('Reached earliest messages (no progress)', { 
              channel: options.channel,
              currentOffset: offsetId,
              nextOffset: nextOffsetId
            });
            break;
          } else {
            offsetId = nextOffsetId;
          }
        }

        // Delay between batches
        if (delayMs > 0) {
          await sleep(delayMs);
        }

        // Occasional longer pause
        if (Math.random() < 0.05 && delayMs > 0) {
          const pause = Math.floor(Math.random() * (8000 - 3000 + 1)) + 3000;
          logger.info('Taking a break', { pauseMs: pause });
          await sleep(pause);
        }
      } catch (error) {
        logger.error('Error fetching message batch', {
          channel: options.channel,
          batch: batchCount,
          error: error instanceof Error ? error.message : String(error)
        });
        result.errors++;
        await sleep(5000); // Wait before retrying
      }
    }

    logger.info('Message harvesting completed', {
      channel: options.channel,
      ...result
    });

    return result;
  } finally {
    await client.disconnect();
  }
}

/**
 * Harvest historical messages from a Discord channel
 */
async function harvestDiscordMessages(
  db: DatabaseManager,
  options: HarvestOptions
): Promise<HarvestResult> {
  const botToken = options.botToken || process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error('DISCORD_BOT_TOKEN environment variable or botToken in options is required');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  try {
    await client.login(botToken);
    logger.info('Connected to Discord for message harvesting', {
      channel: options.channel,
      username: client.user?.username || 'Unknown'
    });

    // Resolve channel
    let channelId = options.channel;
    if (channelId.startsWith('<#') && channelId.endsWith('>')) {
      channelId = channelId.slice(2, -1);
    }
    
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error(`Channel ${channelId} is not a valid text channel`);
    }

    const textChannel = channel as TextChannel;
    logger.info('Resolved Discord channel', {
      channel: options.channel,
      channelName: textChannel.name
    });

    // Parse date filters
    const startDate = options.startDate ? dayjs(options.startDate) : null;
    const endDate = options.endDate ? dayjs(options.endDate) : null;

    // Get last message ID from database
    const existingMessages = await db.getMessagesByChannel(options.channel);
    let lastMessageId: string | null = null;
    if (existingMessages.length > 0) {
      // For Discord, we'll fetch recent messages and match by content/date
      // Start from the beginning and let UNIQUE constraint handle duplicates
      logger.info('Found existing messages in database', {
        channel: options.channel,
        existingMessageCount: existingMessages.length
      });
    }

    const result: HarvestResult = {
      totalMessages: 0,
      newMessages: 0,
      skippedMessages: 0,
      errors: 0,
      lastMessageId: 0,
    };

    let batchCount = 0;
    let shouldStop = false;

    while (!shouldStop) {
      batchCount++;
      
      const delayMs = options.delay === 'auto'
        ? Math.floor(Math.random() * (700 - 300 + 1)) + 300
        : (options.delay || 0);

      try {
        const limit = Math.min(100, options.limit && options.limit > 0 ? options.limit - result.newMessages : 100);
        const fetchOptions: any = { limit };
        
        if (lastMessageId) {
          fetchOptions.before = lastMessageId;
        }

        const messages: any = await textChannel.messages.fetch(fetchOptions);
        
        if (messages.size === 0) {
          logger.info('No more messages to harvest', { channel: options.channel });
          break;
        }

        // Discord returns messages newest-first, reverse to process oldest-first
        const ordered: any[] = Array.from(messages.values()).reverse();
        let batchNewMessages = 0;
        let batchSkipped = 0;

        for (const msg of ordered) {
          if (!msg.content && msg.attachments.size === 0) {
            batchSkipped++;
            continue;
          }

          const msgId = msg.id;
          const msgDate = msg.createdAt;

          // Apply date filters
          if (startDate && dayjs(msgDate).isBefore(startDate)) {
            batchSkipped++;
            continue;
          }
          if (endDate && dayjs(msgDate).isAfter(endDate)) {
            batchSkipped++;
            continue;
          }

          // Apply keyword filters
          if (options.keywords && options.keywords.length > 0) {
            const messageText = msg.content.toLowerCase();
            const hasKeyword = options.keywords.some(k => messageText.includes(k.toLowerCase()));
            if (!hasKeyword) {
              batchSkipped++;
              continue;
            }
          }

          // Extract reply_to information
          let replyToMessageId: number | undefined;
          if (msg.reference && msg.reference.messageId) {
            const refId = msg.reference.messageId;
            const parsedRefId = parseInt(refId, 10);
            if (!isNaN(parsedRefId)) {
              replyToMessageId = parsedRefId;
            }
          }

          // Download images if enabled
          let imagePaths: string[] = [];
          if (options.downloadImages && msg.attachments.size > 0) {
            try {
              const imageAttachments = msg.attachments.filter((att: any) => 
                att.contentType?.startsWith('image/')
              );
              for (const attachment of imageAttachments.values()) {
                imagePaths.push(attachment.url);
              }
            } catch (error) {
              logger.warn('Failed to process images for message', {
                channel: options.channel,
                messageId: msgId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }

          // Insert message into database
          try {
            const messageIdNum = hashDiscordId(msgId);
            
            await db.insertMessage({
              message_id: messageIdNum,
              channel: options.channel,
              content: msg.content.replace(/\s+/g, ' ').trim(),
              sender: msg.author.id,
              date: msgDate.toISOString(),
              reply_to_message_id: replyToMessageId,
              image_paths: imagePaths.length > 0 ? JSON.stringify(imagePaths) : undefined,
            });
            batchNewMessages++;
            result.newMessages++;
            result.lastMessageId = Math.max(result.lastMessageId, messageIdNum);
            lastMessageId = msgId;
          } catch (error) {
            if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
              shouldStop = true;
              break;
            } else {
              logger.warn('Failed to insert message', {
                channel: options.channel,
                messageId: msgId,
                error: error instanceof Error ? error.message : String(error)
              });
              result.errors++;
            }
          }

          // Check limit
          if (options.limit && options.limit > 0 && result.newMessages >= options.limit) {
            logger.info('Reached message limit', {
              channel: options.channel,
              limit: options.limit
            });
            shouldStop = true;
            break;
          }
        }

        result.totalMessages += messages.size;
        result.skippedMessages += batchSkipped;

        if (batchNewMessages > 0) {
          logger.info('Harvested batch', {
            channel: options.channel,
            batch: batchCount,
            newMessages: batchNewMessages,
            skipped: batchSkipped,
            totalNew: result.newMessages
          });
        }

        if (shouldStop) {
          break;
        }

        // Prepare next batch - use the oldest message ID as the before parameter
        const messageIds: string[] = Array.from(messages.keys());
        if (messageIds.length === 0) {
          break;
        }
        lastMessageId = messageIds[messageIds.length - 1]; // Oldest message ID

        // Delay between batches
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      } catch (error) {
        logger.error('Error fetching message batch', {
          channel: options.channel,
          batch: batchCount,
          error: error instanceof Error ? error.message : String(error)
        });
        result.errors++;
        await sleep(5000);
      }
    }

    logger.info('Message harvesting completed', {
      channel: options.channel,
      ...result
    });

    return result;
  } finally {
    await client.destroy();
  }
}

/**
 * Harvest historical messages from a Discord channel using self-bot (user token)
 */
async function harvestDiscordSelfBotMessages(
  db: DatabaseManager,
  options: HarvestOptions
): Promise<HarvestResult> {
  const userToken = options.userToken || process.env.DISCORD_USER_TOKEN;
  if (!userToken) {
    throw new Error('DISCORD_USER_TOKEN environment variable or userToken in options is required');
  }

  const client = new SelfBotClient();

  try {
    await client.login(userToken);
    logger.info('Connected to Discord (self-bot) for message harvesting', {
      channel: options.channel,
      username: client.user?.username || 'Unknown',
      userId: client.user?.id || 'Unknown'
    });

    // Log warning about ToS
    logger.warn('Discord self-bot usage violates Discord Terms of Service. Use at your own risk.', {
      channel: options.channel
    });

    // Resolve channel
    let channelId = options.channel;
    if (channelId.startsWith('<#') && channelId.endsWith('>')) {
      channelId = channelId.slice(2, -1);
    }
    
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    // Check if channel is text-based (self-bot package may have different API)
    const channelType = (channel as any).type;
    if (channelType !== 0 && channelType !== 5 && channelType !== 'GUILD_TEXT' && channelType !== 'GUILD_NEWS') {
      throw new Error(`Channel ${channelId} is not a valid text channel`);
    }

    const textChannel = channel as SelfBotTextChannel;
    logger.info('Resolved Discord channel (self-bot)', {
      channel: options.channel,
      channelName: (textChannel as any).name || 'Unknown'
    });

    // Parse date filters
    const startDate = options.startDate ? dayjs(options.startDate) : null;
    const endDate = options.endDate ? dayjs(options.endDate) : null;

    // Get last message ID from database
    const existingMessages = await db.getMessagesByChannel(options.channel);
    let lastMessageId: string | null = null;
    if (existingMessages.length > 0) {
      logger.info('Found existing messages in database', {
        channel: options.channel,
        existingMessageCount: existingMessages.length
      });
    }

    const result: HarvestResult = {
      totalMessages: 0,
      newMessages: 0,
      skippedMessages: 0,
      errors: 0,
      lastMessageId: 0,
    };

    let batchCount = 0;
    let shouldStop = false;

    while (!shouldStop) {
      batchCount++;
      
      const delayMs = options.delay === 'auto'
        ? Math.floor(Math.random() * (700 - 300 + 1)) + 300
        : (options.delay || 0);

      try {
        const limit = Math.min(100, options.limit && options.limit > 0 ? options.limit - result.newMessages : 100);
        const fetchOptions: any = { limit };
        
        if (lastMessageId) {
          fetchOptions.before = lastMessageId;
        }

        const messages: any = await textChannel.messages.fetch(fetchOptions);
        
        // Handle both Collection and array-like responses
        const messageArray = messages.size !== undefined 
          ? Array.from(messages.values())
          : Array.isArray(messages) 
            ? messages 
            : [];
        
        if (messageArray.length === 0) {
          logger.info('No more messages to harvest', { channel: options.channel });
          break;
        }

        // Discord returns messages newest-first, reverse to process oldest-first
        const ordered: any[] = messageArray.reverse();
        let batchNewMessages = 0;
        let batchSkipped = 0;

        for (const msg of ordered) {
          if (!msg.content && (!msg.attachments || (msg.attachments.size === 0 && !Array.isArray(msg.attachments)))) {
            batchSkipped++;
            continue;
          }

          const msgId = msg.id;
          const msgDate = msg.createdAt;

          // Apply date filters
          if (startDate && dayjs(msgDate).isBefore(startDate)) {
            batchSkipped++;
            continue;
          }
          if (endDate && dayjs(msgDate).isAfter(endDate)) {
            batchSkipped++;
            continue;
          }

          // Apply keyword filters
          if (options.keywords && options.keywords.length > 0) {
            const messageText = (msg.content || '').toLowerCase();
            const hasKeyword = options.keywords.some(k => messageText.includes(k.toLowerCase()));
            if (!hasKeyword) {
              batchSkipped++;
              continue;
            }
          }

          // Extract reply_to information
          let replyToMessageId: number | undefined;
          if (msg.reference && msg.reference.messageId) {
            const refId = msg.reference.messageId;
            const parsedRefId = parseInt(refId, 10);
            if (!isNaN(parsedRefId)) {
              replyToMessageId = parsedRefId;
            }
          }

          // Download images if enabled
          let imagePaths: string[] = [];
          const attachments = msg.attachments;
          if (options.downloadImages && attachments) {
            try {
              // Handle both Collection and array-like attachments
              let attachmentArray: any[] = [];
              if (attachments.size !== undefined) {
                attachmentArray = Array.from(attachments.values());
              } else if (Array.isArray(attachments)) {
                attachmentArray = attachments;
              } else if (typeof attachments === 'object') {
                attachmentArray = Object.values(attachments);
              }
              
              const imageAttachments = attachmentArray.filter((att: any) => {
                const contentType = att.contentType || att.content_type || att.type;
                return contentType?.startsWith('image/');
              });
              
              for (const attachment of imageAttachments) {
                const url = attachment.url || attachment.proxy_url || attachment.proxyURL;
                if (url) {
                  imagePaths.push(url);
                }
              }
            } catch (error) {
              logger.warn('Failed to process images for message', {
                channel: options.channel,
                messageId: msgId,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }

          // Insert message into database
          try {
            const messageIdNum = hashDiscordId(msgId);
            
            await db.insertMessage({
              message_id: messageIdNum,
              channel: options.channel,
              content: (msg.content || '').replace(/\s+/g, ' ').trim(),
              sender: msg.author?.id || '',
              date: msgDate.toISOString(),
              reply_to_message_id: replyToMessageId,
              image_paths: imagePaths.length > 0 ? JSON.stringify(imagePaths) : undefined,
            });
            batchNewMessages++;
            result.newMessages++;
            result.lastMessageId = Math.max(result.lastMessageId, messageIdNum);
            lastMessageId = msgId;
          } catch (error) {
            if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
              shouldStop = true;
              break;
            } else {
              logger.warn('Failed to insert message', {
                channel: options.channel,
                messageId: msgId,
                error: error instanceof Error ? error.message : String(error)
              });
              result.errors++;
            }
          }

          // Check limit
          if (options.limit && options.limit > 0 && result.newMessages >= options.limit) {
            logger.info('Reached message limit', {
              channel: options.channel,
              limit: options.limit
            });
            shouldStop = true;
            break;
          }
        }

        result.totalMessages += messageArray.length;
        result.skippedMessages += batchSkipped;

        if (batchNewMessages > 0) {
          logger.info('Harvested batch (self-bot)', {
            channel: options.channel,
            batch: batchCount,
            newMessages: batchNewMessages,
            skipped: batchSkipped,
            totalNew: result.newMessages
          });
        }

        if (shouldStop) {
          break;
        }

        // Prepare next batch - use the oldest message ID as the before parameter
        if (messageArray.length === 0) {
          break;
        }
        lastMessageId = messageArray[messageArray.length - 1]?.id || lastMessageId;

        // Delay between batches
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      } catch (error) {
        logger.error('Error fetching message batch (self-bot)', {
          channel: options.channel,
          batch: batchCount,
          error: error instanceof Error ? error.message : String(error)
        });
        result.errors++;
        await sleep(5000);
      }
    }

    logger.info('Message harvesting completed (self-bot)', {
      channel: options.channel,
      ...result
    });

    return result;
  } finally {
    await client.destroy();
  }
}

/**
 * Resolve Telegram channel entity
 */
async function resolveTelegramEntity(
  client: TelegramClient,
  channel: string,
  accessHash?: string
): Promise<Api.TypeInputPeer> {
  try {
    await client.getDialogs({ limit: 200 });

    // Try numeric channel ID with access hash
    if (/^-?\d+$/.test(channel) && accessHash) {
      return new Api.InputPeerChannel({
        channelId: BigInt(channel) as any,
        accessHash: BigInt(accessHash) as any
      });
    }

    // Try invite link
    if (channel.startsWith('https://t.me/+') || channel.startsWith('t.me/+')) {
      const hash = channel.split('+')[1];
      const res = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      if ('chats' in res && res.chats && res.chats.length) {
        const chat = res.chats[0];
        if (chat instanceof Api.Chat || chat instanceof Api.Channel) {
          return new Api.InputPeerChannel({
            channelId: BigInt(String((chat as Api.Channel).id)) as any,
            accessHash: (chat as Api.Channel).accessHash || BigInt(0) as any
          });
        }
      }
      throw new Error('Invite import returned no chats');
    }

    // Try username or entity
    const entity = await client.getEntity(channel);
    if (entity instanceof Api.Channel) {
      return new Api.InputPeerChannel({
        channelId: BigInt(String(entity.id)) as any,
        accessHash: entity.accessHash || BigInt(0) as any
      });
    }
    if (entity instanceof Api.Chat) {
      return new Api.InputPeerChat({ chatId: entity.id });
    }
    if (entity instanceof Api.User) {
      return new Api.InputPeerUser({
        userId: entity.id,
        accessHash: entity.accessHash || BigInt(0) as any
      });
    }

    throw new Error('Unsupported entity type');
  } catch (error) {
    logger.error('Failed to resolve channel entity', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Convert Discord snowflake ID (string) to a safe integer for database storage
 * Uses a hash function to ensure uniqueness while fitting in JavaScript safe integer range
 */
function hashDiscordId(discordId: string): number {
  // Discord IDs are 64-bit integers as strings
  // We'll use a combination of parts to create a unique hash
  // This ensures we can store it in database INTEGER type (which is 64-bit in SQLite)
  // but we need to stay within JavaScript's safe integer range (2^53 - 1)
  
  // Simple hash: take middle and end portions of the ID
  // Discord snowflakes have structure: timestamp (42 bits) + worker (5 bits) + process (5 bits) + increment (12 bits)
  // We'll combine parts to create a unique numeric ID
  const id = BigInt(discordId);
  // Use modulo to fit in safe integer range (2^53 - 1 = 9007199254740991)
  const maxSafeInt = BigInt(9007199254740991);
  const hashed = Number(id % maxSafeInt);
  // Ensure positive number
  return Math.abs(hashed);
}

