import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { HarvesterConfig } from '../types/config.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';

interface HarvesterState {
  client: TelegramClient;
  running: boolean;
  lastMessageId: number;
  entity?: Api.TypeInputPeer;
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
 * Downloads images from a Telegram message and stores them locally
 * @returns Array of relative file paths (relative to data directory)
 */
const downloadMessageImages = async (
  config: HarvesterConfig,
  client: TelegramClient,
  msg: Api.Message
): Promise<string[]> => {
  if (!config.downloadImages) {
    return [];
  }

  const imagePaths: string[] = [];
  
  try {
    // Check if message has media (photos)
    if (!('media' in msg) || !msg.media) {
      return [];
    }

    // Handle photo media
    if (msg.media instanceof Api.MessageMediaPhoto) {
      const photo = msg.media.photo;
      if (!(photo instanceof Api.Photo)) {
        return [];
      }

      const msgId = Number(msg.id);
      const sanitizedChannel = config.channel.replace(/[^a-zA-Z0-9_-]/g, '_');
      const imageDir = path.join('data', 'images', sanitizedChannel, String(msgId));
      
      // Ensure directory exists
      await fs.ensureDir(imageDir);

      // Download the photo
      try {
        const buffer = await client.downloadMedia(msg, {});
        if (!buffer) {
          logger.warn('Failed to download image buffer', {
            channel: config.channel,
            messageId: msgId
          });
          return [];
        }

        // Determine file extension (default to jpg for photos)
        const fileExtension = 'jpg';
        const fileName = `image_${Date.now()}.${fileExtension}`;
        const filePath = path.join(imageDir, fileName);
        const relativePath = path.join('images', sanitizedChannel, String(msgId), fileName);

        await fs.writeFile(filePath, buffer);
        imagePaths.push(relativePath);

        logger.debug('Downloaded image from message', {
          channel: config.channel,
          messageId: msgId,
          path: relativePath
        });
      } catch (error) {
        logger.warn('Error downloading image', {
          channel: config.channel,
          messageId: msgId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    // Handle document media (could be images sent as documents)
    else if (msg.media instanceof Api.MessageMediaDocument) {
      const document = msg.media.document;
      if (!(document instanceof Api.Document)) {
        return [];
      }

      // Check if document is an image based on mime type
      const mimeType = document.mimeType || '';
      if (!mimeType.startsWith('image/')) {
        return [];
      }

      const msgId = Number(msg.id);
      const sanitizedChannel = config.channel.replace(/[^a-zA-Z0-9_-]/g, '_');
      const imageDir = path.join('data', 'images', sanitizedChannel, String(msgId));
      
      // Ensure directory exists
      await fs.ensureDir(imageDir);

      // Download the document
      try {
        const buffer = await client.downloadMedia(msg, {});
        if (!buffer) {
          logger.warn('Failed to download image document buffer', {
            channel: config.channel,
            messageId: msgId
          });
          return [];
        }

        // Determine file extension from mime type
        const mimeToExt: Record<string, string> = {
          'image/jpeg': 'jpg',
          'image/jpg': 'jpg',
          'image/png': 'png',
          'image/gif': 'gif',
          'image/webp': 'webp'
        };
        const fileExtension = mimeToExt[mimeType] || 'jpg';
        const fileName = `image_${Date.now()}.${fileExtension}`;
        const filePath = path.join(imageDir, fileName);
        const relativePath = path.join('images', sanitizedChannel, String(msgId), fileName);

        await fs.writeFile(filePath, buffer);
        imagePaths.push(relativePath);

        logger.debug('Downloaded image document from message', {
          channel: config.channel,
          messageId: msgId,
          path: relativePath
        });
      } catch (error) {
        logger.warn('Error downloading image document', {
          channel: config.channel,
          messageId: msgId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    logger.warn('Error processing message media', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return imagePaths;
};

const connectTelegram = async (
  config: HarvesterConfig,
  client: TelegramClient
): Promise<void> => {
  try {
    const sessionString = process.env.TG_SESSION;
    if (!sessionString) {
      throw new Error('TG_SESSION environment variable is required');
    }
    await client.connect();
    const me = await client.getMe();
    logger.info('Connected to Telegram', {
      channel: config.channel,
      username: me.username || me.firstName
    });
  } catch (error) {
    logger.error('Failed to connect to Telegram', {
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

const resolveEntity = async (
  config: HarvesterConfig,
  client: TelegramClient
): Promise<Api.TypeInputPeer> => {
  try {
    await client.getDialogs({ limit: 200 });
    
    if (/^-?\d+$/.test(config.channel) && config.accessHash) {
      return new Api.InputPeerChannel({
        channelId: BigInt(config.channel) as any,
        accessHash: BigInt(config.accessHash) as any
      });
    }
    
    if (config.channel.startsWith('https://t.me/+') || config.channel.startsWith('t.me/+')) {
      const hash = config.channel.split('+')[1];
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
    
    const entity = await client.getEntity(config.channel);
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
      channel: config.channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

const fetchNewMessages = async (
  config: HarvesterConfig,
  client: TelegramClient,
  entity: Api.TypeInputPeer,
  db: DatabaseManager,
  lastMessageId: number
): Promise<number> => {
  try {
    const history = await client.invoke(new Api.messages.GetHistory({
      peer: entity,
      offsetId: BigInt(lastMessageId || 0) as any,
      limit: 100,
      addOffset: 0,
      maxId: 0,
      minId: 0,
      hash: BigInt(0) as any,
    }));

    const messages = ('messages' in history && history.messages) ? history.messages : [];
    if (messages.length === 0) {
      return lastMessageId;
    }

    let newLastMessageId = lastMessageId;
    const ordered = [...messages].reverse();
    let newMessagesCount = 0;

    for (const msg of ordered) {
      if (!('message' in msg) || !msg.message) continue;

      const msgId = Number(msg.id);
      if (Number.isNaN(msgId) || msgId <= lastMessageId) continue;

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
      if (config.downloadImages && msg instanceof Api.Message) {
        try {
          imagePaths = await downloadMessageImages(config, client, msg);
        } catch (error) {
          logger.warn('Failed to download images for message', {
            channel: config.channel,
            messageId: msgId,
            error: error instanceof Error ? error.message : String(error)
          });
          // Continue with message insertion even if image download fails
        }
      }

      try {
        await db.insertMessage({
          message_id: msgId,
          channel: config.channel,
          content: String(msg.message).replace(/\s+/g, ' ').trim(),
          sender: String((msg as any).fromId?.userId || (msg as any).senderId?.userId || ''),
          date: msgDate.toISOString(),
          reply_to_message_id: replyToMessageId,
          image_paths: imagePaths.length > 0 ? JSON.stringify(imagePaths) : undefined
        });
        newMessagesCount++;
        newLastMessageId = Math.max(newLastMessageId, msgId);
      } catch (error) {
        if (error instanceof Error && !error.message.includes('UNIQUE constraint')) {
          logger.warn('Failed to insert message', {
            channel: config.channel,
            messageId: msgId,
            error: error.message
          });
        }
      }
    }

    if (newMessagesCount > 0) {
      logger.info('Harvested new messages', {
        channel: config.channel,
        count: newMessagesCount,
        lastMessageId: newLastMessageId
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

export const startSignalHarvester = async (
  config: HarvesterConfig,
  db: DatabaseManager
): Promise<() => Promise<void>> => {
  logger.info('Starting signal harvester', { name: config.name, channel: config.channel });
  
  // Read global settings from environment variables
  const apiHash = process.env.TG_API_HASH;
  const sessionString = process.env.TG_SESSION || '';
  
  if (!apiHash) {
    throw new Error('TG_API_HASH environment variable is required');
  }
  if (!sessionString) {
    throw new Error('TG_SESSION environment variable is required');
  }
  
  const client = new TelegramClient(
    new StringSession(sessionString),
    config.apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  let running = true;
  let lastMessageId = 0;
  let entity: Api.TypeInputPeer | undefined;

  await connectTelegram(config, client);
  entity = await resolveEntity(config, client);
  
  logger.info('Resolved channel entity', {
    name: config.name,
    channel: config.channel,
    title: (entity as any).title || (entity as any).username || config.channel
  });

  // Set up event handler for message edits
  client.addEventHandler(async (update: any) => {
    if (update instanceof Api.UpdateEditMessage) {
      try {
        // UpdateEditMessage has a 'message' property, not 'messageId'
        const message = update.message;
        if (!message || !('id' in message)) return;
        
        const messageId = Number(message.id);
        if (Number.isNaN(messageId)) return;

        // Get the updated message
        const messages = await client.getMessages(entity!, { ids: [messageId] });
        if (!messages || messages.length === 0) return;

        const msg = messages[0];
        if (!('message' in msg) || !msg.message) return;

        // Get existing message from database
        const existingMessage = await db.getMessageByMessageId(messageId, config.channel);
        if (!existingMessage) {
          logger.debug('Edited message not found in database', {
            channel: config.channel,
            messageId
          });
          return;
        }

        const newContent = String(msg.message).replace(/\s+/g, ' ').trim();
        
        // Only process if content actually changed
        if (newContent === existingMessage.content) {
          return;
        }

        // Store the previous version in message_versions table
        try {
          await db.insertMessageVersion(messageId, config.channel, existingMessage.content);
        } catch (error) {
          logger.warn('Failed to insert message version, continuing with update', {
            channel: config.channel,
            messageId,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        // Update message in database with new content
        // Keep old_content for backward compatibility, but versions table is the source of truth
        await db.updateMessage(messageId, config.channel, {
          content: newContent,
          old_content: existingMessage.content, // Keep for backward compatibility
          edited_at: new Date().toISOString(),
          parsed: false // Mark as unparsed to trigger re-processing
        });

        logger.info('Message edit detected and stored', {
          channel: config.channel,
          messageId,
          oldContentLength: existingMessage.content.length,
          newContentLength: newContent.length
        });
      } catch (error) {
        logger.error('Error handling message edit', {
          channel: config.channel,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  });

  const pollInterval = config.pollInterval || 5000;

  const harvestLoop = async (): Promise<void> => {
    while (running) {
      try {
        if (entity) {
          lastMessageId = await fetchNewMessages(config, client, entity, db, lastMessageId);
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
    logger.info('Stopping signal harvester', { channel: config.channel });
    running = false;
    await client.disconnect();
  };
};
