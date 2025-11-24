import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { HarvesterConfig } from '../types/config.js';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';

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

      try {
        db.insertMessage({
          message_id: msgId,
          channel: config.channel,
          content: String(msg.message).replace(/\s+/g, ' ').trim(),
          sender: String((msg as any).fromId?.userId || (msg as any).senderId?.userId || ''),
          date: msgDate.toISOString()
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
