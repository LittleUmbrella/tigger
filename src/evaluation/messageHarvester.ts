/**
 * Message Harvester for Evaluation
 * 
 * Pulls historical messages from Telegram channels and stores them in the database.
 * This is a re-implementation of the script utility that uses the database instead of flat files.
 */

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { downloadMessageImages } from '../utils/imageDownloader.js';
import dayjs from 'dayjs';

export interface HarvestOptions {
  channel: string;
  accessHash?: string;
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
 * Harvest historical messages from a Telegram channel
 */
export async function harvestMessages(
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
    const entity = await resolveEntity(client, options.channel, options.accessHash);
    logger.info('Resolved channel entity', {
      channel: options.channel,
      title: (entity as any).title || (entity as any).username || options.channel
    });

    // Parse date filters
    const startDate = options.startDate ? dayjs(options.startDate) : null;
    const endDate = options.endDate ? dayjs(options.endDate) : null;

    // Get last message ID from database for this channel
    const existingMessages = await db.getUnparsedMessages(options.channel);
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

    // offsetId is used for API pagination (messages older than this ID)
    // lastProcessedId tracks the highest message ID we've successfully processed
    let offsetId = lastMessageId;
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

        // Telegram API returns messages newest-first, reverse to process oldest-first
        const ordered = [...messages].reverse();
        let batchNewMessages = 0;
        let batchSkipped = 0;

        for (const msg of ordered) {
          if (!('message' in msg) || !msg.message) {
            batchSkipped++;
            logger.debug('Skipping message: no message content', {
              channel: options.channel,
              messageId: msg.id
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

          // Note: We don't skip based on lastProcessedId here because:
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
        
        // For next batch, set offsetId to the minimum ID we saw minus 1
        // This tells the API to get messages older than this
        // But only if we haven't already processed all messages in this range
        const nextOffsetId = Math.max(1, minId - 1);
        if (nextOffsetId >= offsetId) {
          // We're not making progress, stop
          logger.info('Reached earliest messages (no progress)', { 
            channel: options.channel,
            currentOffset: offsetId,
            nextOffset: nextOffsetId
          });
          break;
        }
        offsetId = nextOffsetId;

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
 * Resolve channel entity
 */
async function resolveEntity(
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
            channelId: (chat as Api.Channel).id,
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
        channelId: entity.id,
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

