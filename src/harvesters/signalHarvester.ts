import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { HarvesterConfig } from '../types/config.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { downloadMessageImages } from '../utils/imageDownloader.js';

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
    
    // Priority: envVarNames > direct accessHash (deprecated) > none
    const accessHashValue = config.envVarNames?.accessHash 
      ? process.env[config.envVarNames.accessHash] 
      : config.accessHash;
    
    if (/^-?\d+$/.test(config.channel) && accessHashValue) {
      return new Api.InputPeerChannel({
        channelId: BigInt(config.channel) as any,
        accessHash: BigInt(accessHashValue) as any
      });
    }
    
    if (config.channel.startsWith('https://t.me/+') || config.channel.startsWith('t.me/+')) {
      const hash = config.channel.split('+')[1];
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
    
    // Try to resolve by username/channel name using getDialogs first (safer for large IDs)
    // This avoids getEntity which may have issues with large channel IDs
    const dialogs = await client.getDialogs({ limit: 200 });
    const foundDialog = dialogs.find(d => {
      const entity = d.entity;
      if (entity instanceof Api.Channel) {
        // Match by username (without @), numeric ID, or title
        const usernameMatch = entity.username && (
          entity.username === config.channel || 
          entity.username === config.channel.replace('@', '')
        );
        const idMatch = String(entity.id) === config.channel;
        const titleMatch = entity.title && entity.title.toLowerCase() === config.channel.toLowerCase();
        return usernameMatch || idMatch || titleMatch;
      }
      return false;
    });
    
    if (foundDialog && foundDialog.entity instanceof Api.Channel) {
      logger.debug('Found channel in dialogs', {
        channel: config.channel,
        channelId: String(foundDialog.entity.id),
        username: foundDialog.entity.username,
        title: foundDialog.entity.title
      });
      return new Api.InputPeerChannel({
        channelId: BigInt(String(foundDialog.entity.id)) as any,
        accessHash: foundDialog.entity.accessHash || BigInt(0) as any
      });
    }
    
    logger.debug('Channel not found in dialogs, will try getEntity', {
      channel: config.channel,
      dialogsChecked: dialogs.length,
      availableChannels: dialogs
        .filter(d => d.entity instanceof Api.Channel)
        .map(d => ({
          id: String((d.entity as Api.Channel).id),
          username: (d.entity as Api.Channel).username,
          title: (d.entity as Api.Channel).title
        }))
    });
    
    // Fallback to getEntity if not found in dialogs
    // Note: getEntity may fail for large channel IDs, so we catch and provide better error
    try {
      const entity = await client.getEntity(config.channel);
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // If getEntity fails due to large channel ID, provide helpful error
      if (errorMessage.includes('out of range')) {
        throw new Error(
          `Channel ID too large for getEntity. Channel "${config.channel}" not found in dialogs. ` +
          `Please ensure the channel is accessible or provide channel ID and access hash directly. ` +
          `Original error: ${errorMessage}`
        );
      }
      // If getEntity fails for other reasons, rethrow
      throw error;
    }
    
    // Should not reach here, but TypeScript needs this
    throw new Error('Failed to resolve channel entity');
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
  lastMessageId: number,
  isFirstFetchAfterStartup: boolean = false
): Promise<number> => {
  try {
    // Ensure client is connected before making API calls
    if (!client.connected) {
      logger.debug('Client not connected, waiting for reconnection', { channel: config.channel });
      // Wait a bit for automatic reconnection (Telegram library handles this)
      await sleep(1000);
      // If still not connected after wait, skip this iteration
      if (!client.connected) {
        logger.warn('Client still not connected, skipping fetch', { channel: config.channel });
        return lastMessageId;
      }
    }

    // For forward polling (new messages), always get the most recent messages
    // offsetId: 0 means get the newest messages
    // We'll filter out already-processed messages below
    const history = await client.invoke(new Api.messages.GetHistory({
      peer: entity,
      offsetId: 0,
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

    // Telegram API returns messages newest-first, reverse to process oldest-first
    const ordered = [...messages].reverse();
    let newLastMessageId = lastMessageId;
    let newMessagesCount = 0;
    let skippedCount = 0;
    let skippedOldCount = 0;

    // Filter out messages older than maxMessageAgeMinutes (applies to all fetches)
    const maxAgeMinutes = config.maxMessageAgeMinutes ?? 10;
    const skipOldMessages = config.skipOldMessagesOnStartup !== false; // Default to true
    const now = Date.now();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;

    for (const msg of ordered) {
      if (!('message' in msg) || !msg.message) {
        skippedCount++;
        logger.debug('Skipping message: no message content', {
          channel: config.channel,
          messageId: msg.id
        });
        continue;
      }

      // Handle BigInt message IDs properly
      const msgIdBigInt = typeof msg.id === 'bigint' ? msg.id : BigInt(msg.id);
      const msgId = Number(msgIdBigInt);
      if (Number.isNaN(msgId)) {
        skippedCount++;
        logger.debug('Skipping message: invalid ID', {
          channel: config.channel,
          messageId: msgId
        });
        continue;
      }

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

      // Skip old messages that exceed maxMessageAgeMinutes
      // This applies to all fetches, not just the first, to prevent inserting stale messages
      // that may be returned by the Telegram API in subsequent polls (e.g., after reconnection)
      if (skipOldMessages) {
        const msgAge = now - msgDate.getTime();
        if (msgAge > maxAgeMs) {
          skippedOldCount++;
          skippedCount++;
          logger.debug('Skipping old message (exceeds maxMessageAgeMinutes)', {
            channel: config.channel,
            messageId: msgId,
            ageMinutes: Math.round(msgAge / 60000),
            maxAgeMinutes,
            isFirstFetch: isFirstFetchAfterStartup
          });
          continue;
        }
      }

      // Note: We don't skip based on lastMessageId here because:
      // 1. Telegram returns messages newest-first, we reverse to process oldest-first
      // 2. After reversing, we process messages in order: oldest (lowest ID) to newest (highest ID)
      // 3. If we skip based on lastMessageId, we'd incorrectly skip older messages that come after newer ones
      // 4. The database UNIQUE constraint on (message_id, channel) will handle duplicates
      // 5. We track newLastMessageId to know the highest ID we've processed in this batch

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
          imagePaths = await downloadMessageImages(
            { channel: config.channel, downloadImages: config.downloadImages },
            client,
            msg
          );
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
        skippedOld: skippedOldCount,
        lastMessageId: newLastMessageId
      });
    } else if (skippedCount > 0) {
      if (skippedOldCount > 0) {
        logger.info('Skipped old messages (exceed maxMessageAgeMinutes)', {
          channel: config.channel,
          totalMessages: messages.length,
          skippedOld: skippedOldCount,
          maxAgeMinutes
        });
      } else {
        logger.debug('All messages in batch were skipped', {
          channel: config.channel,
          totalMessages: messages.length,
          skipped: skippedCount
        });
      }
    }

    return newLastMessageId;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Don't throw on connection errors - let the library handle reconnection
    // Just log and return current lastMessageId to continue polling
    if (errorMessage.includes('Not connected') || errorMessage.includes('Connection')) {
      logger.debug('Connection error during fetch, will retry on next poll', {
        channel: config.channel,
        error: errorMessage
      });
      return lastMessageId;
    }
    logger.error('Failed to fetch messages', {
      channel: config.channel,
      error: errorMessage
    });
    // Only throw for non-connection errors
    throw error;
  }
};

export const startSignalHarvester = async (
  config: HarvesterConfig,
  db: DatabaseManager
): Promise<() => Promise<void>> => {
  logger.info('Starting signal harvester', { name: config.name, channel: config.channel });
  
  // Read API ID: Priority: envVarNames.apiId > config.apiId > TG_API_ID env var
  const apiIdEnvVarName = config.envVarNames?.apiId;
  const apiId = apiIdEnvVarName 
    ? parseInt(process.env[apiIdEnvVarName] || '', 10)
    : (config.apiId || parseInt(process.env.TG_API_ID || '', 10));
  const apiHash = process.env.TG_API_HASH;
  const sessionString = process.env.TG_SESSION || '';
  
  if (!apiId) {
    const source = apiIdEnvVarName 
      ? `environment variable ${apiIdEnvVarName}`
      : (config.apiId ? 'config.apiId' : 'TG_API_ID environment variable');
    throw new Error(`${source} is required for Telegram but was not found or invalid`);
  }
  if (!apiHash) {
    throw new Error('TG_API_HASH environment variable is required');
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

  // Initialize lastMessageId from database to avoid reprocessing existing messages on startup
  const existingMessages = await db.getMessagesByChannel(config.channel);
  
  if (existingMessages.length > 0) {
    const maxMessageId = Math.max(...existingMessages.map(m => m.message_id));
    lastMessageId = maxMessageId;
    logger.info('Initialized lastMessageId from database', {
      channel: config.channel,
      lastMessageId,
      existingMessageCount: existingMessages.length
    });
  }
  
  // Log that we'll skip old messages (prevents processing stale messages after pause/restart or in subsequent polls)
  const skipOldMessages = config.skipOldMessagesOnStartup !== false;
  if (skipOldMessages) {
    logger.info('Will skip old messages (exceeding maxMessageAgeMinutes) on all fetches', {
      channel: config.channel,
      maxMessageAgeMinutes: config.maxMessageAgeMinutes ?? 10
    });
  }

  // Set up event handler for message edits
  client.addEventHandler(async (update: any) => {
    if (update instanceof Api.UpdateEditMessage) {
      try {
        // UpdateEditMessage has a 'message' property, not 'messageId'
        const message = update.message;
        if (!message || !('id' in message)) return;
        
        // Handle BigInt message IDs properly
        const messageIdBigInt = typeof message.id === 'bigint' ? message.id : BigInt(message.id);
        const messageId = Number(messageIdBigInt);
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

  // Track if this is the first fetch after startup
  // This ensures we skip old messages even if the bot was paused and restarted
  let isFirstFetch = true;

  const harvestLoop = async (): Promise<void> => {
    while (running) {
      try {
        if (entity) {
          const isFirstFetchAfterStartup = isFirstFetch;
          lastMessageId = await fetchNewMessages(config, client, entity, db, lastMessageId, isFirstFetchAfterStartup);
          isFirstFetch = false;
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
