import fs from 'fs-extra';
import { parse } from 'csv-parse/sync';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dayjs from 'dayjs';

interface CSVMessage {
  id: string;
  date: string;
  sender: string;
  message: string;
}

export const startCSVHarvester = async (
  csvPath: string,
  channel: string,
  db: DatabaseManager
): Promise<() => Promise<void>> => {
  logger.info('Starting CSV harvester', { csvPath, channel });

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  // Read and parse CSV file
  // CSV format: id,date,sender,message (no header row)
  const csvContent = await fs.readFile(csvPath, 'utf-8');
  const records: CSVMessage[] = parse(csvContent, {
    columns: ['id', 'date', 'sender', 'message'],
    skip_empty_lines: true,
    trim: true,
    from_line: 1
  }).filter((r: CSVMessage) => {
    // Filter out any rows where id is not numeric (header rows, etc.)
    return r.id && !isNaN(parseInt(r.id, 10));
  });

  logger.info('Loaded messages from CSV', { 
    count: records.length,
    channel 
  });

  // Insert all messages into database
  let insertedCount = 0;
  for (const record of records) {
    try {
      const messageId = parseInt(record.id, 10);
      if (Number.isNaN(messageId)) {
        logger.warn('Invalid message ID in CSV', { id: record.id });
        continue;
      }

      // Parse date
      const messageDate = dayjs(record.date).toISOString();
      if (!dayjs(record.date).isValid()) {
        logger.warn('Invalid date in CSV', { id: record.id, date: record.date });
        continue;
      }

      await db.insertMessage({
        message_id: String(messageId),
        channel: channel,
        content: record.message.trim(),
        sender: record.sender || '',
        date: messageDate
      });
      insertedCount++;
    } catch (error) {
      if (error instanceof Error && !error.message.includes('UNIQUE constraint')) {
        logger.warn('Failed to insert message from CSV', {
          id: record.id,
          error: error.message
        });
      }
    }
  }

  logger.info('CSV harvester completed', {
    channel,
    total: records.length,
    inserted: insertedCount
  });

  // Return stop function (no-op for CSV harvester)
  return async (): Promise<void> => {
    logger.info('Stopping CSV harvester', { channel });
  };
};

