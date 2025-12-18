#!/usr/bin/env node
/**
 * Export messages from database to CSV
 * 
 * Usage:
 *   npm run export-messages [options]
 *   tsx src/scripts/export_messages.ts [options]
 */

import 'dotenv/config';
import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { logger } from '../utils/logger.js';

const program = new Command();

// Helper function to log all options
const logOptions = (commandName: string, options: any) => {
  logger.info('Command options', {
    command: commandName,
    options: JSON.parse(JSON.stringify(options, (key, value) => {
      // Handle undefined values
      if (value === undefined) return undefined;
      return value;
    }))
  });
};

program
  .name('export-messages')
  .description('Export messages from database to CSV')
  .version('1.0.0')
  .option('-c, --channel <channel>', 'Filter by channel name')
  .option('-s, --start-date <date>', 'Start date (YYYY-MM-DD or ISO format)')
  .option('-e, --end-date <date>', 'End date (YYYY-MM-DD or ISO format)')
  .option('-o, --output <path>', 'Output CSV file path', 'data/messages_export.csv')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)', 'data/trading_bot.db')
  .option('--db-type <type>', 'Database type: sqlite or postgresql', 'sqlite')
  .option('--parsed-only', 'Only export parsed messages')
  .option('--unparsed-only', 'Only export unparsed messages')
  .action(async (options) => {
    logOptions('export-messages', options);
    try {
      // Build query conditions
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (options.channel) {
        if (options.dbType === 'sqlite') {
          conditions.push('channel = ?');
          params.push(options.channel);
        } else {
          conditions.push(`channel = $${paramIndex}`);
          params.push(options.channel);
          paramIndex++;
        }
      }

      if (options.startDate) {
        if (options.dbType === 'sqlite') {
          conditions.push('date >= ?');
          params.push(options.startDate);
        } else {
          conditions.push(`date >= $${paramIndex}`);
          params.push(options.startDate);
          paramIndex++;
        }
      }

      if (options.endDate) {
        if (options.dbType === 'sqlite') {
          conditions.push('date <= ?');
          params.push(options.endDate);
        } else {
          conditions.push(`date <= $${paramIndex}`);
          params.push(options.endDate);
          paramIndex++;
        }
      }

      if (options.parsedOnly) {
        conditions.push('parsed = 1');
      } else if (options.unparsedOnly) {
        conditions.push('parsed = 0');
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const query = `SELECT * FROM messages ${whereClause} ORDER BY date ASC, id ASC`;

      // Get messages from database
      let messages: any[];
      
      if (options.dbType === 'sqlite') {
        const db = new Database(options.dbPath);
        const stmt = db.prepare(query);
        messages = stmt.all(...params) as any[];
        db.close();
      } else {
        // PostgreSQL
        const pool = new Pool({ connectionString: options.dbPath });
        const result = await pool.query(query, params);
        messages = result.rows;
        await pool.end();
      }

      if (messages.length === 0) {
        console.log('No messages found matching the criteria.');
        process.exit(0);
      }

      // CSV headers
      const headers = [
        'id',
        'message_id',
        'channel',
        'content',
        'sender',
        'date',
        'created_at',
        'parsed',
        'reply_to_message_id',
        'old_content',
        'edited_at',
        'image_paths'
      ];

      // Escape CSV values
      const escapeCsv = (value: any): string => {
        if (value === null || value === undefined) {
          return '';
        }
        const str = String(value);
        // If contains comma, quote, or newline, wrap in quotes and escape quotes
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      // Generate CSV content
      const csvLines: string[] = [];
      
      // Add header row
      csvLines.push(headers.map(escapeCsv).join(','));

      // Add data rows
      for (const msg of messages) {
        const row = [
          msg.id,
          msg.message_id,
          msg.channel,
          msg.content,
          msg.sender,
          msg.date,
          msg.created_at,
          msg.parsed ? '1' : '0',
          msg.reply_to_message_id || '',
          msg.old_content || '',
          msg.edited_at || '',
          msg.image_paths || ''
        ];
        csvLines.push(row.map(escapeCsv).join(','));
      }

      // Write to file
      const outputPath = path.resolve(options.output);
      await writeFile(outputPath, csvLines.join('\n'), 'utf-8');

      console.log(`\n✅ Exported ${messages.length} messages to: ${outputPath}\n`);
      console.log(`   Channel filter: ${options.channel || 'all'}`);
      console.log(`   Date range: ${options.startDate || 'start'} to ${options.endDate || 'end'}`);
      console.log(`   Parsed filter: ${options.parsedOnly ? 'parsed only' : options.unparsedOnly ? 'unparsed only' : 'all'}\n`);

      process.exit(0);
    } catch (error) {
      console.error('❌ Export failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();

