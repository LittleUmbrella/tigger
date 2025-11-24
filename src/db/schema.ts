import Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export interface Message {
  id: number;
  message_id: number;
  channel: string;
  content: string;
  sender: string;
  date: string;
  created_at: string;
  parsed: boolean;
}

export interface Trade {
  id: number;
  message_id: number;
  channel: string;
  trading_pair: string;
  leverage: number;
  entry_price: number;
  stop_loss: number;
  take_profits: string; // JSON array of numbers
  risk_percentage: number;
  exchange: string;
  order_id?: string;
  position_id?: string; // Bybit position ID after entry is filled
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

export class DatabaseManager {
  private db: Database.Database;

  constructor(dbPath: string = 'data/trading_bot.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
    logger.info('Database initialized', { dbPath });
  }

  private initializeSchema() {
    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        content TEXT NOT NULL,
        sender TEXT,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        parsed BOOLEAN NOT NULL DEFAULT 0,
        UNIQUE(message_id, channel)
      )
    `);

    // Trades table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        trading_pair TEXT NOT NULL,
        leverage INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profits TEXT NOT NULL,
        risk_percentage REAL NOT NULL,
        exchange TEXT NOT NULL,
        order_id TEXT,
        position_id TEXT,
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

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_parsed ON messages(channel, parsed);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_channel ON trades(channel);
    `);
  }

  insertMessage(message: Omit<Message, 'id' | 'created_at' | 'parsed'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO messages (message_id, channel, content, sender, date, created_at, parsed)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
    `);
    const result = stmt.run(
      message.message_id,
      message.channel,
      message.content,
      message.sender || null,
      message.date
    );
    return result.lastInsertRowid as number;
  }

  getUnparsedMessages(channel?: string): Message[] {
    const stmt = channel
      ? this.db.prepare('SELECT * FROM messages WHERE parsed = 0 AND channel = ? ORDER BY id ASC')
      : this.db.prepare('SELECT * FROM messages WHERE parsed = 0 ORDER BY id ASC');
    return (channel ? stmt.all(channel) : stmt.all()) as Message[];
  }

  markMessageParsed(id: number) {
    const stmt = this.db.prepare('UPDATE messages SET parsed = 1 WHERE id = ?');
    stmt.run(id);
  }

  insertTrade(trade: Omit<Trade, 'id' | 'created_at' | 'updated_at'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        message_id, channel, trading_pair, leverage, entry_price, stop_loss,
        take_profits, risk_percentage, exchange, order_id, position_id, status,
        entry_filled_at, exit_price, exit_filled_at, pnl, pnl_percentage,
        stop_loss_breakeven, expires_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const result = stmt.run(
      trade.message_id,
      trade.channel,
      trade.trading_pair,
      trade.leverage,
      trade.entry_price,
      trade.stop_loss,
      trade.take_profits,
      trade.risk_percentage,
      trade.exchange,
      trade.order_id || null,
      trade.position_id || null,
      trade.status,
      trade.entry_filled_at || null,
      trade.exit_price || null,
      trade.exit_filled_at || null,
      trade.pnl || null,
      trade.pnl_percentage || null,
      trade.stop_loss_breakeven ? 1 : 0,
      trade.expires_at
    );
    return result.lastInsertRowid as number;
  }

  getActiveTrades(): Trade[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      WHERE status IN ('pending', 'active', 'filled')
      ORDER BY created_at ASC
    `);
    return stmt.all() as Trade[];
  }

  getClosedTrades(): Trade[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      WHERE status IN ('closed', 'stopped', 'cancelled', 'completed')
      ORDER BY exit_filled_at DESC
    `);
    return stmt.all() as Trade[];
  }

  getTradesByStatus(status: Trade['status']): Trade[] {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY created_at ASC');
    return stmt.all(status) as Trade[];
  }

  updateTrade(id: number, updates: Partial<Trade>) {
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

  close() {
    this.db.close();
  }
}

