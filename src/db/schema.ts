import Database from 'better-sqlite3';
import { Pool, Client } from 'pg';
import dns from 'dns';
import { logger } from '../utils/logger.js';

// Force Node.js to prefer IPv4 for DNS resolution
// Critical for DigitalOcean App Platform which doesn't support IPv6 connections
dns.setDefaultResultOrder('ipv4first');

export interface Message {
  id: number;
  message_id: string; // Message ID from source (Discord snowflake, Telegram ID, GUID, etc.)
  channel: string;
  content: string;
  sender: string;
  date: string;
  created_at: string;
  parsed: boolean;
  analyzed?: boolean; // Whether message has been analyzed for format identification
  reply_to_message_id?: string; // Message ID this message is replying to (if any)
  old_content?: string; // Previous content if message was edited (deprecated - use message_versions table)
  edited_at?: string; // Timestamp when message was last edited (deprecated - use message_versions table)
  image_paths?: string; // JSON array of image file paths (relative to data directory)
}

export interface MessageVersion {
  id: number;
  message_id: number; // Foreign key to messages.id (internal ID, not Telegram message_id)
  channel: string;
  content: string;
  version_number: number; // 0 = original, 1 = first edit, etc.
  created_at: string; // When this version was created
}

export interface Trade {
  id: number;
  message_id: string; // Source message ID that triggered this trade
  channel: string;
  trading_pair: string;
  leverage: number;
  entry_price: number;
  stop_loss: number;
  take_profits: string; // JSON array of numbers
  risk_percentage: number;
  quantity?: number; // Calculated position quantity based on risk percentage
  exchange: string;
  account_name?: string; // Account name that executed this trade (from accounts config)
  order_id?: string;
  position_id?: string; // Bybit position ID after entry is filled
  entry_order_type?: 'market' | 'limit'; // Type of entry order (market or limit)
  direction?: 'long' | 'short'; // Trade direction: long or short
  status: 'pending' | 'active' | 'filled' | 'cancelled' | 'stopped' | 'completed' | 'closed';
  entry_filled_at?: string;
  exit_price?: number;
  exit_filled_at?: string;
  pnl?: number; // Profit/Loss in USDT
  pnl_percentage?: number; // Profit/Loss as percentage
  stop_loss_breakeven: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface TradeWithMessage extends Trade {
  source_message: Message; // The message that triggered this trade
  reply_chain?: Message[]; // Chain of messages if source message is a reply
}

export interface Order {
  id: number;
  trade_id: number; // Foreign key to trades.id
  order_type: 'entry' | 'stop_loss' | 'take_profit' | 'breakeven_limit';
  order_id?: string; // Exchange order ID
  price: number; // Order price (entry price, SL price, or TP price)
  tp_index?: number; // Index in take_profits array (0-based, only for TP orders)
  quantity?: number; // Order quantity (for entry and TP orders)
  status: 'pending' | 'filled' | 'cancelled';
  filled_at?: string; // When the order was filled
  filled_price?: number; // Actual fill price
  created_at: string;
  updated_at: string;
}

export interface EvaluationResultRecord {
  id: number;
  channel: string;
  prop_firm_name: string;
  passed: boolean;
  violations: string; // JSON array of violations
  metrics: string; // JSON object of metrics
  start_date: string;
  end_date: string;
  created_at: string;
}

export interface SignalFormatRecord {
  id: number;
  channel: string;
  format_pattern: string; // Example message content
  format_hash: string; // Hash of the format for deduplication
  classification: 'signal' | 'management';
  example_count: number; // Number of messages with this format
  first_seen: string;
  last_seen: string;
  extracted_fields?: string; // JSON object with extracted fields if available
  created_at: string;
}

type DatabaseType = 'sqlite' | 'postgresql';

interface DatabaseAdapter {
  initializeSchema(): Promise<void>;
  insertMessage(message: Omit<Message, 'id' | 'created_at' | 'parsed' | 'analyzed'>): Promise<number>;
  getUnparsedMessages(channel?: string, maxStalenessMinutes?: number): Promise<Message[]>;
  getEditedMessages(channel?: string, maxStalenessMinutes?: number): Promise<Message[]>;
  getUnanalyzedMessages(channel?: string): Promise<Message[]>;
  getMessagesByChannel(channel: string, limit?: number): Promise<Message[]>;
  markMessageParsed(id: number): Promise<void>;
  markMessageAnalyzed(id: number): Promise<void>;
  updateMessage(messageId: string, channel: string, updates: Partial<Message>): Promise<void>;
  insertMessageVersion(messageId: string, channel: string, content: string): Promise<number>;
  getMessageVersions(messageId: string, channel: string): Promise<MessageVersion[]>;
  getMessageByMessageId(messageId: string, channel: string): Promise<Message | null>;
  getMessagesByReplyTo(replyToMessageId: string, channel: string): Promise<Message[]>;
  getMessageReplyChain(messageId: string, channel: string): Promise<Message[]>;
  insertTrade(trade: Omit<Trade, 'id' | 'created_at' | 'updated_at'> & { created_at?: string }): Promise<number>;
  getActiveTrades(): Promise<Trade[]>;
  getClosedTrades(): Promise<Trade[]>;
  getTradesByStatus(status: Trade['status']): Promise<Trade[]>;
  getTradesByMessageId(messageId: string, channel: string): Promise<Trade[]>;
  getTradeWithMessage(tradeId: number): Promise<TradeWithMessage | null>;
  getTradesWithMessages(status?: Trade['status']): Promise<TradeWithMessage[]>;
  updateTrade(id: number, updates: Partial<Trade>): Promise<void>;
  insertEvaluationResult(result: Omit<EvaluationResultRecord, 'id' | 'created_at'>): Promise<number>;
  getEvaluationResults(channel?: string, propFirmName?: string): Promise<EvaluationResultRecord[]>;
  insertSignalFormat(format: Omit<SignalFormatRecord, 'id' | 'created_at'>): Promise<number>;
  getSignalFormats(channel?: string, formatHash?: string): Promise<SignalFormatRecord[]>;
  updateSignalFormat(id: number, updates: Partial<SignalFormatRecord>): Promise<void>;
  insertOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<number>;
  getOrdersByTradeId(tradeId: number): Promise<Order[]>;
  getOrdersByStatus(status: Order['status']): Promise<Order[]>;
  updateOrder(id: number, updates: Partial<Order>): Promise<void>;
  close(): Promise<void>;
}

class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  async initializeSchema(): Promise<void> {
    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        content TEXT NOT NULL,
        sender TEXT,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        parsed BOOLEAN NOT NULL DEFAULT 0,
        analyzed BOOLEAN NOT NULL DEFAULT 0,
        reply_to_message_id TEXT,
        old_content TEXT,
        edited_at TEXT,
        UNIQUE(message_id, channel)
      )
    `);
    
    // Migrate message_id and reply_to_message_id from INTEGER to TEXT if needed (SQLite)
    try {
      // Check if table exists and has INTEGER columns
      const tableInfo = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{name: string, type: string}>;
      const messageIdCol = tableInfo.find(col => col.name === 'message_id');
      const replyToCol = tableInfo.find(col => col.name === 'reply_to_message_id');
      
      if (messageIdCol && messageIdCol.type.toUpperCase().includes('INTEGER')) {
        // Need to migrate - SQLite doesn't support ALTER COLUMN, so recreate table
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS messages_migrate (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            content TEXT NOT NULL,
            sender TEXT,
            date TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            parsed BOOLEAN NOT NULL DEFAULT 0,
            analyzed BOOLEAN NOT NULL DEFAULT 0,
            reply_to_message_id TEXT,
            old_content TEXT,
            edited_at TEXT,
            image_paths TEXT
          )
        `);
        this.db.exec(`
          INSERT INTO messages_migrate 
          SELECT id, CAST(message_id AS TEXT), channel, content, sender, date, created_at, parsed, 
                 COALESCE(analyzed, 0), CAST(reply_to_message_id AS TEXT), old_content, edited_at, image_paths
          FROM messages
        `);
        this.db.exec(`DROP TABLE messages`);
        this.db.exec(`ALTER TABLE messages_migrate RENAME TO messages`);
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_channel ON messages(message_id, channel)`);
        logger.info('Migrated SQLite messages table: message_id and reply_to_message_id to TEXT');
      }
    } catch (migrateError: any) {
      // Migration failed, but table might already be TEXT - continue
      logger.warn('Failed to migrate SQLite message_id to TEXT', {
        error: migrateError instanceof Error ? migrateError.message : String(migrateError)
      });
    }
    
    // Add analyzed column if it doesn't exist (for backward compatibility)
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN analyzed BOOLEAN NOT NULL DEFAULT 0`);
    } catch (error) {
      // Column already exists, ignore error
    }
    
    // Message versions table - stores full edit history
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        content TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
        UNIQUE(message_id, version_number)
      )
    `);
    
    // Add reply_to_message_id column if it doesn't exist (migration)
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    } catch (error) {
      // Column already exists, ignore
    }
    
    // Add old_content and edited_at columns if they don't exist (migration)
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN old_content TEXT`);
    } catch (error) {
      // Column already exists, ignore
    }
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN edited_at TEXT`);
    } catch (error) {
      // Column already exists, ignore
    }
    
    // Add image_paths column if it doesn't exist (migration)
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN image_paths TEXT`);
    } catch (error) {
      // Column already exists, ignore
    }

    // Trades table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        trading_pair TEXT NOT NULL,
        leverage REAL NOT NULL,
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profits TEXT NOT NULL,
        risk_percentage REAL NOT NULL,
        quantity REAL,
        exchange TEXT NOT NULL,
        account_name TEXT,
        order_id TEXT,
        position_id TEXT,
        entry_order_type TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        entry_filled_at TEXT,
        exit_price REAL,
        exit_filled_at TEXT,
        pnl REAL,
        pnl_percentage REAL,
        stop_loss_breakeven BOOLEAN NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL
      )
    `);
    
    // Migrate trades.message_id from INTEGER to TEXT if needed (SQLite)
    try {
      const test = this.db.prepare('SELECT message_id FROM trades LIMIT 1').get();
      // If we got here, table exists - try to migrate
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS trades_migrate (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          trading_pair TEXT NOT NULL,
          leverage REAL NOT NULL,
          entry_price REAL NOT NULL,
          stop_loss REAL NOT NULL,
          take_profits TEXT NOT NULL,
          risk_percentage REAL NOT NULL,
          quantity REAL,
          exchange TEXT NOT NULL,
          account_name TEXT,
          order_id TEXT,
          position_id TEXT,
          entry_order_type TEXT,
          direction TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          entry_filled_at TEXT,
          exit_price REAL,
          exit_filled_at TEXT,
          pnl REAL,
          pnl_percentage REAL,
          stop_loss_breakeven BOOLEAN NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TEXT NOT NULL
        )
      `);
      this.db.exec(`
        INSERT INTO trades_migrate 
        SELECT id, CAST(message_id AS TEXT), channel, trading_pair, leverage, entry_price, stop_loss, take_profits,
               risk_percentage, quantity, exchange, account_name, order_id, position_id, entry_order_type, direction,
               status, entry_filled_at, exit_price, exit_filled_at, pnl, pnl_percentage, stop_loss_breakeven,
               created_at, updated_at, expires_at
        FROM trades
      `);
      this.db.exec(`DROP TABLE trades`);
      this.db.exec(`ALTER TABLE trades_migrate RENAME TO trades`);
    } catch (migrateError: any) {
      // Migration failed, but table might already be TEXT - continue
      logger.warn('Failed to migrate SQLite trades.message_id to TEXT', {
        error: migrateError instanceof Error ? migrateError.message : String(migrateError)
      });
    }

    // Add account_name column if it doesn't exist (migration)
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN account_name TEXT`);
    } catch (error) {
      // Column already exists, ignore
    }

    // Add quantity column if it doesn't exist (migration)
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN quantity REAL`);
    } catch (error) {
      // Column already exists, ignore
    }

    // Add entry_order_type column if it doesn't exist (migration)
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN entry_order_type TEXT`);
    } catch (error) {
      // Column already exists, ignore
    }

    // Add direction column if it doesn't exist (migration)
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN direction TEXT`);
    } catch (error) {
      // Column already exists, ignore
    }

    // Migrate leverage from INTEGER to REAL if needed (SQLite)
    // SQLite doesn't support ALTER COLUMN, so we need to check and migrate if needed
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(trades)").all() as Array<{name: string, type: string}>;
      const leverageCol = tableInfo.find(col => col.name === 'leverage');
      
      if (leverageCol && leverageCol.type.toUpperCase().includes('INTEGER')) {
        // Need to migrate leverage from INTEGER to REAL
        logger.info('Migrating SQLite trades.leverage from INTEGER to REAL');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS trades_leverage_migrate (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            trading_pair TEXT NOT NULL,
            leverage REAL NOT NULL,
            entry_price REAL NOT NULL,
            stop_loss REAL NOT NULL,
            take_profits TEXT NOT NULL,
            risk_percentage REAL NOT NULL,
            quantity REAL,
            exchange TEXT NOT NULL,
            account_name TEXT,
            order_id TEXT,
            position_id TEXT,
            entry_order_type TEXT,
            direction TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            entry_filled_at TEXT,
            exit_price REAL,
            exit_filled_at TEXT,
            pnl REAL,
            pnl_percentage REAL,
            stop_loss_breakeven BOOLEAN NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL
          )
        `);
        this.db.exec(`
          INSERT INTO trades_leverage_migrate 
          SELECT id, message_id, channel, trading_pair, CAST(leverage AS REAL), entry_price, stop_loss, take_profits,
                 risk_percentage, quantity, exchange, account_name, order_id, position_id, entry_order_type, direction,
                 status, entry_filled_at, exit_price, exit_filled_at, pnl, pnl_percentage, stop_loss_breakeven,
                 created_at, updated_at, expires_at
          FROM trades
        `);
        this.db.exec(`DROP TABLE trades`);
        this.db.exec(`ALTER TABLE trades_leverage_migrate RENAME TO trades`);
        logger.info('Successfully migrated SQLite trades.leverage to REAL');
      }
    } catch (migrateError: any) {
      logger.warn('Failed to migrate SQLite trades.leverage to REAL', {
        error: migrateError instanceof Error ? migrateError.message : String(migrateError)
      });
    }

    // Orders table - tracks SL/TP orders for trades
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id INTEGER NOT NULL,
        order_type TEXT NOT NULL,
        order_id TEXT,
        price REAL NOT NULL,
        tp_index INTEGER,
        quantity REAL,
        status TEXT NOT NULL DEFAULT 'pending',
        filled_at TEXT,
        filled_price REAL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE
      )
    `);

    // Evaluation results table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        prop_firm_name TEXT NOT NULL,
        passed BOOLEAN NOT NULL,
        violations TEXT NOT NULL,
        metrics TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Signal formats table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signal_formats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        format_pattern TEXT NOT NULL,
        format_hash TEXT NOT NULL,
        classification TEXT NOT NULL,
        example_count INTEGER NOT NULL DEFAULT 1,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        extracted_fields TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(channel, format_hash)
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_parsed ON messages(channel, parsed);
      CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id, channel);
      CREATE INDEX IF NOT EXISTS idx_message_versions_message_id ON message_versions(message_id, channel);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_channel ON trades(channel);
      CREATE INDEX IF NOT EXISTS idx_trades_message_id ON trades(message_id, channel);
      CREATE INDEX IF NOT EXISTS idx_orders_trade_id ON orders(trade_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
      CREATE INDEX IF NOT EXISTS idx_evaluation_results_channel ON evaluation_results(channel);
      CREATE INDEX IF NOT EXISTS idx_evaluation_results_prop_firm ON evaluation_results(prop_firm_name);
      CREATE INDEX IF NOT EXISTS idx_signal_formats_channel ON signal_formats(channel);
      CREATE INDEX IF NOT EXISTS idx_signal_formats_hash ON signal_formats(format_hash);
      CREATE INDEX IF NOT EXISTS idx_signal_formats_classification ON signal_formats(classification);
    `);
  }

  async insertMessage(message: Omit<Message, 'id' | 'created_at' | 'parsed' | 'analyzed'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO messages (message_id, channel, content, sender, date, created_at, parsed, analyzed, reply_to_message_id, image_paths)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0, 0, ?, ?)
    `);
    const result = stmt.run(
      message.message_id,
      message.channel,
      message.content,
      message.sender || null,
      message.date,
      message.reply_to_message_id || null,
      message.image_paths || null
    );
    return result.lastInsertRowid as number;
  }

  async getUnparsedMessages(channel?: string, maxStalenessMinutes?: number): Promise<Message[]> {
    let query: string;
    let params: any[];

    if (maxStalenessMinutes !== undefined && maxStalenessMinutes > 0) {
      // Calculate cutoff timestamp (current time minus staleness minutes)
      const cutoffTime = new Date(Date.now() - maxStalenessMinutes * 60 * 1000).toISOString();
      
      if (channel) {
        query = 'SELECT * FROM messages WHERE parsed = 0 AND channel = ? AND date >= ? ORDER BY id ASC';
        params = [channel, cutoffTime];
      } else {
        query = 'SELECT * FROM messages WHERE parsed = 0 AND date >= ? ORDER BY id ASC';
        params = [cutoffTime];
      }
    } else {
      // No staleness filter
      if (channel) {
        query = 'SELECT * FROM messages WHERE parsed = 0 AND channel = ? ORDER BY id ASC';
        params = [channel];
      } else {
        query = 'SELECT * FROM messages WHERE parsed = 0 ORDER BY id ASC';
        params = [];
      }
    }

    const stmt = this.db.prepare(query);
    return (params.length > 0 ? stmt.all(...params) : stmt.all()) as Message[];
  }

  async getEditedMessages(channel?: string, maxStalenessMinutes?: number): Promise<Message[]> {
    let query: string;
    let params: any[];

    if (maxStalenessMinutes !== undefined && maxStalenessMinutes > 0) {
      // Calculate cutoff timestamp (current time minus staleness minutes)
      const cutoffTime = new Date(Date.now() - maxStalenessMinutes * 60 * 1000).toISOString();
      
      if (channel) {
        query = 'SELECT * FROM messages WHERE old_content IS NOT NULL AND channel = ? AND date >= ? ORDER BY id ASC';
        params = [channel, cutoffTime];
      } else {
        query = 'SELECT * FROM messages WHERE old_content IS NOT NULL AND date >= ? ORDER BY id ASC';
        params = [cutoffTime];
      }
    } else {
      // No staleness filter
      if (channel) {
        query = 'SELECT * FROM messages WHERE old_content IS NOT NULL AND channel = ? ORDER BY id ASC';
        params = [channel];
      } else {
        query = 'SELECT * FROM messages WHERE old_content IS NOT NULL ORDER BY id ASC';
        params = [];
      }
    }

    const stmt = this.db.prepare(query);
    return (params.length > 0 ? stmt.all(...params) : stmt.all()) as Message[];
  }

  async getUnanalyzedMessages(channel?: string): Promise<Message[]> {
    const stmt = channel
      ? this.db.prepare('SELECT * FROM messages WHERE (analyzed IS NULL OR analyzed = 0) AND channel = ? ORDER BY id ASC')
      : this.db.prepare('SELECT * FROM messages WHERE analyzed IS NULL OR analyzed = 0 ORDER BY id ASC');
    return (channel ? stmt.all(channel) : stmt.all()) as Message[];
  }

  async getMessagesByChannel(channel: string, limit?: number): Promise<Message[]> {
    const stmt = limit && limit > 0
      ? this.db.prepare('SELECT * FROM messages WHERE channel = ? ORDER BY id ASC LIMIT ?')
      : this.db.prepare('SELECT * FROM messages WHERE channel = ? ORDER BY id ASC');
    return (limit && limit > 0 ? stmt.all(channel, limit) : stmt.all(channel)) as Message[];
  }

  async markMessageParsed(id: number): Promise<void> {
    const stmt = this.db.prepare('UPDATE messages SET parsed = 1 WHERE id = ?');
    stmt.run(id);
  }

  async markMessageAnalyzed(id: number): Promise<void> {
    const stmt = this.db.prepare('UPDATE messages SET analyzed = 1 WHERE id = ?');
    stmt.run(id);
  }

  async updateMessage(messageId: string, channel: string, updates: Partial<Message>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.content !== undefined) {
      fields.push('content = ?');
      values.push(updates.content);
    }
    if (updates.old_content !== undefined) {
      fields.push('old_content = ?');
      values.push(updates.old_content);
    }
    if (updates.edited_at !== undefined) {
      fields.push('edited_at = ?');
      values.push(updates.edited_at);
    }
    if (updates.parsed !== undefined) {
      fields.push('parsed = ?');
      values.push(updates.parsed ? 1 : 0);
    }

    if (fields.length === 0) {
      return; // No updates to apply
    }

    values.push(messageId, channel);
    const stmt = this.db.prepare(
      `UPDATE messages SET ${fields.join(', ')} WHERE message_id = ? AND channel = ?`
    );
    stmt.run(...values);
  }

  async insertMessageVersion(messageId: string, channel: string, content: string): Promise<number> {
    // Get the internal message ID from Telegram message_id
    const message = await this.getMessageByMessageId(messageId, channel);
    if (!message) {
      throw new Error(`Message not found: message_id=${messageId}, channel=${channel}`);
    }

    // Get the current highest version number for this message
    const versionStmt = this.db.prepare(
      'SELECT MAX(version_number) as max_version FROM message_versions WHERE message_id = ?'
    );
    const versionResult = versionStmt.get(message.id) as { max_version: number | null } | undefined;
    const nextVersion = (versionResult?.max_version ?? -1) + 1;

    // Insert the new version
    const stmt = this.db.prepare(`
      INSERT INTO message_versions (message_id, channel, content, version_number, created_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(message.id, channel, content, nextVersion);
    return result.lastInsertRowid as number;
  }

  async getMessageVersions(messageId: string, channel: string): Promise<MessageVersion[]> {
    // Get the internal message ID from Telegram message_id
    const message = await this.getMessageByMessageId(messageId, channel);
    if (!message) {
      return [];
    }

    const stmt = this.db.prepare(`
      SELECT mv.*, m.message_id as telegram_message_id
      FROM message_versions mv
      JOIN messages m ON mv.message_id = m.id
      WHERE mv.message_id = ? AND mv.channel = ?
      ORDER BY mv.version_number ASC
    `);
    const rows = stmt.all(message.id, channel) as any[];
    
    return rows.map(row => ({
      id: row.id,
      message_id: row.message_id,
      channel: row.channel,
      content: row.content,
      version_number: row.version_number,
      created_at: row.created_at
    })) as MessageVersion[];
  }

  async insertTrade(trade: Omit<Trade, 'id' | 'created_at' | 'updated_at'> & { created_at?: string }): Promise<number> {
    const created_at = trade.created_at;
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        message_id, channel, trading_pair, leverage, entry_price, stop_loss,
        take_profits, risk_percentage, quantity, exchange, account_name, order_id, position_id, entry_order_type, direction, status,
        entry_filled_at, exit_price, exit_filled_at, pnl, pnl_percentage,
        stop_loss_breakeven, expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${created_at ? '?' : 'CURRENT_TIMESTAMP'}, CURRENT_TIMESTAMP)
    `);
    const params = [
      trade.message_id,
      trade.channel,
      trade.trading_pair,
      trade.leverage,
      trade.entry_price,
      trade.stop_loss,
      trade.take_profits,
      trade.risk_percentage,
      trade.quantity || null,
      trade.exchange,
      trade.account_name || null,
      trade.order_id || null,
      trade.position_id || null,
      trade.entry_order_type || null,
      trade.direction || null,
      trade.status,
      trade.entry_filled_at || null,
      trade.exit_price || null,
      trade.exit_filled_at || null,
      trade.pnl || null,
      trade.pnl_percentage || null,
      trade.stop_loss_breakeven ? 1 : 0,
      trade.expires_at
    ];
    if (created_at) {
      params.push(created_at);
    }
    const result = stmt.run(...params);
    return result.lastInsertRowid as number;
  }

  async getActiveTrades(): Promise<Trade[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      WHERE status IN ('pending', 'active', 'filled')
      ORDER BY created_at ASC
    `);
    return stmt.all() as Trade[];
  }

  async getClosedTrades(): Promise<Trade[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      WHERE status IN ('closed', 'stopped', 'cancelled', 'completed')
      ORDER BY exit_filled_at DESC
    `);
    return stmt.all() as Trade[];
  }

  async getTradesByStatus(status: Trade['status']): Promise<Trade[]> {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY created_at ASC');
    return stmt.all(status) as Trade[];
  }

  async getTradesByMessageId(messageId: string, channel: string): Promise<Trade[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM trades WHERE message_id = ? AND channel = ? ORDER BY created_at ASC'
    );
    return stmt.all(messageId, channel) as Trade[];
  }

  async getMessageByMessageId(messageId: string, channel: string): Promise<Message | null> {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE message_id = ? AND channel = ?');
    const result = stmt.get(messageId, channel) as Message | undefined;
    return result || null;
  }

  async getMessagesByReplyTo(replyToMessageId: string, channel: string): Promise<Message[]> {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE reply_to_message_id = ? AND channel = ? ORDER BY date ASC');
    return stmt.all(replyToMessageId, channel) as Message[];
  }

  async getMessageReplyChain(messageId: string, channel: string): Promise<Message[]> {
    const chain: Message[] = [];
    let currentMessageId: string | null = messageId;
    const visited = new Set<string>();

    while (currentMessageId && !visited.has(currentMessageId)) {
      visited.add(currentMessageId);
      const message = await this.getMessageByMessageId(currentMessageId, channel);
      if (!message) break;
      
      chain.unshift(message); // Add to beginning to maintain chronological order
      currentMessageId = message.reply_to_message_id || null;
    }

    return chain;
  }

  async getTradeWithMessage(tradeId: number): Promise<TradeWithMessage | null> {
    const tradeStmt = this.db.prepare('SELECT * FROM trades WHERE id = ?');
    const trade = tradeStmt.get(tradeId) as Trade | undefined;
    if (!trade) return null;

    const message = await this.getMessageByMessageId(trade.message_id, trade.channel);
    if (!message) {
      logger.warn('Trade references non-existent message', { tradeId, messageId: trade.message_id });
      return null;
    }

    const replyChain = message.reply_to_message_id
      ? await this.getMessageReplyChain(message.message_id, trade.channel)
      : undefined;

    return {
      ...trade,
      source_message: message,
      reply_chain: replyChain,
    };
  }

  async getTradesWithMessages(status?: Trade['status']): Promise<TradeWithMessage[]> {
    const query = status
      ? 'SELECT * FROM trades WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM trades ORDER BY created_at DESC';
    const stmt = this.db.prepare(query);
    const trades = (status ? stmt.all(status) : stmt.all()) as Trade[];

    const result: TradeWithMessage[] = [];
    for (const trade of trades) {
      const message = await this.getMessageByMessageId(trade.message_id, trade.channel);
      if (!message) {
        logger.warn('Trade references non-existent message', { tradeId: trade.id, messageId: trade.message_id });
        continue;
      }

      const replyChain = message.reply_to_message_id
        ? await this.getMessageReplyChain(message.message_id, trade.channel)
        : undefined;

      result.push({
        ...trade,
        source_message: message,
        reply_chain: replyChain,
      });
    }

    return result;
  }

  async updateTrade(id: number, updates: Partial<Trade>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.order_id !== undefined) {
      fields.push('order_id = ?');
      values.push(updates.order_id);
    }
    if (updates.position_id !== undefined) {
      fields.push('position_id = ?');
      values.push(updates.position_id);
    }
    if (updates.entry_filled_at !== undefined) {
      fields.push('entry_filled_at = ?');
      values.push(updates.entry_filled_at);
    }
    if (updates.exit_price !== undefined) {
      fields.push('exit_price = ?');
      values.push(updates.exit_price);
    }
    if (updates.exit_filled_at !== undefined) {
      fields.push('exit_filled_at = ?');
      values.push(updates.exit_filled_at);
    }
    if (updates.pnl !== undefined) {
      fields.push('pnl = ?');
      values.push(updates.pnl);
    }
    if (updates.pnl_percentage !== undefined) {
      fields.push('pnl_percentage = ?');
      values.push(updates.pnl_percentage);
    }
    if (updates.stop_loss_breakeven !== undefined) {
      fields.push('stop_loss_breakeven = ?');
      values.push(updates.stop_loss_breakeven ? 1 : 0);
    }
    if (updates.stop_loss !== undefined) {
      fields.push('stop_loss = ?');
      values.push(updates.stop_loss);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = this.db.prepare(`UPDATE trades SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  async insertOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO orders (
        trade_id, order_type, order_id, price, tp_index, quantity, status,
        filled_at, filled_price, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      order.trade_id,
      order.order_type,
      order.order_id || null,
      order.price,
      order.tp_index !== undefined ? order.tp_index : null,
      order.quantity !== undefined ? order.quantity : null,
      order.status,
      order.filled_at || null,
      order.filled_price !== undefined ? order.filled_price : null
    );
    return result.lastInsertRowid as number;
  }

  async getOrdersByTradeId(tradeId: number): Promise<Order[]> {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE trade_id = ? ORDER BY tp_index ASC, created_at ASC');
    const rows = stmt.all(tradeId) as any[];
    return rows.map(row => ({
      ...row,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      filled_at: row.filled_at instanceof Date ? row.filled_at.toISOString() : row.filled_at || undefined
    })) as Order[];
  }

  async getOrdersByStatus(status: Order['status']): Promise<Order[]> {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at ASC');
    const rows = stmt.all(status) as any[];
    return rows.map(row => ({
      ...row,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      filled_at: row.filled_at instanceof Date ? row.filled_at.toISOString() : row.filled_at || undefined
    })) as Order[];
  }

  async updateOrder(id: number, updates: Partial<Order>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.order_id !== undefined) {
      fields.push('order_id = ?');
      values.push(updates.order_id);
    }
    if (updates.filled_at !== undefined) {
      fields.push('filled_at = ?');
      values.push(updates.filled_at);
    }
    if (updates.filled_price !== undefined) {
      fields.push('filled_price = ?');
      values.push(updates.filled_price);
    }
    if (updates.quantity !== undefined) {
      fields.push('quantity = ?');
      values.push(updates.quantity);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = this.db.prepare(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  async insertEvaluationResult(result: Omit<EvaluationResultRecord, 'id' | 'created_at'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO evaluation_results (
        channel, prop_firm_name, passed, violations, metrics, start_date, end_date, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const insertResult = stmt.run(
      result.channel,
      result.prop_firm_name,
      result.passed ? 1 : 0,
      result.violations,
      result.metrics,
      result.start_date,
      result.end_date
    );
    return insertResult.lastInsertRowid as number;
  }

  async getEvaluationResults(channel?: string, propFirmName?: string): Promise<EvaluationResultRecord[]> {
    let query = 'SELECT * FROM evaluation_results WHERE 1=1';
    const params: any[] = [];

    if (channel) {
      query += ' AND channel = ?';
      params.push(channel);
    }
    if (propFirmName) {
      query += ' AND prop_firm_name = ?';
      params.push(propFirmName);
    }

    query += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(query);
    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as any[];
    
    return rows.map(row => ({
      ...row,
      passed: row.passed === 1 || row.passed === true,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      start_date: row.start_date instanceof Date ? row.start_date.toISOString() : row.start_date,
      end_date: row.end_date instanceof Date ? row.end_date.toISOString() : row.end_date,
    })) as EvaluationResultRecord[];
  }

  async insertSignalFormat(format: Omit<SignalFormatRecord, 'id' | 'created_at'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO signal_formats (
        channel, format_pattern, format_hash, classification, example_count, first_seen, last_seen, extracted_fields, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      format.channel,
      format.format_pattern,
      format.format_hash,
      format.classification,
      format.example_count,
      format.first_seen,
      format.last_seen,
      format.extracted_fields || null
    );
    return result.lastInsertRowid as number;
  }

  async getSignalFormats(channel?: string, formatHash?: string): Promise<SignalFormatRecord[]> {
    let query = 'SELECT * FROM signal_formats WHERE 1=1';
    const params: any[] = [];

    if (channel) {
      query += ' AND channel = ?';
      params.push(channel);
    }
    if (formatHash) {
      query += ' AND format_hash = ?';
      params.push(formatHash);
    }

    query += ' ORDER BY example_count DESC, last_seen DESC';

    const stmt = this.db.prepare(query);
    const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as any[];
    
    return rows.map(row => ({
      ...row,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      first_seen: row.first_seen instanceof Date ? row.first_seen.toISOString() : row.first_seen,
      last_seen: row.last_seen instanceof Date ? row.last_seen.toISOString() : row.last_seen,
    })) as SignalFormatRecord[];
  }

  async updateSignalFormat(id: number, updates: Partial<SignalFormatRecord>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.example_count !== undefined) {
      fields.push('example_count = ?');
      values.push(updates.example_count);
    }
    if (updates.last_seen !== undefined) {
      fields.push('last_seen = ?');
      values.push(updates.last_seen);
    }
    if (updates.extracted_fields !== undefined) {
      fields.push('extracted_fields = ?');
      values.push(updates.extracted_fields);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE signal_formats SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgreSQLAdapter implements DatabaseAdapter {
  private pool!: Pool; // Initialized in initializeSchema, which is always called first
  private connectionString: string;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  /**
   * Parse connection string and resolve hostname to IPv4 address
   * Supabase now uses IPv6 by default, so we explicitly resolve to IPv4
   */
  private async parseConnectionString(connectionString: string): Promise<{ connectionString?: string; host?: string; port?: number; user?: string; password?: string; database?: string; sslmode?: string }> {
    try {
      const url = new URL(connectionString);
      
      // Check if hostname is an IPv6 address (not a hostname)
      const isIPv6Address = url.hostname.includes(':') && !url.hostname.includes('.');
      
      if (isIPv6Address) {
        logger.error('Connection string contains IPv6 address which is not supported', {
          hostname: url.hostname,
          hint: 'Your DATABASE_URL must use a hostname (e.g., db.xxxxx.supabase.co) not an IP address. For Supabase, use the connection pooler (port 6543) or enable IPv4 add-on.'
        });
        // Return as-is - will fail but at least we logged the error
        return { connectionString };
      }
      
      // Check if hostname is an IPv4 address
      const isIPv4Address = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
      
      let host = url.hostname;
      
      // If it's a hostname (not an IP address), resolve it to IPv4
      if (!isIPv4Address && !isIPv6Address) {
        try {
          logger.info('Resolving hostname to IPv4 address', { hostname: url.hostname });
          // Try resolve4 first (direct A record lookup for IPv4)
          try {
            const addresses = await dns.promises.resolve4(url.hostname);
            if (addresses.length > 0) {
              host = addresses[0];
              logger.info('Resolved hostname to IPv4 using resolve4', {
                hostname: url.hostname,
                ipv4: host
              });
            } else {
              throw new Error('No IPv4 addresses found');
            }
          } catch (resolve4Error) {
            // Fallback to lookup if resolve4 fails
            logger.debug('resolve4 failed, trying lookup', {
              hostname: url.hostname,
              error: resolve4Error instanceof Error ? resolve4Error.message : String(resolve4Error)
            });
            const address = await dns.promises.lookup(url.hostname, { family: 4 });
            host = address.address;
            logger.info('Resolved hostname to IPv4 using lookup', {
              hostname: url.hostname,
              ipv4: host
            });
          }
        } catch (resolveError) {
          // Check if hostname resolves to IPv6 only
          let hasIPv6 = false;
          try {
            const ipv6Addresses = await dns.promises.resolve6(url.hostname);
            hasIPv6 = ipv6Addresses.length > 0;
          } catch {
            // Ignore IPv6 resolution errors
          }
          
          const isSupabase = url.hostname.includes('supabase.co');
          const errorMessage = hasIPv6
            ? `Hostname ${url.hostname} only resolves to IPv6 addresses. Direct connections require IPv6 support, which is not available in this environment.`
            : `Failed to resolve hostname ${url.hostname} to IPv4.`;
          
          logger.error(errorMessage, {
            hostname: url.hostname,
            error: resolveError instanceof Error ? resolveError.message : String(resolveError),
            hasIPv6Only: hasIPv6,
            isSupabase
          });
          
          // Fail fast - don't let pg try IPv6
          if (isSupabase) {
            throw new Error(
              `${errorMessage}\n\n` +
              `SOLUTION: Use Supabase Connection Pooler (Recommended - Free)\n` +
              `The connection pooler resolves to IPv4 addresses and works without IPv6 support.\n\n` +
              `Steps:\n` +
              `1. Go to Supabase Dashboard → Settings → Database\n` +
              `2. Scroll to "Connection Pooling" section\n` +
              `3. Copy the "Transaction" or "Session" pooler connection string (port 6543)\n` +
              `4. Update your DATABASE_URL environment variable\n\n` +
              `Alternative: Enable the dedicated IPv4 add-on in Supabase (paid feature)\n` +
              `This allows direct connections via IPv4, but the pooler is recommended.`
            );
          } else {
            throw new Error(
              `${errorMessage}\n` +
              `Please check your DNS configuration or use a database provider that supports IPv4 connections.`
            );
          }
        }
      }
      
      // Parse into separate components
      const config: any = {
        host: host,
        port: parseInt(url.port || '5432'),
        user: url.username,
        password: url.password,
        database: url.pathname.slice(1), // Remove leading /
      };
      
      // Handle query parameters (like sslmode)
      if (url.search) {
        const params = new URLSearchParams(url.search);
        if (params.has('sslmode')) {
          config.sslmode = params.get('sslmode');
        }
      }
      
      logger.info('Parsed PostgreSQL connection string', {
        originalHostname: url.hostname,
        resolvedHost: host,
        port: config.port,
        database: config.database,
        user: config.user || '(none)'
      });
      
      return config;
    } catch (error) {
      // If URL parsing fails, return connectionString as-is
      logger.warn('Failed to parse connection string, using as-is', {
        error: error instanceof Error ? error.message : String(error)
      });
      return { connectionString };
    }
  }

  async initializeSchema(): Promise<void> {
    // Create pool on first use, resolving hostname to IPv4 first
    if (!this.pool) {
      // Parse connection string and resolve hostname to IPv4
      // Supabase now uses IPv6 by default, so we need to explicitly resolve to IPv4
      const connectionConfig = await this.parseConnectionString(this.connectionString);
      
      // Determine SSL settings
      const needsSSL = this.connectionString.includes('sslmode=require') || 
                       this.connectionString.includes('ssl=true') ||
                       this.connectionString.includes('supabase.co') || // Supabase requires SSL
                       this.connectionString.includes('neon.tech') || // Neon requires SSL
                       connectionConfig.sslmode === 'require';
      
      this.pool = new Pool({
        ...connectionConfig,
        ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
      });
    }
    
    const client = await this.pool.connect();
    try {
      // Messages table
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          message_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          content TEXT NOT NULL,
          sender TEXT,
          date TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          parsed BOOLEAN NOT NULL DEFAULT FALSE,
          analyzed BOOLEAN NOT NULL DEFAULT FALSE,
          reply_to_message_id TEXT,
          UNIQUE(message_id, channel)
        )
      `);
      
      // Migrate message_id from INTEGER/BIGINT to TEXT if needed
      try {
        await client.query(`
          ALTER TABLE messages 
          ALTER COLUMN message_id TYPE TEXT USING message_id::TEXT
        `);
      } catch (error: any) {
        // Column might already be TEXT, ignore migration errors
        const errorMsg = error.message?.toLowerCase() || '';
        if (!errorMsg.includes('does not exist') && 
            !errorMsg.includes('type') && 
            !errorMsg.includes('text') &&
            !errorMsg.includes('already')) {
          logger.warn('Failed to migrate message_id to TEXT', {
            error: error.message
          });
        }
      }
      
      // Migrate reply_to_message_id from INTEGER/BIGINT to TEXT if needed
      try {
        await client.query(`
          ALTER TABLE messages 
          ALTER COLUMN reply_to_message_id TYPE TEXT USING reply_to_message_id::TEXT
        `);
      } catch (error: any) {
        // Column might already be TEXT or doesn't exist yet, ignore migration errors
        const errorMsg = error.message?.toLowerCase() || '';
        if (!errorMsg.includes('does not exist') && 
            !errorMsg.includes('type') && 
            !errorMsg.includes('text') &&
            !errorMsg.includes('already')) {
          logger.warn('Failed to migrate reply_to_message_id to TEXT', {
            error: error.message
          });
        }
      }
      
      // Add analyzed column if it doesn't exist (for backward compatibility)
      try {
        await client.query(`ALTER TABLE messages ADD COLUMN analyzed BOOLEAN NOT NULL DEFAULT FALSE`);
      } catch (error: any) {
        // Column already exists, ignore
        if (!error.message?.includes('already exists') && !error.message?.includes('duplicate')) {
          throw error;
        }
      }
      
      // Add reply_to_message_id column if it doesn't exist (migration)
      try {
        await client.query(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
      } catch (error: any) {
        // Column already exists, ignore
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }
      
      // Add old_content and edited_at columns if they don't exist (migration)
      try {
        await client.query(`ALTER TABLE messages ADD COLUMN old_content TEXT`);
      } catch (error: any) {
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }
      try {
        await client.query(`ALTER TABLE messages ADD COLUMN edited_at TIMESTAMP`);
      } catch (error: any) {
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }
      
      // Add image_paths column if it doesn't exist (migration)
      try {
        await client.query(`ALTER TABLE messages ADD COLUMN image_paths TEXT`);
      } catch (error: any) {
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }

      // Message versions table - stores full edit history
      await client.query(`
        CREATE TABLE IF NOT EXISTS message_versions (
          id SERIAL PRIMARY KEY,
          message_id INTEGER NOT NULL,
          channel TEXT NOT NULL,
          content TEXT NOT NULL,
          version_number INTEGER NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
          UNIQUE(message_id, version_number)
        )
      `);

      // Trades table
      await client.query(`
        CREATE TABLE IF NOT EXISTS trades (
          id SERIAL PRIMARY KEY,
          message_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          trading_pair TEXT NOT NULL,
          leverage REAL NOT NULL,
          entry_price REAL NOT NULL,
          stop_loss REAL NOT NULL,
          take_profits TEXT NOT NULL,
          risk_percentage REAL NOT NULL,
          quantity REAL,
          exchange TEXT NOT NULL,
          account_name TEXT,
          order_id TEXT,
          position_id TEXT,
          entry_order_type TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          entry_filled_at TIMESTAMP,
          exit_price REAL,
          exit_filled_at TIMESTAMP,
          pnl REAL,
          pnl_percentage REAL,
          stop_loss_breakeven BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL
        )
      `);
      
      // Migrate trades.message_id from INTEGER/BIGINT to TEXT if needed
      try {
        await client.query(`
          ALTER TABLE trades 
          ALTER COLUMN message_id TYPE TEXT USING message_id::TEXT
        `);
      } catch (error: any) {
        // Column might already be TEXT, ignore migration errors
        const errorMsg = error.message?.toLowerCase() || '';
        if (!errorMsg.includes('does not exist') && 
            !errorMsg.includes('type') && 
            !errorMsg.includes('text') &&
            !errorMsg.includes('already')) {
          logger.warn('Failed to migrate trades.message_id to TEXT', {
            error: error.message
          });
        }
      }

      // Add account_name column if it doesn't exist (migration)
      try {
        await client.query(`ALTER TABLE trades ADD COLUMN account_name TEXT`);
      } catch (error: any) {
        // Column already exists, ignore
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }

      // Add quantity column if it doesn't exist (migration)
      try {
        await client.query(`ALTER TABLE trades ADD COLUMN quantity REAL`);
      } catch (error: any) {
        // Column already exists, ignore
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }

      // Add entry_order_type column if it doesn't exist (migration)
      try {
        await client.query(`ALTER TABLE trades ADD COLUMN entry_order_type TEXT`);
      } catch (error: any) {
        // Column already exists, ignore
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }

      // Add direction column if it doesn't exist (migration)
      try {
        await client.query(`ALTER TABLE trades ADD COLUMN direction TEXT`);
      } catch (error: any) {
        // Column already exists, ignore
        if (!error.message?.includes('already exists')) {
          throw error;
        }
      }

      // Migrate leverage from INTEGER to REAL if needed (PostgreSQL)
      try {
        await client.query(`
          ALTER TABLE trades 
          ALTER COLUMN leverage TYPE REAL USING leverage::REAL
        `);
        logger.info('Successfully migrated PostgreSQL trades.leverage to REAL');
      } catch (error: any) {
        // Column might already be REAL, ignore migration errors
        const errorMsg = error.message?.toLowerCase() || '';
        if (!errorMsg.includes('does not exist') && 
            !errorMsg.includes('type') && 
            !errorMsg.includes('real') &&
            !errorMsg.includes('already')) {
          logger.warn('Failed to migrate PostgreSQL trades.leverage to REAL', {
            error: error.message
          });
        }
      }

      // Orders table - tracks SL/TP orders for trades
      await client.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          trade_id INTEGER NOT NULL,
          order_type TEXT NOT NULL,
          order_id TEXT,
          price REAL NOT NULL,
          tp_index INTEGER,
          quantity REAL,
          status TEXT NOT NULL DEFAULT 'pending',
          filled_at TIMESTAMP,
          filled_price REAL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE
        )
      `);

      // Evaluation results table
      await client.query(`
        CREATE TABLE IF NOT EXISTS evaluation_results (
          id SERIAL PRIMARY KEY,
          channel TEXT NOT NULL,
          prop_firm_name TEXT NOT NULL,
          passed BOOLEAN NOT NULL,
          violations TEXT NOT NULL,
          metrics TEXT NOT NULL,
          start_date TIMESTAMP NOT NULL,
          end_date TIMESTAMP NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Signal formats table
      await client.query(`
        CREATE TABLE IF NOT EXISTS signal_formats (
          id SERIAL PRIMARY KEY,
          channel TEXT NOT NULL,
          format_pattern TEXT NOT NULL,
          format_hash TEXT NOT NULL,
          classification TEXT NOT NULL,
          example_count INTEGER NOT NULL DEFAULT 1,
          first_seen TIMESTAMP NOT NULL,
          last_seen TIMESTAMP NOT NULL,
          extracted_fields TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(channel, format_hash)
        )
      `);

      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_channel_parsed ON messages(channel, parsed);
        CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_message_id, channel);
        CREATE INDEX IF NOT EXISTS idx_message_versions_message_id ON message_versions(message_id, channel);
        CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
        CREATE INDEX IF NOT EXISTS idx_trades_channel ON trades(channel);
        CREATE INDEX IF NOT EXISTS idx_trades_message_id ON trades(message_id, channel);
        CREATE INDEX IF NOT EXISTS idx_orders_trade_id ON orders(trade_id);
        CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
        CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
        CREATE INDEX IF NOT EXISTS idx_evaluation_results_channel ON evaluation_results(channel);
        CREATE INDEX IF NOT EXISTS idx_evaluation_results_prop_firm ON evaluation_results(prop_firm_name);
        CREATE INDEX IF NOT EXISTS idx_signal_formats_channel ON signal_formats(channel);
        CREATE INDEX IF NOT EXISTS idx_signal_formats_hash ON signal_formats(format_hash);
        CREATE INDEX IF NOT EXISTS idx_signal_formats_classification ON signal_formats(classification);
      `);
    } finally {
      client.release();
    }
  }

  async insertMessage(message: Omit<Message, 'id' | 'created_at' | 'parsed' | 'analyzed'>): Promise<number> {
    const result = await this.pool.query(`
      INSERT INTO messages (message_id, channel, content, sender, date, created_at, parsed, analyzed, reply_to_message_id, image_paths)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, FALSE, FALSE, $6, $7)
      RETURNING id
    `, [
      message.message_id,
      message.channel,
      message.content,
      message.sender || null,
      message.date,
      message.reply_to_message_id || null,
      message.image_paths || null
    ]);
    return result.rows[0].id;
  }

  async getUnparsedMessages(channel?: string, maxStalenessMinutes?: number): Promise<Message[]> {
    let query: string;
    let params: any[];

    if (maxStalenessMinutes !== undefined && maxStalenessMinutes > 0) {
      // Calculate cutoff timestamp (current time minus staleness minutes)
      const cutoffTime = new Date(Date.now() - maxStalenessMinutes * 60 * 1000).toISOString();
      
      if (channel) {
        query = 'SELECT * FROM messages WHERE parsed = FALSE AND channel = $1 AND date >= $2 ORDER BY id ASC';
        params = [channel, cutoffTime];
      } else {
        query = 'SELECT * FROM messages WHERE parsed = FALSE AND date >= $1 ORDER BY id ASC';
        params = [cutoffTime];
      }
    } else {
      // No staleness filter
      if (channel) {
        query = 'SELECT * FROM messages WHERE parsed = FALSE AND channel = $1 ORDER BY id ASC';
        params = [channel];
      } else {
        query = 'SELECT * FROM messages WHERE parsed = FALSE ORDER BY id ASC';
        params = [];
      }
    }

    const result = await this.pool.query(query, params);
    return result.rows.map(row => ({
      ...row,
      parsed: row.parsed === true || row.parsed === 't',
      analyzed: row.analyzed === true || row.analyzed === 't' || false,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      date: row.date instanceof Date ? row.date.toISOString() : row.date
    })) as Message[];
  }

  async getEditedMessages(channel?: string, maxStalenessMinutes?: number): Promise<Message[]> {
    let query: string;
    let params: any[];

    if (maxStalenessMinutes !== undefined && maxStalenessMinutes > 0) {
      // Calculate cutoff timestamp (current time minus staleness minutes)
      const cutoffTime = new Date(Date.now() - maxStalenessMinutes * 60 * 1000).toISOString();
      
      if (channel) {
        query = 'SELECT * FROM messages WHERE old_content IS NOT NULL AND channel = $1 AND date >= $2 ORDER BY id ASC';
        params = [channel, cutoffTime];
      } else {
        query = 'SELECT * FROM messages WHERE old_content IS NOT NULL AND date >= $1 ORDER BY id ASC';
        params = [cutoffTime];
      }
    } else {
      // No staleness filter
      if (channel) {
        query = 'SELECT * FROM messages WHERE old_content IS NOT NULL AND channel = $1 ORDER BY id ASC';
        params = [channel];
      } else {
        query = 'SELECT * FROM messages WHERE old_content IS NOT NULL ORDER BY id ASC';
        params = [];
      }
    }

    const result = await this.pool.query(query, params);
    return result.rows.map(row => ({
      ...row,
      parsed: row.parsed === true || row.parsed === 't',
      analyzed: row.analyzed === true || row.analyzed === 't' || false,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      date: row.date instanceof Date ? row.date.toISOString() : row.date
    })) as Message[];
  }

  async getUnanalyzedMessages(channel?: string): Promise<Message[]> {
    const query = channel
      ? 'SELECT * FROM messages WHERE (analyzed IS NULL OR analyzed = FALSE) AND channel = $1 ORDER BY id ASC'
      : 'SELECT * FROM messages WHERE analyzed IS NULL OR analyzed = FALSE ORDER BY id ASC';
    const params = channel ? [channel] : [];
    const result = await this.pool.query(query, params);
    return result.rows.map(row => ({
      ...row,
      parsed: row.parsed === true || row.parsed === 't',
      analyzed: row.analyzed === true || row.analyzed === 't' || false,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      date: row.date instanceof Date ? row.date.toISOString() : row.date
    })) as Message[];
  }

  async getMessagesByChannel(channel: string, limit?: number): Promise<Message[]> {
    const query = limit && limit > 0
      ? 'SELECT * FROM messages WHERE channel = $1 ORDER BY id ASC LIMIT $2'
      : 'SELECT * FROM messages WHERE channel = $1 ORDER BY id ASC';
    const params = limit && limit > 0 ? [channel, limit] : [channel];
    const result = await this.pool.query(query, params);
    return result.rows.map(row => ({
      ...row,
      parsed: row.parsed === true || row.parsed === 't',
      analyzed: row.analyzed === true || row.analyzed === 't' || false,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      date: row.date instanceof Date ? row.date.toISOString() : row.date
    })) as Message[];
  }

  async markMessageParsed(id: number): Promise<void> {
    await this.pool.query('UPDATE messages SET parsed = TRUE WHERE id = $1', [id]);
  }

  async markMessageAnalyzed(id: number): Promise<void> {
    await this.pool.query('UPDATE messages SET analyzed = TRUE WHERE id = $1', [id]);
  }

  async updateMessage(messageId: string, channel: string, updates: Partial<Message>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.content !== undefined) {
      fields.push(`content = $${paramIndex++}`);
      values.push(updates.content);
    }
    if (updates.old_content !== undefined) {
      fields.push(`old_content = $${paramIndex++}`);
      values.push(updates.old_content);
    }
    if (updates.edited_at !== undefined) {
      fields.push(`edited_at = $${paramIndex++}`);
      values.push(updates.edited_at);
    }
    if (updates.parsed !== undefined) {
      fields.push(`parsed = $${paramIndex++}`);
      values.push(updates.parsed);
    }

    if (fields.length === 0) {
      return; // No updates to apply
    }

    values.push(messageId, channel);
    await this.pool.query(
      `UPDATE messages SET ${fields.join(', ')} WHERE message_id = $${paramIndex} AND channel = $${paramIndex + 1}`,
      values
    );
  }

  async insertMessageVersion(messageId: string, channel: string, content: string): Promise<number> {
    // Get the internal message ID from Telegram message_id
    const message = await this.getMessageByMessageId(messageId, channel);
    if (!message) {
      throw new Error(`Message not found: message_id=${messageId}, channel=${channel}`);
    }

    // Get the current highest version number for this message
    const versionResult = await this.pool.query(
      'SELECT MAX(version_number) as max_version FROM message_versions WHERE message_id = $1',
      [message.id]
    );
    const maxVersion = versionResult.rows[0]?.max_version;
    const nextVersion = (maxVersion ?? -1) + 1;

    // Insert the new version
    const result = await this.pool.query(`
      INSERT INTO message_versions (message_id, channel, content, version_number, created_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING id
    `, [message.id, channel, content, nextVersion]);
    
    return result.rows[0].id;
  }

  async getMessageVersions(messageId: string, channel: string): Promise<MessageVersion[]> {
    // Get the internal message ID from Telegram message_id
    const message = await this.getMessageByMessageId(messageId, channel);
    if (!message) {
      return [];
    }

    const result = await this.pool.query(`
      SELECT mv.*
      FROM message_versions mv
      WHERE mv.message_id = $1 AND mv.channel = $2
      ORDER BY mv.version_number ASC
    `, [message.id, channel]);
    
    return result.rows.map(row => ({
      id: row.id,
      message_id: row.message_id,
      channel: row.channel,
      content: row.content,
      version_number: row.version_number,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
    })) as MessageVersion[];
  }

  async getMessageByMessageId(messageId: string, channel: string): Promise<Message | null> {
    const result = await this.pool.query(
      'SELECT * FROM messages WHERE message_id = $1 AND channel = $2',
      [messageId, channel]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      ...row,
      parsed: row.parsed === true || row.parsed === 't',
      analyzed: row.analyzed === true || row.analyzed === 't' || false,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      date: row.date instanceof Date ? row.date.toISOString() : row.date
    } as Message;
  }

  async getMessagesByReplyTo(replyToMessageId: string, channel: string): Promise<Message[]> {
    const result = await this.pool.query(
      'SELECT * FROM messages WHERE reply_to_message_id = $1 AND channel = $2 ORDER BY date ASC',
      [replyToMessageId, channel]
    );
    return result.rows.map(row => ({
      ...row,
      parsed: row.parsed === true || row.parsed === 't',
      analyzed: row.analyzed === true || row.analyzed === 't' || false,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      date: row.date instanceof Date ? row.date.toISOString() : row.date
    })) as Message[];
  }

  async getMessageReplyChain(messageId: string, channel: string): Promise<Message[]> {
    const chain: Message[] = [];
    let currentMessageId: string | null = messageId;
    const visited = new Set<string>();

    while (currentMessageId && !visited.has(currentMessageId)) {
      visited.add(currentMessageId);
      const message = await this.getMessageByMessageId(currentMessageId, channel);
      if (!message) break;
      
      chain.unshift(message); // Add to beginning to maintain chronological order
      currentMessageId = message.reply_to_message_id || null;
    }

    return chain;
  }

  async getTradeWithMessage(tradeId: number): Promise<TradeWithMessage | null> {
    const result = await this.pool.query('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (result.rows.length === 0) return null;
    
    const trade = this.normalizeTrades(result.rows)[0];
    const message = await this.getMessageByMessageId(trade.message_id, trade.channel);
    if (!message) {
      logger.warn('Trade references non-existent message', { tradeId, messageId: trade.message_id });
      return null;
    }

    const replyChain = message.reply_to_message_id
      ? await this.getMessageReplyChain(message.message_id, trade.channel)
      : undefined;

    return {
      ...trade,
      source_message: message,
      reply_chain: replyChain,
    };
  }

  async getTradesWithMessages(status?: Trade['status']): Promise<TradeWithMessage[]> {
    const query = status
      ? 'SELECT * FROM trades WHERE status = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM trades ORDER BY created_at DESC';
    const params = status ? [status] : [];
    const result = await this.pool.query(query, params);
    const trades = this.normalizeTrades(result.rows);

    const tradeWithMessages: TradeWithMessage[] = [];
    for (const trade of trades) {
      const message = await this.getMessageByMessageId(trade.message_id, trade.channel);
      if (!message) {
        logger.warn('Trade references non-existent message', { tradeId: trade.id, messageId: trade.message_id });
        continue;
      }

      const replyChain = message.reply_to_message_id
        ? await this.getMessageReplyChain(message.message_id, trade.channel)
        : undefined;

      tradeWithMessages.push({
        ...trade,
        source_message: message,
        reply_chain: replyChain,
      });
    }

    return tradeWithMessages;
  }

  async insertTrade(trade: Omit<Trade, 'id' | 'created_at' | 'updated_at'> & { created_at?: string }): Promise<number> {
    const created_at = trade.created_at;
    const result = await this.pool.query(`
      INSERT INTO trades (
        message_id, channel, trading_pair, leverage, entry_price, stop_loss,
        take_profits, risk_percentage, quantity, exchange, account_name, order_id, position_id, entry_order_type, direction, status,
        entry_filled_at, exit_price, exit_filled_at, pnl, pnl_percentage,
        stop_loss_breakeven, expires_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, ${created_at ? '$24' : 'CURRENT_TIMESTAMP'}, CURRENT_TIMESTAMP)
      RETURNING id
    `, [
      trade.message_id,
      trade.channel,
      trade.trading_pair,
      trade.leverage,
      trade.entry_price,
      trade.stop_loss,
      trade.take_profits,
      trade.risk_percentage,
      trade.quantity || null,
      trade.exchange,
      trade.account_name || null,
      trade.order_id || null,
      trade.position_id || null,
      trade.entry_order_type || null,
      trade.direction || null,
      trade.status,
      trade.entry_filled_at || null,
      trade.exit_price || null,
      trade.exit_filled_at || null,
      trade.pnl || null,
      trade.pnl_percentage || null,
      trade.stop_loss_breakeven,
      trade.expires_at,
      ...(created_at ? [created_at] : [])
    ]);
    return result.rows[0].id;
  }

  async getActiveTrades(): Promise<Trade[]> {
    const result = await this.pool.query(`
      SELECT * FROM trades 
      WHERE status IN ('pending', 'active', 'filled')
      ORDER BY created_at ASC
    `);
    return this.normalizeTrades(result.rows);
  }

  async getClosedTrades(): Promise<Trade[]> {
    const result = await this.pool.query(`
      SELECT * FROM trades 
      WHERE status IN ('closed', 'stopped', 'cancelled', 'completed')
      ORDER BY exit_filled_at DESC
    `);
    return this.normalizeTrades(result.rows);
  }

  async getTradesByStatus(status: Trade['status']): Promise<Trade[]> {
    const result = await this.pool.query(
      'SELECT * FROM trades WHERE status = $1 ORDER BY created_at ASC',
      [status]
    );
    return this.normalizeTrades(result.rows);
  }

  async getTradesByMessageId(messageId: string, channel: string): Promise<Trade[]> {
    const result = await this.pool.query(
      'SELECT * FROM trades WHERE message_id = $1 AND channel = $2 ORDER BY created_at ASC',
      [messageId, channel]
    );
    return this.normalizeTrades(result.rows);
  }

  async updateTrade(id: number, updates: Partial<Trade>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.order_id !== undefined) {
      fields.push(`order_id = $${paramIndex++}`);
      values.push(updates.order_id);
    }
    if (updates.position_id !== undefined) {
      fields.push(`position_id = $${paramIndex++}`);
      values.push(updates.position_id);
    }
    if (updates.entry_filled_at !== undefined) {
      fields.push(`entry_filled_at = $${paramIndex++}`);
      values.push(updates.entry_filled_at);
    }
    if (updates.exit_price !== undefined) {
      fields.push(`exit_price = $${paramIndex++}`);
      values.push(updates.exit_price);
    }
    if (updates.exit_filled_at !== undefined) {
      fields.push(`exit_filled_at = $${paramIndex++}`);
      values.push(updates.exit_filled_at);
    }
    if (updates.pnl !== undefined) {
      fields.push(`pnl = $${paramIndex++}`);
      values.push(updates.pnl);
    }
    if (updates.pnl_percentage !== undefined) {
      fields.push(`pnl_percentage = $${paramIndex++}`);
      values.push(updates.pnl_percentage);
    }
    if (updates.stop_loss_breakeven !== undefined) {
      fields.push(`stop_loss_breakeven = $${paramIndex++}`);
      values.push(updates.stop_loss_breakeven);
    }
    if (updates.stop_loss !== undefined) {
      fields.push(`stop_loss = $${paramIndex++}`);
      values.push(updates.stop_loss);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await this.pool.query(
      `UPDATE trades SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  async insertOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const result = await this.pool.query(`
      INSERT INTO orders (
        trade_id, order_type, order_id, price, tp_index, quantity, status,
        filled_at, filled_price, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id
    `, [
      order.trade_id,
      order.order_type,
      order.order_id || null,
      order.price,
      order.tp_index !== undefined ? order.tp_index : null,
      order.quantity !== undefined ? order.quantity : null,
      order.status,
      order.filled_at || null,
      order.filled_price !== undefined ? order.filled_price : null
    ]);
    return result.rows[0].id;
  }

  async getOrdersByTradeId(tradeId: number): Promise<Order[]> {
    const result = await this.pool.query(
      'SELECT * FROM orders WHERE trade_id = $1 ORDER BY tp_index ASC, created_at ASC',
      [tradeId]
    );
    return result.rows.map(row => ({
      ...row,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      filled_at: row.filled_at instanceof Date ? row.filled_at.toISOString() : row.filled_at || undefined
    })) as Order[];
  }

  async getOrdersByStatus(status: Order['status']): Promise<Order[]> {
    const result = await this.pool.query(
      'SELECT * FROM orders WHERE status = $1 ORDER BY created_at ASC',
      [status]
    );
    return result.rows.map(row => ({
      ...row,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      filled_at: row.filled_at instanceof Date ? row.filled_at.toISOString() : row.filled_at || undefined
    })) as Order[];
  }

  async updateOrder(id: number, updates: Partial<Order>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.order_id !== undefined) {
      fields.push(`order_id = $${paramIndex++}`);
      values.push(updates.order_id);
    }
    if (updates.filled_at !== undefined) {
      fields.push(`filled_at = $${paramIndex++}`);
      values.push(updates.filled_at);
    }
    if (updates.filled_price !== undefined) {
      fields.push(`filled_price = $${paramIndex++}`);
      values.push(updates.filled_price);
    }
    if (updates.quantity !== undefined) {
      fields.push(`quantity = $${paramIndex++}`);
      values.push(updates.quantity);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await this.pool.query(
      `UPDATE orders SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  private normalizeTrades(rows: any[]): Trade[] {
    return rows.map(row => ({
      ...row,
      stop_loss_breakeven: row.stop_loss_breakeven === true || row.stop_loss_breakeven === 't',
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
      entry_filled_at: row.entry_filled_at instanceof Date ? row.entry_filled_at.toISOString() : row.entry_filled_at,
      exit_filled_at: row.exit_filled_at instanceof Date ? row.exit_filled_at.toISOString() : row.exit_filled_at
    })) as Trade[];
  }

  async insertEvaluationResult(result: Omit<EvaluationResultRecord, 'id' | 'created_at'>): Promise<number> {
    const queryResult = await this.pool.query(`
      INSERT INTO evaluation_results (
        channel, prop_firm_name, passed, violations, metrics, start_date, end_date, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      RETURNING id
    `, [
      result.channel,
      result.prop_firm_name,
      result.passed,
      result.violations,
      result.metrics,
      result.start_date,
      result.end_date
    ]);
    return queryResult.rows[0].id;
  }

  async getEvaluationResults(channel?: string, propFirmName?: string): Promise<EvaluationResultRecord[]> {
    let query = 'SELECT * FROM evaluation_results WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (channel) {
      query += ` AND channel = $${paramIndex++}`;
      params.push(channel);
    }
    if (propFirmName) {
      query += ` AND prop_firm_name = $${paramIndex++}`;
      params.push(propFirmName);
    }

    query += ' ORDER BY created_at DESC';

    const result = await this.pool.query(query, params);
    return result.rows.map(row => ({
      ...row,
      passed: row.passed === true || row.passed === 't',
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      start_date: row.start_date instanceof Date ? row.start_date.toISOString() : row.start_date,
      end_date: row.end_date instanceof Date ? row.end_date.toISOString() : row.end_date,
    })) as EvaluationResultRecord[];
  }

  async insertSignalFormat(format: Omit<SignalFormatRecord, 'id' | 'created_at'>): Promise<number> {
    const result = await this.pool.query(`
      INSERT INTO signal_formats (
        channel, format_pattern, format_hash, classification, example_count, first_seen, last_seen, extracted_fields, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      RETURNING id
    `, [
      format.channel,
      format.format_pattern,
      format.format_hash,
      format.classification,
      format.example_count,
      format.first_seen,
      format.last_seen,
      format.extracted_fields || null
    ]);
    return result.rows[0].id;
  }

  async getSignalFormats(channel?: string, formatHash?: string): Promise<SignalFormatRecord[]> {
    let query = 'SELECT * FROM signal_formats WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (channel) {
      query += ` AND channel = $${paramIndex++}`;
      params.push(channel);
    }
    if (formatHash) {
      query += ` AND format_hash = $${paramIndex++}`;
      params.push(formatHash);
    }

    query += ' ORDER BY example_count DESC, last_seen DESC';

    const result = await this.pool.query(query, params);
    return result.rows.map(row => ({
      ...row,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      first_seen: row.first_seen instanceof Date ? row.first_seen.toISOString() : row.first_seen,
      last_seen: row.last_seen instanceof Date ? row.last_seen.toISOString() : row.last_seen,
    })) as SignalFormatRecord[];
  }

  async updateSignalFormat(id: number, updates: Partial<SignalFormatRecord>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.example_count !== undefined) {
      fields.push(`example_count = $${paramIndex++}`);
      values.push(updates.example_count);
    }
    if (updates.last_seen !== undefined) {
      fields.push(`last_seen = $${paramIndex++}`);
      values.push(updates.last_seen);
    }
    if (updates.extracted_fields !== undefined) {
      fields.push(`extracted_fields = $${paramIndex++}`);
      values.push(updates.extracted_fields);
    }

    if (fields.length === 0) return;

    values.push(id);
    await this.pool.query(
      `UPDATE signal_formats SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class DatabaseManager {
  private adapter: DatabaseAdapter;
  private dbType: DatabaseType;

  constructor(config?: { type?: DatabaseType; path?: string; url?: string }) {
    // Determine database type from config or environment
    // Default to PostgreSQL for cloud/production environments
    // Only use SQLite if explicitly requested via DATABASE_PATH or config.path
    const explicitType = config?.type || (process.env.DATABASE_TYPE as DatabaseType);
    const hasDatabaseUrl = !!process.env.DATABASE_URL;
    const hasDatabasePath = !!(config?.path || process.env.DATABASE_PATH);
    const hasConfigUrl = !!config?.url;
    
    // Priority: explicit type > DATABASE_URL/config.url > DATABASE_PATH/config.path > default PostgreSQL
    let dbType: DatabaseType;
    if (explicitType) {
      dbType = explicitType;
    } else if (hasDatabaseUrl || hasConfigUrl) {
      dbType = 'postgresql';
    } else if (hasDatabasePath) {
      dbType = 'sqlite';
    } else {
      // Default to PostgreSQL (assumes cloud/production environment)
      dbType = 'postgresql';
    }
    
    this.dbType = dbType;

    if (dbType === 'postgresql') {
      const connectionString = process.env.DATABASE_URL || config?.url;
      if (!connectionString) {
        throw new Error('PostgreSQL requires DATABASE_URL environment variable or database.url in config. If you want to use SQLite, set DATABASE_PATH or database.path in config.');
      }
      this.adapter = new PostgreSQLAdapter(connectionString);
      logger.info('Database initialized', { type: 'postgresql' });
    } else {
      const dbPath = config?.path || process.env.DATABASE_PATH || 'data/trading_bot.db';
      this.adapter = new SQLiteAdapter(dbPath);
      logger.info('Database initialized', { type: 'sqlite', path: dbPath });
    }
  }

  async initialize(): Promise<void> {
    await this.adapter.initializeSchema();
  }

  insertMessage(message: Omit<Message, 'id' | 'created_at' | 'parsed' | 'analyzed'>): Promise<number> {
    return this.adapter.insertMessage(message);
  }

  getUnparsedMessages(channel?: string, maxStalenessMinutes?: number): Promise<Message[]> {
    return this.adapter.getUnparsedMessages(channel, maxStalenessMinutes);
  }

  getEditedMessages(channel?: string, maxStalenessMinutes?: number): Promise<Message[]> {
    return this.adapter.getEditedMessages(channel, maxStalenessMinutes);
  }

  getUnanalyzedMessages(channel?: string): Promise<Message[]> {
    return this.adapter.getUnanalyzedMessages(channel);
  }

  markMessageParsed(id: number): Promise<void> {
    return this.adapter.markMessageParsed(id);
  }

  markMessageAnalyzed(id: number): Promise<void> {
    return this.adapter.markMessageAnalyzed(id);
  }

  updateMessage(messageId: string, channel: string, updates: Partial<Message>): Promise<void> {
    return this.adapter.updateMessage(messageId, channel, updates);
  }

  insertMessageVersion(messageId: string, channel: string, content: string): Promise<number> {
    return this.adapter.insertMessageVersion(messageId, channel, content);
  }

  getMessageVersions(messageId: string, channel: string): Promise<MessageVersion[]> {
    return this.adapter.getMessageVersions(messageId, channel);
  }

  getMessageByMessageId(messageId: string, channel: string): Promise<Message | null> {
    return this.adapter.getMessageByMessageId(messageId, channel);
  }

  getMessagesByReplyTo(replyToMessageId: string, channel: string): Promise<Message[]> {
    return this.adapter.getMessagesByReplyTo(replyToMessageId, channel);
  }

  getMessageReplyChain(messageId: string, channel: string): Promise<Message[]> {
    return this.adapter.getMessageReplyChain(messageId, channel);
  }

  getMessagesByChannel(channel: string, limit?: number): Promise<Message[]> {
    return this.adapter.getMessagesByChannel(channel, limit);
  }

  insertTrade(trade: Omit<Trade, 'id' | 'created_at' | 'updated_at'> & { created_at?: string }): Promise<number> {
    return this.adapter.insertTrade(trade);
  }

  getActiveTrades(): Promise<Trade[]> {
    return this.adapter.getActiveTrades();
  }

  getClosedTrades(): Promise<Trade[]> {
    return this.adapter.getClosedTrades();
  }

  getTradesByStatus(status: Trade['status']): Promise<Trade[]> {
    return this.adapter.getTradesByStatus(status);
  }

  getTradesByMessageId(messageId: string, channel: string): Promise<Trade[]> {
    return this.adapter.getTradesByMessageId(messageId, channel);
  }

  getTradeWithMessage(tradeId: number): Promise<TradeWithMessage | null> {
    return this.adapter.getTradeWithMessage(tradeId);
  }

  getTradesWithMessages(status?: Trade['status']): Promise<TradeWithMessage[]> {
    return this.adapter.getTradesWithMessages(status);
  }

  updateTrade(id: number, updates: Partial<Trade>): Promise<void> {
    return this.adapter.updateTrade(id, updates);
  }

  insertOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    return this.adapter.insertOrder(order);
  }

  getOrdersByTradeId(tradeId: number): Promise<Order[]> {
    return this.adapter.getOrdersByTradeId(tradeId);
  }

  getOrdersByStatus(status: Order['status']): Promise<Order[]> {
    return this.adapter.getOrdersByStatus(status);
  }

  updateOrder(id: number, updates: Partial<Order>): Promise<void> {
    return this.adapter.updateOrder(id, updates);
  }

  insertEvaluationResult(result: Omit<EvaluationResultRecord, 'id' | 'created_at'>): Promise<number> {
    return this.adapter.insertEvaluationResult(result);
  }

  getEvaluationResults(channel?: string, propFirmName?: string): Promise<EvaluationResultRecord[]> {
    return this.adapter.getEvaluationResults(channel, propFirmName);
  }

  insertSignalFormat(format: Omit<SignalFormatRecord, 'id' | 'created_at'>): Promise<number> {
    return this.adapter.insertSignalFormat(format);
  }

  getSignalFormats(channel?: string, formatHash?: string): Promise<SignalFormatRecord[]> {
    return this.adapter.getSignalFormats(channel, formatHash);
  }

  updateSignalFormat(id: number, updates: Partial<SignalFormatRecord>): Promise<void> {
    return this.adapter.updateSignalFormat(id, updates);
  }

  close(): Promise<void> {
    return this.adapter.close();
  }
}
