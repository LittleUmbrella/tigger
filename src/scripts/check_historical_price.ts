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
    // Fetch actual trades for the most accurate price data
    const messageTimeMs = messageTime.getTime();
    const endTime = Math.floor(messageTimeMs / 1000);
    const startTime = endTime - 600; // 10 minutes before
    
    console.log('📊 Fetching actual trade data (authenticated API)...\n');
    
    // Helper function to fetch trades using authenticated API (mimicking historicalPriceProvider.ts)
    const fetchTrades = async (symbolToFetch: string): Promise<Array<{time: number, price: number, size: number, side: string}>> => {
      const trades: Array<{time: number, price: number, size: number, side: string}> = [];
      
      // First try authenticated execution history (most accurate, like historicalPriceProvider.ts)
      try {
        const windowSize = 24 * 60 * 60 * 1000; // 24 hours
        let execStart = startTime * 1000;
        const now = Date.now();
        const cappedEndTimestamp = Math.min(messageTimeMs + 60000, now);
        
        while (execStart < cappedEndTimestamp) {
          const execEnd = Math.min(execStart + windowSize, cappedEndTimestamp);
          
          if (execStart > now || execEnd > now) {
            execStart = execEnd + 1;
            continue;
          }
          
          try {
            const executionResponse = await client.getExecutionList({
              category: 'linear',
              symbol: symbolToFetch,
              startTime: execStart,
              endTime: execEnd,
              limit: 1000
            });
            
            if (executionResponse.retCode === 0 && executionResponse.result?.list) {
              const validTrades = executionResponse.result.list.filter((execution: any) => {
                const execTime = parseFloat((execution.execTime || '0') as string);
                const execPrice = parseFloat((execution.execPrice || '0') as string);
                return execPrice > 0 && execTime >= startTime * 1000 && execTime <= messageTimeMs + 60000;
              });
              
              for (const execution of validTrades) {
                const execTime = parseFloat((execution.execTime || '0') as string);
                const execPrice = parseFloat((execution.execPrice || '0') as string);
                const execSize = parseFloat((execution.execQty || '0') as string);
                const execSide = execution.side || '';
                
                trades.push({ 
                  time: execTime, 
                  price: execPrice, 
                  size: execSize, 
                  side: execSide 
                });
              }
            }
          } catch (error) {
            // Continue to next window or fallback methods
            console.log(`   ⚠️  Execution history failed for window: ${error instanceof Error ? error.message : String(error)}`);
          }
          
          execStart = execEnd + 1;
        }
        
        if (trades.length > 0) {
          console.log(`   ✅ Using authenticated execution history (${trades.length} trades)`);
          return trades.sort((a, b) => a.time - b.time);
        }
      } catch (error) {
        console.log(`   ⚠️  Execution history not available: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Fallback to public trade endpoints (like historicalPriceProvider.ts)
      const clientAny = client as any;
      let tradeResponse: any = null;
      let methodUsed = '';
      
      // Try public trade endpoints (for recent data only)
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      const isRecentData = messageTimeMs >= oneDayAgo && messageTimeMs <= Date.now();
      
      if (isRecentData) {
        if (typeof clientAny.getPublicTradeHistory === 'function') {
          methodUsed = 'getPublicTradeHistory';
          try {
            tradeResponse = await clientAny.getPublicTradeHistory({
              category: 'linear',
              symbol: symbolToFetch,
              limit: 1000
            });
          } catch (error) {
            // Try next method
          }
        }
        
        if (!tradeResponse && typeof clientAny.getMarketTrades === 'function') {
          methodUsed = 'getMarketTrades';
          try {
            tradeResponse = await clientAny.getMarketTrades({
              category: 'linear',
              symbol: symbolToFetch,
              limit: 1000
            });
          } catch (error) {
            // Try next method
          }
        }
        
        if (!tradeResponse && typeof clientAny.getRecentTrades === 'function') {
          methodUsed = 'getRecentTrades';
          try {
            tradeResponse = await clientAny.getRecentTrades({
              category: 'linear',
              symbol: symbolToFetch,
              limit: 1000
            });
          } catch (error) {
            // No more methods to try
          }
        }
        
        if (tradeResponse && tradeResponse.retCode === 0 && tradeResponse.result?.list) {
          for (const trade of tradeResponse.result.list) {
            let tradeTime: number;
            let tradePrice: number;
            let tradeSize: number = 0;
            let tradeSide: string = '';
            
            if (Array.isArray(trade)) {
              // Array format: [time, symbol, side, size, price, ...]
              tradeTime = parseFloat(trade[0] || '0');
              tradePrice = parseFloat(trade[4] || trade[3] || '0');
              tradeSize = parseFloat(trade[3] || '0');
              tradeSide = trade[2] || '';
            } else {
              // Object format: {time, price, ...}
              tradeTime = parseFloat((trade.time || trade.execTime || trade.exec_time || '0') as string);
              tradePrice = parseFloat((trade.price || trade.execPrice || trade.exec_price || '0') as string);
              tradeSize = parseFloat((trade.size || trade.qty || trade.quantity || '0') as string);
              tradeSide = trade.side || '';
            }
            
            // Filter trades within our time window
            if (tradePrice > 0 && tradeTime >= startTime * 1000 && tradeTime <= messageTimeMs + 60000) {
              trades.push({ time: tradeTime, price: tradePrice, size: tradeSize, side: tradeSide });
            }
          }
          
          if (trades.length > 0) {
            console.log(`   ✅ Using public trade data via ${methodUsed} (${trades.length} trades)`);
            return trades.sort((a, b) => a.time - b.time);
          }
        }
      }
      
      return trades.sort((a, b) => a.time - b.time);
    };
    
    const trades = await fetchTrades(symbol);
    
    // Find the trade closest to the message time
    let closestTrade: {time: number, price: number, size: number, side: string} | null = null;
    let minTimeDiff = Infinity;
    
    for (const trade of trades) {
      const timeDiff = Math.abs(trade.time - messageTimeMs);
      if (timeDiff < minTimeDiff) {
        minTimeDiff = timeDiff;
        closestTrade = trade;
      }
    }
    
    // Also get trades before and after for context
    const tradesBefore = trades.filter(t => t.time <= messageTimeMs).slice(-10);
    const tradesAfter = trades.filter(t => t.time > messageTimeMs).slice(0, 10);
    
    console.log(`Found ${trades.length} trades in time window:\n`);
    console.log('─'.repeat(100));
    
    if (trades.length > 0) {
      // Show recent trades before message time
      if (tradesBefore.length > 0) {
        console.log('📉 Recent trades BEFORE message time:');
        tradesBefore.slice(-5).forEach((trade, idx) => {
          const tradeDate = new Date(trade.time);
          const timeDiff = (messageTimeMs - trade.time) / 1000;
          console.log(`   ${tradeDate.toISOString()} | Price: $${trade.price.toFixed(2)} | Size: ${trade.size} | Side: ${trade.side} | ${timeDiff.toFixed(1)}s before`);
        });
        console.log('');
      }
      
      if (closestTrade) {
        const closestTradeDate = new Date(closestTrade.time);
        const timeDiff = (messageTimeMs - closestTrade.time) / 1000;
        console.log(`⭐ CLOSEST TRADE TO MESSAGE TIME:`);
        console.log(`   Time: ${closestTradeDate.toISOString()}`);
        console.log(`   Price: $${closestTrade.price.toFixed(2)}`);
        console.log(`   Size: ${closestTrade.size}`);
        console.log(`   Side: ${closestTrade.side}`);
        console.log(`   Time difference: ${Math.abs(timeDiff).toFixed(1)}s ${timeDiff >= 0 ? 'before' : 'after'} message`);
        console.log('');
      }
      
      // Show trades after message time
      if (tradesAfter.length > 0) {
        console.log('📈 Trades AFTER message time:');
        tradesAfter.slice(0, 5).forEach((trade, idx) => {
          const tradeDate = new Date(trade.time);
          const timeDiff = (trade.time - messageTimeMs) / 1000;
          console.log(`   ${tradeDate.toISOString()} | Price: $${trade.price.toFixed(2)} | Size: ${trade.size} | Side: ${trade.side} | ${timeDiff.toFixed(1)}s after`);
        });
        console.log('');
      }
      
      console.log('─'.repeat(100));
      
      if (closestTrade) {
        // Calculate price statistics from trades around the message time
        const windowTrades = trades.filter(t => Math.abs(t.time - messageTimeMs) <= 60000); // 1 minute window
        const prices = windowTrades.map(t => t.price);
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        
        console.log('\n📈 Price at message time (from actual trades):');
        console.log(`   Exact Trade Price: $${closestTrade.price.toFixed(2)}`);
        if (windowTrades.length > 1) {
          console.log(`   Price Range (±1min): $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`);
          console.log(`   Average Price (±1min): $${avgPrice.toFixed(2)}`);
          console.log(`   Trades in window: ${windowTrades.length}`);
        }
        console.log(`   \n   ✅ Using actual executed trade data (most accurate)`);
      } else {
        console.log('\n⚠️  Could not find trades near message time');
        if (trades.length > 0) {
          const lastTrade = trades[trades.length - 1];
          const timeDiff = (messageTimeMs - lastTrade.time) / 1000;
          console.log(`   Closest trade: $${lastTrade.price.toFixed(2)} at ${new Date(lastTrade.time).toISOString()} (${Math.abs(timeDiff).toFixed(1)}s away)`);
        }
      }
    } else {
      console.log('⚠️  No trades found in time window, falling back to kline data...\n');
      // Fallback to klines if no trades available
      const klines = await client.getKline({
        category: 'linear',
        symbol: symbol,
        interval: '1', // 1 minute
        start: startTime * 1000,
        end: endTime * 1000,
        limit: 20
      });
      
      if (klines.retCode === 0 && klines.result && klines.result.list) {
        // Find the candle that contains the message time
        for (const kline of klines.result.list) {
          const candleTime = parseInt(kline[0]);
          const candleEndTime = candleTime + 60000; // 1 minute later
          if (messageTimeMs >= candleTime && messageTimeMs < candleEndTime) {
            const close = parseFloat(kline[4]);
            console.log(`   Using kline close price: $${close.toFixed(2)}`);
            console.log(`   ⚠️  Note: This is candle data, not actual trade execution`);
            closestTrade = { time: candleTime, price: close, size: 0, side: '' };
            break;
          }
        }
        
        // If exact candle not found, use closest one
        if (!closestTrade && klines.result.list.length > 0) {
          const lastCandle = klines.result.list[klines.result.list.length - 1];
          const close = parseFloat(lastCandle[4]);
          const candleTime = parseInt(lastCandle[0]);
          console.log(`   Using closest kline close price: $${close.toFixed(2)}`);
          console.log(`   ⚠️  Note: This is candle data, not actual trade execution`);
          closestTrade = { time: candleTime, price: close, size: 0, side: '' };
        }
      } else {
        // Final fallback to ticker
        console.log('⚠️  No kline data available, using current ticker...\n');
        const ticker = await client.getTickers({ category: 'linear', symbol: symbol });
        if (ticker.retCode === 0 && ticker.result && ticker.result.list && ticker.result.list.length > 0) {
          const t = ticker.result.list[0];
          console.log(`   Last Price: $${t.lastPrice}`);
          console.log(`   ⚠️  Note: This is current price, not historical price at message time`);
        }
      }
    }
    
    // Store closest trade price for later use
    const messagePrice = closestTrade ? closestTrade.price : null;
    
    // Also get current ticker for reference
    console.log('\n📊 Current price (for reference):');
    const ticker = await client.getTickers({ category: 'linear', symbol: symbol });
    if (ticker.retCode === 0 && ticker.result && ticker.result.list && ticker.result.list.length > 0) {
      const t = ticker.result.list[0];
      console.log(`   Last Price: ${t.lastPrice}`);
      console.log(`   Mark Price: ${t.markPrice || 'N/A'}`);
      console.log(`   Index Price: ${t.indexPrice || 'N/A'}`);
    }
    
    // For PAXG, also fetch actual gold price and XAUT for comparison
    if (symbol.toUpperCase() === 'PAXGUSDT' || symbol.toUpperCase().includes('PAXG')) {
      console.log('\n🥇 Fetching actual gold (XAU/USD) price and XAUT comparison...');
      
      let goldPrice: any = null;
      let xautPrice: number | null = null;
      
      // Fetch gold price
      try {
        goldPrice = await getGoldPriceAtTime(messageTime);
        if (goldPrice) {
          console.log(`\n📊 Gold Price (XAU/USD) at message time:`);
          console.log(`   Price: $${goldPrice.price.toFixed(2)} ${goldPrice.unit}`);
          console.log(`   Source: ${goldPrice.source}`);
          console.log(`   Timestamp: ${goldPrice.timestamp}`);
        } else {
          console.log('   ⚠️  Could not fetch gold price from external APIs');
        }
      } catch (error) {
        console.log(`   ⚠️  Error fetching gold price: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Fetch XAUT price at the same time using actual trades (with kline fallback)
      try {
        console.log('\n💎 Fetching XAUT price from actual trades...');
        const xautTrades = await fetchTrades('XAUTUSDT');
        
        if (xautTrades.length > 0) {
          // Find the trade closest to the message time
          let closestXautTrade: {time: number, price: number} | null = null;
          let minXautTimeDiff = Infinity;
          
          for (const trade of xautTrades) {
            const timeDiff = Math.abs(trade.time - messageTimeMs);
            if (timeDiff < minXautTimeDiff) {
              minXautTimeDiff = timeDiff;
              closestXautTrade = trade;
            }
          }
          
          if (closestXautTrade) {
            xautPrice = closestXautTrade.price;
            const timeDiff = (messageTimeMs - closestXautTrade.time) / 1000;
            console.log(`   XAUT Price: $${xautPrice.toFixed(2)}`);
            console.log(`   Trade time: ${new Date(closestXautTrade.time).toISOString()} (${Math.abs(timeDiff).toFixed(1)}s ${timeDiff >= 0 ? 'before' : 'after'} message)`);
          }
        }
        
        // Fallback to klines if no trades found
        if (!xautPrice) {
          console.log('   ⚠️  No XAUT trades found, using kline data...');
          const xautKlines = await client.getKline({
            category: 'linear',
            symbol: 'XAUTUSDT',
            interval: '1',
            start: startTime * 1000,
            end: endTime * 1000,
            limit: 20
          });
          
          if (xautKlines.retCode === 0 && xautKlines.result && xautKlines.result.list) {
            for (const kline of xautKlines.result.list) {
              const candleTime = parseInt(kline[0]);
              const candleEndTime = candleTime + 60000;
              if (messageTimeMs >= candleTime && messageTimeMs < candleEndTime) {
                xautPrice = parseFloat(kline[4]);
                console.log(`   XAUT Price (from kline): $${xautPrice.toFixed(2)}`);
                break;
              }
            }
            
            if (!xautPrice && xautKlines.result.list.length > 0) {
              const lastCandle = xautKlines.result.list[xautKlines.result.list.length - 1];
              xautPrice = parseFloat(lastCandle[4]);
              console.log(`   XAUT Price (closest kline): $${xautPrice.toFixed(2)}`);
            }
          }
        }
      } catch (error) {
        console.log(`   ⚠️  Error fetching XAUT data: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Compare all three if we have the data
      if (messagePrice !== null) {
        const paxgPrice = messagePrice;
        
        console.log(`\n📈 Gold-Backed Token Comparison:`);
        console.log('─'.repeat(80));
        
        const prices: Array<{name: string, price: number}> = [];
        if (paxgPrice) prices.push({ name: 'PAXG', price: paxgPrice });
        if (xautPrice) prices.push({ name: 'XAUT', price: xautPrice });
        if (goldPrice) prices.push({ name: 'Gold (XAU/USD)', price: goldPrice.price });
        
        // Display prices
        prices.forEach(p => {
          console.log(`   ${p.name.padEnd(20)}: $${p.price.toFixed(2)}`);
        });
        
        console.log('─'.repeat(80));
        
        // Calculate differences
        if (goldPrice && paxgPrice) {
          const paxgDiff = paxgPrice - goldPrice.price;
          const paxgDiffPercent = (paxgDiff / goldPrice.price) * 100;
          console.log(`\n   PAXG vs Gold:`);
          console.log(`      Difference: $${paxgDiff.toFixed(2)} (${paxgDiffPercent > 0 ? '+' : ''}${paxgDiffPercent.toFixed(3)}%)`);
          if (Math.abs(paxgDiffPercent) > 1) {
            console.log(`      ⚠️  Significant difference - PAXG may have premium/discount`);
          } else {
            console.log(`      ✅ Prices closely aligned`);
          }
        }
        
        if (goldPrice && xautPrice) {
          const xautDiff = xautPrice - goldPrice.price;
          const xautDiffPercent = (xautDiff / goldPrice.price) * 100;
          console.log(`\n   XAUT vs Gold:`);
          console.log(`      Difference: $${xautDiff.toFixed(2)} (${xautDiffPercent > 0 ? '+' : ''}${xautDiffPercent.toFixed(3)}%)`);
          if (Math.abs(xautDiffPercent) > 1) {
            console.log(`      ⚠️  Significant difference - XAUT may have premium/discount`);
          } else {
            console.log(`      ✅ Prices closely aligned`);
          }
        }
        
        if (paxgPrice && xautPrice) {
          const paxgXautDiff = paxgPrice - xautPrice;
          const paxgXautDiffPercent = (paxgXautDiff / xautPrice) * 100;
          console.log(`\n   PAXG vs XAUT:`);
          console.log(`      Difference: $${paxgXautDiff.toFixed(2)} (${paxgXautDiffPercent > 0 ? '+' : ''}${paxgXautDiffPercent.toFixed(3)}%)`);
          if (Math.abs(paxgXautDiffPercent) > 0.5) {
            console.log(`      ⚠️  Noticeable difference between gold-backed tokens`);
          } else {
            console.log(`      ✅ Prices closely aligned`);
          }
        }
        
        console.log('');
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


