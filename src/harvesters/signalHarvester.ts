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

/**
 * Client manager to share TelegramClient instances across harvesters using the same session
 * This prevents AUTH_KEY_DUPLICATED errors when multiple harvesters use the same Telegram account
 * 
 * Uses functional programming with module-level state instead of a class
 */

// Module-level state for client management
const clients = new Map<string, TelegramClient>();
const clientRefCounts = new Map<string, number>();
const clientConnections = new Map<string, Promise<void>>();

/**
 * Create a unique session key based on session string, API ID, and hash
 * This ensures clients are shared only when all three match
 */
const getSessionKey = (sessionString: string, apiId: number, apiHash: string): string => {
  return `${apiId}:${apiHash}:${sessionString.substring(0, 32)}`;
};

/**
 * Get or create a TelegramClient for a given session string
 * If a client already exists for this session, it will be reused
 */
const getOrCreateClient = async (
  sessionString: string,
  apiId: number,
  apiHash: string,
  clientOptions: {
    deviceModel?: string;
    appVersion?: string;
    systemVersion?: string;
    systemLangCode?: string;
  }
): Promise<TelegramClient> => {
  const sessionKey = getSessionKey(sessionString, apiId, apiHash);

  // If client exists, increment ref count and return it
  if (clients.has(sessionKey)) {
    const refCount = clientRefCounts.get(sessionKey) || 0;
    clientRefCounts.set(sessionKey, refCount + 1);
    logger.debug('Reusing existing TelegramClient', {
      sessionKey: sessionKey.substring(0, 16) + '...',
      refCount: refCount + 1
    });
    return clients.get(sessionKey)!;
  }

  // Create new client
  const freshSessionString = String(sessionString);
  const session = new StringSession(freshSessionString);
  
  const client = new TelegramClient(
    session,
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      deviceModel: clientOptions.deviceModel || 'Tigger-Harvester',
      appVersion: clientOptions.appVersion || '1.0.0',
      systemVersion: clientOptions.systemVersion || '1.0.0',
      systemLangCode: clientOptions.systemLangCode || 'EN',
    }
  );

  // Store client and initialize ref count
  clients.set(sessionKey, client);
  clientRefCounts.set(sessionKey, 1);

  // Ensure connection happens only once, even if multiple harvesters request it simultaneously
  if (!clientConnections.has(sessionKey)) {
    const connectionPromise = client.connect()
      .then(async () => {
        const me = await client.getMe();
        logger.info('Created and connected new shared TelegramClient', {
          sessionKey: sessionKey.substring(0, 16) + '...',
          userId: String(me.id),
          username: me.username || null,
          phone: me.phone || null
        });
      })
      .catch(async (error) => {
        // If connection fails, remove the client from the map so it can be retried
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Failed to connect shared TelegramClient, removing from cache', {
          sessionKey: sessionKey.substring(0, 16) + '...',
          error: errorMessage
        });
        
        // Clean up failed client
        clients.delete(sessionKey);
        clientRefCounts.delete(sessionKey);
        clientConnections.delete(sessionKey);
        
        // Disconnect the failed client
        try {
          await client.disconnect();
        } catch (disconnectError) {
          // Ignore disconnect errors
        }
        
        throw error;
      });
    clientConnections.set(sessionKey, connectionPromise);
  }

  // Wait for connection to complete
  try {
    await clientConnections.get(sessionKey);
  } catch (error) {
    // Connection failed, remove from cache and rethrow
    clients.delete(sessionKey);
    clientRefCounts.delete(sessionKey);
    clientConnections.delete(sessionKey);
    throw error;
  }

  // Verify client is actually connected before returning
  if (!client.connected) {
    logger.warn('Client not connected after connection promise resolved, attempting reconnect', {
      sessionKey: sessionKey.substring(0, 16) + '...'
    });
    try {
      await client.connect();
    } catch (reconnectError) {
      // Clean up and rethrow
      clients.delete(sessionKey);
      clientRefCounts.delete(sessionKey);
      clientConnections.delete(sessionKey);
      throw reconnectError;
    }
  }

  return client;
};

/**
 * Release a reference to a client
 * When ref count reaches 0, the client will be disconnected
 */
const releaseClient = async (
  sessionString: string,
  apiId: number,
  apiHash: string
): Promise<void> => {
  const sessionKey = getSessionKey(sessionString, apiId, apiHash);
  
  if (!clients.has(sessionKey)) {
    return;
  }

  const refCount = clientRefCounts.get(sessionKey) || 0;
  if (refCount <= 1) {
    // Last reference, disconnect and remove
    const client = clients.get(sessionKey)!;
    await client.disconnect();
    clients.delete(sessionKey);
    clientRefCounts.delete(sessionKey);
    clientConnections.delete(sessionKey);
    logger.debug('Disconnected and removed TelegramClient', {
      sessionKey: sessionKey.substring(0, 16) + '...'
    });
  } else {
    // Decrement ref count
    clientRefCounts.set(sessionKey, refCount - 1);
    logger.debug('Released reference to TelegramClient', {
      sessionKey: sessionKey.substring(0, 16) + '...',
      remainingRefs: refCount - 1
    });
  }
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

const connectTelegram = async (
  config: HarvesterConfig,
  client: TelegramClient,
  sessionString: string
): Promise<void> => {
  try {
    if (!sessionString) {
      const sessionEnvVarName = config.envVarNames?.session || 'TG_SESSION';
      throw new Error(`${sessionEnvVarName} environment variable is required`);
    }
    await client.connect();
    const me = await client.getMe();
    
    // Log account information to help diagnose if sessions are from the same account
    logger.info('Connected to Telegram', {
      harvester: config.name,
      channel: config.channel,
      userId: String(me.id),
      username: me.username || null,
      firstName: me.firstName || null,
      phone: me.phone || null
    });
    
    // Warn if we detect potential duplicate account usage
    // (This is just a warning - the actual error will come from Telegram)
    logger.debug('Telegram account details', {
      harvester: config.name,
      accountId: String(me.id),
      accountPhone: me.phone || 'unknown'
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Provide more helpful error message for AUTH_KEY_DUPLICATED
    if (errorMessage.includes('AUTH_KEY_DUPLICATED')) {
      logger.error('AUTH_KEY_DUPLICATED error - This usually means:', {
        harvester: config.name,
        channel: config.channel,
        possibleCauses: [
          'Another instance is using the same session',
          'Both sessions are from the same Telegram account (need different accounts)',
          'Session is being used elsewhere (local machine, another cloud instance)'
        ],
        suggestion: 'Ensure each harvester uses a session from a DIFFERENT Telegram account, not just different sessions from the same account'
      });
    }
    
    logger.error('Failed to connect to Telegram', {
      harvester: config.name,
      channel: config.channel,
      error: errorMessage
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
      limit: 5,
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
  
  // Read Session: Priority: envVarNames.session > TG_SESSION env var
  // If envVarNames.session is not specified, default to TG_SESSION
  const sessionEnvVarName = config.envVarNames?.session;
  const sessionString = sessionEnvVarName
    ? (process.env[sessionEnvVarName] || process.env.TG_SESSION || '')
    : (process.env.TG_SESSION || '');
  
  // Log which session environment variable is being used (without logging the actual session string)
  // Create a fingerprint of the session (first 8 and last 8 chars) for verification
  const sessionFingerprint = sessionString.length > 16 
    ? `${sessionString.substring(0, 8)}...${sessionString.substring(sessionString.length - 8)}`
    : '***';
  
  if (sessionEnvVarName) {
    if (!process.env[sessionEnvVarName] && !process.env.TG_SESSION) {
      logger.warn('Harvester-specific session env var not found and TG_SESSION not available', {
        harvester: config.name,
        channel: config.channel,
        sessionEnvVarName
      });
    } else if (!process.env[sessionEnvVarName]) {
      logger.info('Harvester-specific session env var not found, falling back to TG_SESSION', {
        harvester: config.name,
        channel: config.channel,
        sessionEnvVarName
      });
    } else {
      logger.info('Using harvester-specific session', {
        harvester: config.name,
        channel: config.channel,
        sessionEnvVarName,
        sessionFingerprint
      });
    }
  } else {
    logger.info('Using default TG_SESSION (shared across harvesters)', {
      harvester: config.name,
      channel: config.channel,
      sessionFingerprint
    });
  }
  
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
    const source = sessionEnvVarName
      ? `environment variable ${sessionEnvVarName}`
      : 'TG_SESSION environment variable';
    throw new Error(`${source} is required for Telegram but was not found`);
  }
  
  // Use shared client manager to avoid AUTH_KEY_DUPLICATED errors
  // Harvesters using the same session will share the same TelegramClient instance
  const client = await getOrCreateClient(
    sessionString,
    apiId,
    apiHash,
    {
      deviceModel: `Tigger-Harvester-${config.name}`,
      appVersion: '1.0.0',
      systemVersion: '1.0.0',
      systemLangCode: config.name.substring(0, 2).toUpperCase() || 'EN',
    }
  );
  
  logger.debug('Using shared TelegramClient', {
    harvester: config.name,
    channel: config.channel,
    sessionLength: sessionString.length,
    sessionFingerprint
  });

  let running = true;
  let lastMessageId = 0;
  let entity: Api.TypeInputPeer | undefined;

  // Client should already be connected by the manager
  // Verify connection and handle any connection errors
  if (!client.connected) {
    logger.warn('Shared client not connected, attempting to connect', {
      harvester: config.name,
      channel: config.channel
    });
    try {
      await client.connect();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Provide helpful error message for AUTH_KEY_DUPLICATED
      if (errorMessage.includes('AUTH_KEY_DUPLICATED')) {
        logger.error('AUTH_KEY_DUPLICATED: Another instance is using this session', {
          harvester: config.name,
          channel: config.channel,
          possibleCauses: [
            'Another deployment/instance is running with the same TG_SESSION',
            'A local instance is running with the same session',
            'A previous deployment did not shut down properly'
          ],
          solution: 'Stop all other instances using this session, or use a different session'
        });
      }
      
      logger.error('Failed to connect shared client', {
        harvester: config.name,
        channel: config.channel,
        error: errorMessage
      });
      
      // Release the client reference since it failed
      await releaseClient(sessionString, apiId, apiHash);
      throw error;
    }
  }
  
  // Get account info for logging (client is already connected)
  try {
    const me = await client.getMe();
    logger.info('Using shared TelegramClient', {
      harvester: config.name,
      channel: config.channel,
      userId: String(me.id),
      username: me.username || null
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn('Could not get account info, client may not be properly connected', {
      harvester: config.name,
      error: errorMessage
    });
    
    // If we can't get account info and client is not connected, try to reconnect
    if (!client.connected) {
      try {
        await client.connect();
      } catch (reconnectError) {
        const reconnectErrorMsg = reconnectError instanceof Error ? reconnectError.message : String(reconnectError);
        logger.error('Failed to reconnect client', {
          harvester: config.name,
          error: reconnectErrorMsg
        });
        await releaseClient(sessionString, apiId, apiHash);
        throw reconnectError;
      }
    }
  }
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
    logger.info('Stopping signal harvester', { 
      harvester: config.name,
      channel: config.channel 
    });
    running = false;
    // Release the client reference instead of disconnecting directly
    // The client manager will disconnect only when all harvesters using it have stopped
    await releaseClient(sessionString, apiId, apiHash);
  };
};
