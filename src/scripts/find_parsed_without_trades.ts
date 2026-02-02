#!/usr/bin/env tsx
/**
 * Find messages that are marked as parsed but have no trades
 * This helps identify messages that failed during trade creation
 */

import { DatabaseManager } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const envInvestigationPath = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');

if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

async function main() {
  const db = new DatabaseManager();
  await db.initialize();

  try {
    // Get all parsed messages
    const channels = ['2427485240', '3241720654', '2394142145'];
    const results: Array<{
      messageId: string;
      channel: string;
      date: string;
      content: string;
      tradingPair?: string;
    }> = [];

    for (const channel of channels) {
      // Get all messages for this channel
      const messages = await db.getMessagesByChannel(channel);
      
      for (const message of messages) {
        // Check if message is parsed
        if (message.parsed) {
          // Check if there are any trades for this message
          const trades = await db.getTradesByMessageId(message.message_id, channel);
          
          if (trades.length === 0) {
            // Try to extract trading pair from content for display
            const tradingPairMatch = message.content.match(/#([A-Z0-9]+)(?:\/USDT|USDT)/i);
            const tradingPair = tradingPairMatch ? tradingPairMatch[1].toUpperCase() : undefined;
            
            results.push({
              messageId: message.message_id,
              channel,
              date: message.date,
              content: message.content.substring(0, 100) + '...',
              tradingPair
            });
          }
        }
      }
    }

    console.log(`\nFound ${results.length} parsed messages without trades:\n`);
    console.log('─'.repeat(80));
    
    // Group by trading pair if available
    const byTradingPair = new Map<string, number>();
    results.forEach(r => {
      if (r.tradingPair) {
        byTradingPair.set(r.tradingPair, (byTradingPair.get(r.tradingPair) || 0) + 1);
      }
    });

    if (byTradingPair.size > 0) {
      console.log('\nBy Trading Pair:');
      const sortedPairs = Array.from(byTradingPair.entries()).sort((a, b) => b[1] - a[1]);
      sortedPairs.forEach(([pair, count]) => {
        console.log(`  ${pair}: ${count} message(s)`);
      });
      console.log('');
    }

    // Show first 20 messages
    console.log('\nFirst 20 messages:');
    results.slice(0, 20).forEach((r, i) => {
      console.log(`\n${i + 1}. Message ${r.messageId} (Channel: ${r.channel})`);
      console.log(`   Date: ${r.date}`);
      if (r.tradingPair) {
        console.log(`   Trading Pair: ${r.tradingPair}`);
      }
      console.log(`   Content: ${r.content}`);
    });

    if (results.length > 20) {
      console.log(`\n... and ${results.length - 20} more`);
    }

    console.log('\n' + '─'.repeat(80));
    console.log(`\nTotal: ${results.length} parsed messages without trades`);
    console.log('\nTo investigate a specific message:');
    console.log('  npm run investigate -- "/trace message:<id> channel:<channel>"');
    
  } catch (error) {
    logger.error('Error finding parsed messages without trades', {
      error: error instanceof Error ? error.message : String(error)
    });
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();

