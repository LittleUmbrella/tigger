import { DatabaseManager } from '../../db/schema.js';
import path from 'path';
import fs from 'fs-extra';

/**
 * Create a test database in memory or temporary file
 */
export async function createTestDatabase(inMemory: boolean = true): Promise<DatabaseManager> {
  let db: DatabaseManager;
  if (inMemory) {
    // Use in-memory database
    db = new DatabaseManager({ type: 'sqlite', path: ':memory:' });
  } else {
    // Use temporary file
    const tempDir = path.join(process.cwd(), '.test-temp');
    fs.ensureDirSync(tempDir);
    const dbPath = path.join(tempDir, `test-${Date.now()}.db`);
    db = new DatabaseManager({ type: 'sqlite', path: dbPath });
  }
  await db.initialize();
  return db;
}

/**
 * Clean up test database
 */
export async function cleanupTestDatabase(db: DatabaseManager) {
  try {
    await db.close();
  } catch (error) {
    // Ignore cleanup errors
  }
}

/**
 * Create a complete mock context for testing
 */
export function createMockInitiatorContext(overrides: any = {}) {
  return {
    channel: 'test_channel',
    riskPercentage: 3,
    entryTimeoutMinutes: 2880, // 2 days = 2880 minutes
    message: {
      id: 1,
      message_id: '12345',
      channel: 'test_channel',
      content: 'Test message',
      sender: 'test_sender',
      date: '2024-01-15T10:00:00Z',
      created_at: '2024-01-15T10:00:00Z',
      parsed: false,
    },
    order: {
      tradingPair: 'BTC/USDT',
      leverage: 10,
      entryPrice: 50000,
      stopLoss: 48000,
      takeProfits: [52000, 54000, 56000],
      signalType: 'long' as const,
    },
    db: {} as DatabaseManager,
    isSimulation: true,
    config: {
      name: 'bybit',
      riskPercentage: 3,
      testnet: false,
    },
    ...overrides,
  };
}



