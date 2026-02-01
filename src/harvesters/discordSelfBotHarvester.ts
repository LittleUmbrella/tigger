import { Client, TextChannel, Message as DiscordMessage, PartialMessage } from 'discord.js-selfbot-v13';
import { HarvesterConfig } from '../types/config.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { downloadMessageImages } from '../utils/imageDownloader.js';

/**
 * Convert Discord snowflake ID (string) to a safe integer for database storage
 * Uses a hash function to ensure uniqueness while fitting in JavaScript safe integer range
 * Same implementation as discordHarvester.ts for consistency
 */
const hashDiscordId = (discordId: string): number => {
  const id = BigInt(discordId);
  const maxSafeInt = BigInt(9007199254740991);
  const hashed = Number(id % maxSafeInt);
  return Math.abs(hashed);
};

const sleep = (ms: number): Promise<void> => {
  return new Promise(resolve => {
    if (typeof setTimeout !== 'undefined') {
      setTimeout(resolve, ms);
    } else {
      const start = Date.now();
      while (Date.now() - start < ms) {
        // Busy wait fallback
      }
      resolve();
    }
  });
};

/**
 * Check if a message should be skipped based on age filtering
 * Only applies during startup (when lastMessageId is null)
 */
const shouldSkipMessage = (
  messageDate: Date,
  config: HarvesterConfig,
  isStartup: boolean
): boolean => {
  if (!isStartup) {
    return false; // Don't filter during runtime polling
  }

  const skipOldMessages = config.skipOldMessagesOnStartup !== false; // Default to true
  if (!skipOldMessages) {
    return false;
  }

  const maxAgeMinutes = config.maxMessageAgeMinutes ?? 10; // Default 10 minutes
  const messageAgeMinutes = (Date.now() - messageDate.getTime()) / (1000 * 60);
  
  return messageAgeMinutes > maxAgeMinutes;
};

/**
 * Connect to Discord using user account token (self-bot)
 */
const connectSelfBot = async (
  config: HarvesterConfig,
  client: Client
): Promise<void> => {
  try {
    // Priority: envVarNames.userToken > default DISCORD_USER_TOKEN env var
    const userToken = config.envVarNames?.userToken 
      ? process.env[config.envVarNames.userToken] 
      : process.env.DISCORD_USER_TOKEN;
    
    if (!userToken) {
      const envVarName = config.envVarNames?.userToken || 'DISCORD_USER_TOKEN';
      throw new Error(`Discord user token required: set envVarNames.userToken in config, or ${envVarName} environment variable`);
    }
    
    await client.login(userToken);
    logger.info('Connected to Discord (self-bot)', {
      channel: config.channel,
      username: client.user?.username || 'Unknown',
      userId: client.user?.id || 'Unknown'
    });
    
    // Log warning about ToS
    logger.warn('Discord self-bot usage violates Discord Terms of Service. Use at your own risk.', {
      channel: config.channel
    });
  } catch (error) {
    logger.error('Failed to connect to Discord (self-bot)', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

/**
 * Resolve Discord channel from channel ID or mention format
 */
const resolveChannel = async (
  config: HarvesterConfig,
  client: Client
): Promise<TextChannel> => {
  try {
    let channelId = config.channel;
    
    // Handle channel mention format: <#123456789>
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
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    
    return channel as TextChannel;
  } catch (error) {
    logger.error('Failed to resolve Discord channel (self-bot)', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

/**
 * Fetch new messages from Discord channel and store in database
 */
const fetchNewMessages = async (
  config: HarvesterConfig,
  channel: TextChannel,
  db: DatabaseManager,
  lastMessageId: string | null,
  isStartup: boolean
): Promise<string | null> => {
  try {
    const limit = 100; // Discord API limit
    const options: any = { limit };
    
    // For live harvester: only use 'after' if we have a lastMessageId (resuming from previous poll)
    // On startup without lastMessageId, fetch recent messages and rely on age filtering
    if (lastMessageId) {
      options.after = lastMessageId; // Fetch messages AFTER this ID (newer messages)
    }
    // If no lastMessageId, fetch most recent messages (Discord returns newest-first)
    
    const messages: any = await channel.messages.fetch(options);
    
    if (!messages || (messages.size !== undefined && messages.size === 0)) {
      return lastMessageId;
    }

    // Discord returns messages newest-first, reverse to process oldest-first
    // Handle both Collection and array-like responses
    const messageArray = messages.size !== undefined 
      ? Array.from(messages.values() as IterableIterator<DiscordMessage>)
      : Array.isArray(messages) 
        ? messages 
        : [];
    const ordered: DiscordMessage[] = messageArray.reverse();
    let newLastMessageId = lastMessageId;
    let newMessagesCount = 0;
    let skippedCount = 0;

    for (const msg of ordered) {
      // Skip bot messages if downloadImages is false (optional filtering)
      if (msg.author.bot && !config.downloadImages) {
        skippedCount++;
        continue;
      }

      const msgId = msg.id;
      const msgDate = msg.createdAt;

      // Apply age filtering on startup
      if (shouldSkipMessage(msgDate, config, isStartup)) {
        skippedCount++;
        logger.debug('Skipping old message (exceeds maxMessageAgeMinutes)', {
          channel: config.channel,
          messageId: msgId,
          ageMinutes: (Date.now() - msgDate.getTime()) / (1000 * 60)
        });
        continue;
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
      const attachments = (msg as any).attachments;
      if (config.downloadImages && attachments) {
        try {
          // Handle both Collection and array-like attachments
          let attachmentArray: any[] = [];
          if (attachments.size !== undefined) {
            // It's a Collection
            attachmentArray = Array.from(attachments.values());
          } else if (Array.isArray(attachments)) {
            attachmentArray = attachments;
          } else if (typeof attachments === 'object') {
            // Try to get values from object
            attachmentArray = Object.values(attachments);
          }
          
          const imageAttachments = attachmentArray.filter((att: any) => {
            const contentType = att.contentType || att.content_type || att.type;
            return contentType?.startsWith('image/');
          });
          
          for (const attachment of imageAttachments) {
            // Store URL - could download if needed
            const url = attachment.url || attachment.proxy_url || attachment.proxyURL;
            if (url) {
              imagePaths.push(url);
            }
          }
        } catch (error) {
          logger.warn('Failed to process images for message', {
            channel: config.channel,
            messageId: msgId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      try {
        const messageIdNum = hashDiscordId(msgId);
        
        await db.insertMessage({
          message_id: messageIdNum,
          channel: config.channel,
          content: msg.content.replace(/\s+/g, ' ').trim(),
          sender: msg.author.id,
          date: msgDate.toISOString(),
          reply_to_message_id: replyToMessageId,
          image_paths: imagePaths.length > 0 ? JSON.stringify(imagePaths) : undefined
        });
        newMessagesCount++;
        newLastMessageId = msgId;
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
          skippedCount++;
        } else {
          logger.warn('Failed to insert message', {
            channel: config.channel,
            messageId: msgId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    if (newMessagesCount > 0) {
      logger.info('Harvested new messages (self-bot)', {
        channel: config.channel,
        count: newMessagesCount,
        skipped: skippedCount,
        lastMessageId: newLastMessageId
      });
    } else if (skippedCount > 0) {
      logger.debug('All messages in batch were skipped', {
        channel: config.channel,
        totalMessages: messages.size,
        skipped: skippedCount
      });
    }

    return newLastMessageId;
  } catch (error) {
    logger.error('Failed to fetch messages (self-bot)', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

/**
 * Start Discord self-bot harvester
 * 
 * @param config - Harvester configuration with platform: 'discord-selfbot'
 * @param db - Database manager instance
 * @returns Stop function that gracefully shuts down the harvester
 */
export const startDiscordSelfBotHarvester = async (
  config: HarvesterConfig,
  db: DatabaseManager
): Promise<() => Promise<void>> => {
  logger.info('Starting Discord self-bot harvester', { 
    name: config.name, 
    channel: config.channel 
  });
  
  const client = new Client();

  let running = true;
  let lastMessageId: string | null = null;
  let channel: TextChannel | undefined;
  let isStartup = true;

  try {
    await connectSelfBot(config, client);
    channel = await resolveChannel(config, client);
    
    logger.info('Resolved Discord channel (self-bot)', {
      name: config.name,
      channel: config.channel,
      channelName: channel.name
    });

    // For live harvester: Initialize by fetching recent messages and finding the latest one
    // We can't directly map hashed message IDs back to Discord IDs, so we:
    // 1. Fetch recent messages from Discord
    // 2. Check which ones exist in database (via UNIQUE constraint)
    // 3. Use age filtering to skip old messages on startup
    // 4. After first successful fetch, use lastMessageId for subsequent polls
    const existingMessages = await db.getMessagesByChannel(config.channel);
    if (existingMessages.length > 0) {
      logger.info('Found existing messages in database, will use age filtering on startup', {
        channel: config.channel,
        existingMessageCount: existingMessages.length
      });
      // Note: We'll fetch recent messages and:
      // - Age filtering will skip messages older than maxMessageAgeMinutes
      // - UNIQUE constraint will handle duplicates
      // - After first fetch, lastMessageId will be set for subsequent polls
    } else {
      logger.info('No existing messages in database, will fetch recent messages', {
        channel: config.channel
      });
    }

    // Set up event handler for message updates (edits)
    client.on('messageUpdate', async (oldMsg: DiscordMessage | PartialMessage, newMsg: DiscordMessage | PartialMessage) => {
      if (!newMsg.inGuild() || newMsg.channelId !== channel?.id) {
        return;
      }

      try {
        if (newMsg.partial) {
          await newMsg.fetch();
        }

        const messageIdNum = hashDiscordId(newMsg.id);
        const existingMessage = await db.getMessageByMessageId(messageIdNum, config.channel);
        
        if (!existingMessage) {
          logger.debug('Edited message not found in database', {
            channel: config.channel,
            messageId: newMsg.id
          });
          return;
        }

        const newContent = newMsg.content?.replace(/\s+/g, ' ').trim() || '';
        
        if (newContent === existingMessage.content) {
          return;
        }

        // Store the previous version in message_versions table
        try {
          await db.insertMessageVersion(messageIdNum, config.channel, existingMessage.content);
        } catch (error) {
          logger.warn('Failed to insert message version, continuing with update', {
            channel: config.channel,
            messageId: newMsg.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        // Update message in database with new content
        await db.updateMessage(messageIdNum, config.channel, {
          content: newContent,
          old_content: existingMessage.content,
          edited_at: new Date().toISOString(),
          parsed: false // Mark as unparsed to trigger re-processing
        });

        logger.info('Message edit detected and stored (self-bot)', {
          channel: config.channel,
          messageId: newMsg.id,
          oldContentLength: existingMessage.content.length,
          newContentLength: newContent.length
        });
      } catch (error) {
        logger.error('Error handling message edit (self-bot)', {
          channel: config.channel,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    const pollInterval = config.pollInterval || 5000;

    const harvestLoop = async (): Promise<void> => {
      while (running) {
        try {
          if (channel) {
            lastMessageId = await fetchNewMessages(
              config, 
              channel, 
              db, 
              lastMessageId,
              isStartup
            );
            isStartup = false; // After first poll, we're no longer in startup mode
          }
          await sleep(pollInterval);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          
          // Handle rate limiting with exponential backoff
          if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
            logger.warn('Rate limit detected, applying exponential backoff', {
              channel: config.channel,
              error: errorMessage
            });
            await sleep(pollInterval * 2); // Double the wait time
          } else {
            logger.error('Error in harvest loop (self-bot)', {
              channel: config.channel,
              error: errorMessage
            });
            await sleep(pollInterval * 2);
          }
        }
      }
    };

    // Start the harvest loop in the background
    harvestLoop().catch(error => {
      logger.error('Fatal error in harvest loop (self-bot)', {
        channel: config.channel,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  } catch (error) {
    logger.error('Failed to start Discord self-bot harvester', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    await client.destroy();
    throw error;
  }

  // Return stop function
  return async (): Promise<void> => {
    logger.info('Stopping Discord self-bot harvester', { channel: config.channel });
    running = false;
    await client.destroy();
  };
};

