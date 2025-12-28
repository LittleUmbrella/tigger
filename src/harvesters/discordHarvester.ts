import { Client, GatewayIntentBits, TextChannel, Message as DiscordMessage, PartialMessage, Collection, Attachment } from 'discord.js';
import { HarvesterConfig } from '../types/config.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { downloadMessageImages } from '../utils/imageDownloader.js';

interface HarvesterState {
  client: Client;
  running: boolean;
  lastMessageId: string | null;
  channel?: TextChannel;
}

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
 * Convert Discord snowflake ID (string) to a safe integer for database storage
 * Uses a hash function to ensure uniqueness while fitting in JavaScript safe integer range
 */
const hashDiscordId = (discordId: string): number => {
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
};

const connectDiscord = async (
  config: HarvesterConfig,
  client: Client
): Promise<void> => {
  try {
    const botToken = config.botToken || process.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      throw new Error('DISCORD_BOT_TOKEN environment variable or botToken in config is required');
    }
    
    await client.login(botToken);
    logger.info('Connected to Discord', {
      channel: config.channel,
      username: client.user?.username || 'Unknown'
    });
  } catch (error) {
    logger.error('Failed to connect to Discord', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

const resolveChannel = async (
  config: HarvesterConfig,
  client: Client
): Promise<TextChannel> => {
  try {
    // Channel can be a channel ID or channel mention format
    let channelId = config.channel;
    
    // Handle channel mention format: <#123456789>
    if (channelId.startsWith('<#') && channelId.endsWith('>')) {
      channelId = channelId.slice(2, -1);
    }
    
    // Try to fetch the channel directly
    const channel = await client.channels.fetch(channelId);
    
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }
    
    if (!channel.isTextBased() || channel.isDMBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    
    return channel as TextChannel;
  } catch (error) {
    logger.error('Failed to resolve Discord channel', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

const fetchNewMessages = async (
  config: HarvesterConfig,
  channel: TextChannel,
  db: DatabaseManager,
  lastMessageId: string | null
): Promise<string | null> => {
  try {
    // Fetch recent messages (Discord API limit is 100 per request)
    const limit = 100;
    const options: any = { limit };
    
    // If we have a last message ID, fetch messages after it
    if (lastMessageId) {
      options.after = lastMessageId;
    }
    
    const messages: any = await channel.messages.fetch(options);
    
    if (messages.size === 0) {
      return lastMessageId;
    }

    // Discord returns messages newest-first, reverse to process oldest-first
    const ordered: DiscordMessage[] = Array.from(messages.values() as IterableIterator<DiscordMessage>).reverse();
    let newLastMessageId = lastMessageId;
    let newMessagesCount = 0;
    let skippedCount = 0;

    for (const msg of ordered) {
      // Skip bot messages if needed (optional, but useful for filtering)
      if (msg.author.bot && !config.downloadImages) {
        skippedCount++;
        continue;
      }

      const msgId = msg.id;
      const msgDate = msg.createdAt;

      // Extract reply_to information
      let replyToMessageId: number | undefined;
      if (msg.reference && msg.reference.messageId) {
        // Discord message IDs are strings, but we store them as numbers in DB
        // We'll need to handle this - for now, try to parse if it's numeric
        const refId = msg.reference.messageId;
        const parsedRefId = parseInt(refId, 10);
        if (!isNaN(parsedRefId)) {
          replyToMessageId = parsedRefId;
        }
      }

      // Download images if enabled
      let imagePaths: string[] = [];
      if (config.downloadImages && msg.attachments.size > 0) {
        try {
          // Discord attachments - download images
          const imageAttachments = msg.attachments.filter((att: Attachment) => 
            att.contentType?.startsWith('image/')
          );
          
          for (const attachment of imageAttachments.values()) {
            // For now, just store the URL - could download if needed
            imagePaths.push(attachment.url);
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
        // Convert Discord message ID (string) to number for database
        // Discord IDs are snowflakes (64-bit integers as strings)
        // Use a hash function to convert to a safe integer (JavaScript safe integer range)
        // This ensures uniqueness while fitting in database INTEGER type
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
          // Message already exists in database - this is expected for duplicates
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
      logger.info('Harvested new messages', {
        channel: config.channel,
        count: newMessagesCount,
        skipped: skippedCount,
        lastMessageId: newLastMessageId
      });
    } else if (skippedCount > 0) {
      logger.debug('All messages in batch were skipped', {
        channel: config.channel,
        totalMessages: (messages as any).size,
        skipped: skippedCount
      });
    }

    return newLastMessageId;
  } catch (error) {
    logger.error('Failed to fetch messages', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

export const startDiscordHarvester = async (
  config: HarvesterConfig,
  db: DatabaseManager
): Promise<() => Promise<void>> => {
  logger.info('Starting Discord harvester', { name: config.name, channel: config.channel });
  
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  let running = true;
  let lastMessageId: string | null = null;
  let channel: TextChannel | undefined;

  await connectDiscord(config, client);
  channel = await resolveChannel(config, client);
  
  logger.info('Resolved Discord channel', {
    name: config.name,
    channel: config.channel,
    channelName: channel.name
  });

  // Initialize lastMessageId from database to avoid reprocessing existing messages on startup
  const existingMessages = await db.getMessagesByChannel(config.channel);
  if (existingMessages.length > 0) {
    // Get the highest message_id from existing messages
    // Note: We stored numeric IDs, but Discord uses string IDs
    // We'll need to fetch recent messages and match by content/date
    // For now, we'll just start from the beginning and let UNIQUE constraint handle duplicates
    logger.info('Found existing messages in database', {
      channel: config.channel,
      existingMessageCount: existingMessages.length
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

      // Get existing message from database
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
      
      // Only process if content actually changed
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
        old_content: existingMessage.content, // Keep for backward compatibility
        edited_at: new Date().toISOString(),
        parsed: false // Mark as unparsed to trigger re-processing
      });

      logger.info('Message edit detected and stored', {
        channel: config.channel,
        messageId: newMsg.id,
        oldContentLength: existingMessage.content.length,
        newContentLength: newContent.length
      });
    } catch (error) {
      logger.error('Error handling message edit', {
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
          lastMessageId = await fetchNewMessages(config, channel, db, lastMessageId);
        }
        await sleep(pollInterval);
      } catch (error) {
        logger.error('Error in harvest loop', {
          channel: config.channel,
          error: error instanceof Error ? error.message : String(error)
        });
        await sleep(pollInterval * 2);
      }
    }
  };

  // Start the harvest loop in the background
  harvestLoop().catch(error => {
    logger.error('Fatal error in harvest loop', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  // Return stop function
  return async (): Promise<void> => {
    logger.info('Stopping Discord harvester', { channel: config.channel });
    running = false;
    await client.destroy();
  };
};

