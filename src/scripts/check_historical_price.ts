#!/usr/bin/env tsx
/**
 * Check Historical Price Script
 * 
 * Queries Bybit for historical price data at a specific timestamp
 */

import { createWorkflowContext } from '../investigation/workflowEngine.js';
import { RestClientV5 } from 'bybit-api';
import { getGoldPriceAtTime } from '../utils/goldPriceApi.js';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

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
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: tsx src/scripts/check_historical_price.ts <symbol> <timestamp> [accountName]');
    console.log('\nExample:');
    console.log('  tsx src/scripts/check_historical_price.ts PAXGUSDT "2026-02-02T16:20:23.696Z" demo');
    process.exit(1);
  }

  const [symbol, timestampStr, accountName = 'demo'] = args;
  const messageTime = new Date(timestampStr);

  console.log(`\nChecking historical price for ${symbol}`);
  console.log(`  Timestamp: ${messageTime.toISOString()}`);
  console.log(`  Account: ${accountName}\n`);

  const context = await createWorkflowContext({});
  const client = await context.getBybitClient?.(accountName);

  if (!client) {
    console.error('❌ Failed to create Bybit client. Check API credentials.');
    await context.db.close();
    process.exit(1);
  }

  const baseUrl = (client as any).baseUrl || 'https://api.bybit.com';
  const isDemo = baseUrl.includes('api-demo');
  console.log(`  API Endpoint: ${isDemo ? 'DEMO' : 'LIVE'} (${baseUrl})\n`);

  try {
    // Get klines for the symbol around that time (1-minute candles)
    const endTime = Math.floor(messageTime.getTime() / 1000);
    const startTime = endTime - 600; // 10 minutes before
    
    console.log('📊 Fetching 1-minute candle data...\n');
    
    const klines = await client.getKline({
      category: 'linear',
      symbol: symbol,
      interval: '1', // 1 minute
      start: startTime * 1000,
      end: endTime * 1000,
      limit: 20
    });
    
    // Find the candle that contains the message time (declare outside if block)
    let messageCandle: any = null;
    const messageTimeMs = messageTime.getTime();
    
    if (klines.retCode === 0 && klines.result && klines.result.list) {
      console.log(`Found ${klines.result.list.length} candles:\n`);
      console.log('─'.repeat(100));
      
      klines.result.list.forEach((kline: any, idx: number) => {
        const candleTime = parseInt(kline[0]);
        const open = parseFloat(kline[1]);
        const high = parseFloat(kline[2]);
        const low = parseFloat(kline[3]);
        const close = parseFloat(kline[4]);
        const volume = parseFloat(kline[5]);
        const candleTimeDate = new Date(candleTime);
        
        // Check if this candle contains the message time (1-minute candle)
        const candleEndTime = candleTime + 60000; // 1 minute later
        if (messageTimeMs >= candleTime && messageTimeMs < candleEndTime) {
          messageCandle = kline;
          console.log(`⭐ CANDLE CONTAINING MESSAGE TIME:`);
        }
        
        console.log(`${idx + 1}. Time: ${candleTimeDate.toISOString()}`);
        console.log(`   Open: ${open.toFixed(2)}, High: ${high.toFixed(2)}, Low: ${low.toFixed(2)}, Close: ${close.toFixed(2)}`);
        console.log(`   Volume: ${volume}`);
        
        if (messageCandle === kline) {
          console.log(`   ⚠️  Message arrived during this candle`);
        }
        console.log('');
      });
      
      console.log('─'.repeat(100));
      
      if (messageCandle) {
        const open = parseFloat(messageCandle[1]);
        const high = parseFloat(messageCandle[2]);
        const low = parseFloat(messageCandle[3]);
        const close = parseFloat(messageCandle[4]);
        
        console.log('\n📈 Price at message time (estimated from candle):');
        console.log(`   Open: ${open.toFixed(2)}`);
        console.log(`   High: ${high.toFixed(2)}`);
        console.log(`   Low: ${low.toFixed(2)}`);
        console.log(`   Close: ${close.toFixed(2)}`);
        console.log(`   Range: ${low.toFixed(2)} - ${high.toFixed(2)}`);
        console.log(`   \n   Note: Actual price at exact message time may vary within this range`);
      } else {
        console.log('\n⚠️  Could not find exact candle for message time');
        if (klines.result.list.length > 0) {
          const lastCandle = klines.result.list[klines.result.list.length - 1];
          const close = parseFloat(lastCandle[4]);
          console.log(`   Closest candle close price: ${close.toFixed(2)}`);
        }
      }
    } else {
      console.log('❌ Could not get kline data:', klines.retMsg || 'Unknown error');
      console.log('   Response:', JSON.stringify(klines, null, 2));
    }
    
    // Also get current ticker for reference
    console.log('\n📊 Current price (for reference):');
    const ticker = await client.getTickers({ category: 'linear', symbol: symbol });
    if (ticker.retCode === 0 && ticker.result && ticker.result.list && ticker.result.list.length > 0) {
      const t = ticker.result.list[0];
      console.log(`   Last Price: ${t.lastPrice}`);
      console.log(`   Mark Price: ${t.markPrice || 'N/A'}`);
      console.log(`   Index Price: ${t.indexPrice || 'N/A'}`);
    }
    
    // For PAXG, also fetch actual gold price for comparison
    if (symbol.toUpperCase() === 'PAXGUSDT' || symbol.toUpperCase().includes('PAXG')) {
      console.log('\n🥇 Fetching actual gold (XAU/USD) price...');
      try {
        const goldPrice = await getGoldPriceAtTime(messageTime);
        if (goldPrice) {
          console.log(`\n📊 Gold Price (XAU/USD) at message time:`);
          console.log(`   Price: $${goldPrice.price.toFixed(2)} ${goldPrice.unit}`);
          console.log(`   Source: ${goldPrice.source}`);
          console.log(`   Timestamp: ${goldPrice.timestamp}`);
          
          // Compare with PAXG price if we have it
          if (messageCandle) {
            const paxgPrice = parseFloat(messageCandle[4]); // Close price
            const difference = paxgPrice - goldPrice.price;
            const differencePercent = (difference / goldPrice.price) * 100;
            console.log(`\n📈 PAXG vs Gold Comparison:`);
            console.log(`   PAXG Price: $${paxgPrice.toFixed(2)}`);
            console.log(`   Gold Price: $${goldPrice.price.toFixed(2)}`);
            console.log(`   Difference: $${difference.toFixed(2)} (${differencePercent > 0 ? '+' : ''}${differencePercent.toFixed(3)}%)`);
            
            if (Math.abs(differencePercent) > 1) {
              console.log(`   ⚠️  Significant difference - PAXG may have premium/discount`);
            } else {
              console.log(`   ✅ Prices closely aligned (expected for gold-backed token)`);
            }
          }
        } else {
          console.log('   ⚠️  Could not fetch gold price from external APIs');
          console.log('   (Gold price analysis skipped - no external data source available)');
        }
      } catch (error) {
        console.log(`   ⚠️  Error fetching gold price: ${error instanceof Error ? error.message : String(error)}`);
        console.log('   (Gold price analysis skipped due to error)');
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    if (error && typeof error === 'object') {
      console.error('Error details:', JSON.stringify(error, null, 2));
    }
    process.exit(1);
  } finally {
    await context.db.close();
  }
}

main().catch(console.error);

