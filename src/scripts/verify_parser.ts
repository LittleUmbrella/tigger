#!/usr/bin/env node
/**
 * Verify parser against signal formats in evaluation database for a given channel
 * Logs any formats that don't produce a valid ParsedOrder
 */

import 'dotenv/config';
import { Command } from 'commander';
import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { vipCryptoSignals } from '../parsers/channels/2427485240/vip-future.js';
import { ParsedOrder } from '../types/order.js';

const program = new Command();

program
  .name('verify-parser')
  .description('Verify parser against signal formats in evaluation database')
  .requiredOption('-c, --channel <channel>', 'Channel ID to verify (e.g., 2427485240)')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)', 'data/evaluation.db')
  .option('--db-type <type>', 'Database type: sqlite or postgresql', 'sqlite')
  .option('--classification <type>', 'Filter by classification: signal or management (default: signal)', 'signal')
  .action(async (options) => {
    try {
      const db = new DatabaseManager({
        type: options.dbType,
        path: options.dbType === 'sqlite' ? options.dbPath : undefined,
        url: options.dbType === 'postgresql' ? options.dbPath : undefined,
      });
      await db.initialize();

      const channel = options.channel;
      const classification = options.classification;

      logger.info('Starting parser verification', { channel, classification });

      // Query signal formats for the channel
      const allFormats = await db.getSignalFormats(channel);
      
      // Filter by classification if specified
      const formats = classification 
        ? allFormats.filter(f => f.classification === classification)
        : allFormats;

      logger.info(`Found ${formats.length} signal formats to verify (${allFormats.length} total)`);

      let successCount = 0;
      let failureCount = 0;
      const failures: Array<{ 
        id: number; 
        format_hash: string; 
        format_pattern: string; 
        classification: string;
        example_count: number;
        error?: string 
      }> = [];

      for (const format of formats) {
        try {
          const result = vipCryptoSignals(format.format_pattern);
          
          if (result === null) {
            failureCount++;
            failures.push({
              id: format.id,
              format_hash: format.format_hash,
              format_pattern: format.format_pattern,
              classification: format.classification,
              example_count: format.example_count,
              error: 'Parser returned null'
            });
            logger.warn('Parser returned null', {
              formatId: format.id,
              formatHash: format.format_hash,
              classification: format.classification,
              exampleCount: format.example_count,
              contentPreview: format.format_pattern.substring(0, 200)
            });
          } else {
            // Validate ParsedOrder structure
            const validationError = validateParsedOrder(result);
            if (validationError) {
              failureCount++;
              failures.push({
                id: format.id,
                format_hash: format.format_hash,
                format_pattern: format.format_pattern,
                classification: format.classification,
                example_count: format.example_count,
                error: validationError
              });
              logger.warn('Invalid ParsedOrder structure', {
                formatId: format.id,
                formatHash: format.format_hash,
                classification: format.classification,
                error: validationError,
                result
              });
            } else {
              successCount++;
            }
          }
        } catch (error) {
          failureCount++;
          failures.push({
            id: format.id,
            format_hash: format.format_hash,
            format_pattern: format.format_pattern,
            classification: format.classification,
            example_count: format.example_count,
            error: error instanceof Error ? error.message : String(error)
          });
          logger.error('Parser threw error', {
            formatId: format.id,
            formatHash: format.format_hash,
            classification: format.classification,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          });
        }
      }

      // Summary
      console.log('\n' + '='.repeat(80));
      console.log('PARSER VERIFICATION SUMMARY');
      console.log('='.repeat(80));
      console.log(`Channel: ${channel}`);
      console.log(`Classification: ${classification || 'all'}`);
      console.log(`Total formats checked: ${formats.length}`);
      console.log(`Successful parses: ${successCount} (${formats.length > 0 ? ((successCount / formats.length) * 100).toFixed(2) : 0}%)`);
      console.log(`Failed parses: ${failureCount} (${formats.length > 0 ? ((failureCount / formats.length) * 100).toFixed(2) : 0}%)`);
      
      if (failures.length > 0) {
        const totalExamples = failures.reduce((sum, f) => sum + f.example_count, 0);
        console.log(`Total example messages affected: ${totalExamples}`);
      }
      console.log('='.repeat(80));

      if (failures.length > 0) {
        console.log('\nFAILED FORMATS:');
        console.log('-'.repeat(80));
        failures.forEach((failure, index) => {
          console.log(`\n[${index + 1}] Format ID: ${failure.id}`);
          console.log(`Hash: ${failure.format_hash}`);
          console.log(`Classification: ${failure.classification}`);
          console.log(`Example Count: ${failure.example_count}`);
          console.log(`Error: ${failure.error}`);
          console.log(`Format Pattern: ${failure.format_pattern.substring(0, 300)}${failure.format_pattern.length > 300 ? '...' : ''}`);
        });
        console.log('\n' + '-'.repeat(80));
      }

      await db.close();
      process.exit(failureCount > 0 ? 1 : 0);
    } catch (error) {
      console.error('❌ Verification failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

/**
 * Validate that a ParsedOrder has all required fields with valid values
 */
function validateParsedOrder(order: ParsedOrder): string | null {
  if (!order.tradingPair || typeof order.tradingPair !== 'string' || order.tradingPair.trim() === '') {
    return 'Missing or invalid tradingPair';
  }

  if (typeof order.leverage !== 'number' || order.leverage < 1) {
    return `Invalid leverage: ${order.leverage}`;
  }

  // entryPrice is optional (for market orders), but if present must be a number
  if (order.entryPrice !== undefined && (typeof order.entryPrice !== 'number' || order.entryPrice <= 0)) {
    return `Invalid entryPrice: ${order.entryPrice}`;
  }

  if (typeof order.stopLoss !== 'number' || order.stopLoss <= 0) {
    return `Invalid stopLoss: ${order.stopLoss}`;
  }

  if (!Array.isArray(order.takeProfits) || order.takeProfits.length === 0) {
    return 'Missing or empty takeProfits array';
  }

  for (const tp of order.takeProfits) {
    if (typeof tp !== 'number' || tp <= 0) {
      return `Invalid takeProfit value: ${tp}`;
    }
  }

  if (order.signalType !== 'long' && order.signalType !== 'short') {
    return `Invalid signalType: ${order.signalType}`;
  }

  return null;
}

program.parse(process.argv);

