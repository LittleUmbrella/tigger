#!/usr/bin/env node
/**
 * Verify TP levels against Bybit API historical data
 * Checks if trades that didn't hit TPs actually reached TP price levels
 */

import { RestClientV5 } from 'bybit-api';
import dayjs from 'dayjs';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

// Load environment variables from .env-investigation
function loadEnvFile(filePath: string) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        // Only set if not already in environment
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch (error) {
    // File doesn't exist or can't be read - that's okay
  }
}

// Load .env-investigation file
const envFile = join(process.cwd(), '.env-investigation');
loadEnvFile(envFile);

const db = new Database('data/evaluation.db');

interface Trade {
  id: number;
  trading_pair: string;
  entry_price: number;
  stop_loss: number;
  take_profits: string;
  status: string;
  entry_filled_at: string | null;
  exit_filled_at: string | null;
  exit_price: number | null;
}

interface Order {
  id: number;
  trade_id: number;
  order_type: string;
  price: number;
  tp_index: number | null;
  status: string;
  filled_at: string | null;
  filled_price: number | null;
}

async function checkTradeTPs(tradeId: number) {
  const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) as Trade;
  if (!trade) {
    console.error(`Trade ${tradeId} not found`);
    return;
  }

  const orders = db.prepare('SELECT * FROM orders WHERE trade_id = ? ORDER BY order_type, tp_index').all(tradeId) as Order[];
  const tpOrders = orders.filter(o => o.order_type === 'take_profit');
  const filledTPs = tpOrders.filter(o => o.status === 'filled');

  console.log(`\n=== Trade ${tradeId}: ${trade.trading_pair} ===`);
  console.log(`Entry: ${trade.entry_price}, Stop Loss: ${trade.stop_loss}`);
  console.log(`Status: ${trade.status}, Entry Filled: ${trade.entry_filled_at}, Exit: ${trade.exit_filled_at}`);
  console.log(`TPs: ${trade.take_profits}`);
  console.log(`Filled TPs: ${filledTPs.length}/${tpOrders.length}`);

  if (!trade.entry_filled_at) {
    console.log('⚠️  Entry never filled - skipping price check');
    return;
  }

  const takeProfits = JSON.parse(trade.take_profits) as number[];
  const isLong = trade.entry_price > trade.stop_loss;
  const entryTime = dayjs(trade.entry_filled_at);
  const exitTime = trade.exit_filled_at ? dayjs(trade.exit_filled_at) : dayjs();
  const durationDays = exitTime.diff(entryTime, 'day', true);

  console.log(`\nDirection: ${isLong ? 'LONG' : 'SHORT'}`);
  console.log(`Entry Time: ${entryTime.toISOString()}`);
  console.log(`Exit Time: ${exitTime.toISOString()}`);
  console.log(`Duration: ${durationDays.toFixed(2)} days`);

  // Initialize Bybit client
  // Try both BYBIT_API_KEY and BYBIT_DEMO_API_KEY for flexibility
  const apiKey = process.env.BYBIT_API_KEY || process.env.BYBIT_DEMO_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET || process.env.BYBIT_DEMO_API_SECRET;
  
  if (!apiKey || !apiSecret) {
    console.error('⚠️  BYBIT_API_KEY/BYBIT_DEMO_API_KEY and BYBIT_API_SECRET/BYBIT_DEMO_API_SECRET environment variables required');
    console.error('   Set them with: export BYBIT_API_KEY=... && export BYBIT_API_SECRET=...');
    return;
  }

  const bybitClient = new RestClientV5({
    key: apiKey,
    secret: apiSecret,
  });

  // Normalize symbol (remove / and ensure USDT)
  let symbol = trade.trading_pair.replace('/', '').toUpperCase();
  if (!symbol.endsWith('USDT')) {
    symbol = symbol + 'USDT';
  }

  console.log(`\nFetching price history for ${symbol}...`);

  try {
    // Fetch klines from entry to exit (or max 7 days)
    const startTime = entryTime;
    const endTime = exitTime.isAfter(dayjs()) ? dayjs() : exitTime;
    const limit = 200; // Max klines per request
    
    // Calculate interval based on duration
    let interval: '1' | '3' | '5' | '15' | '30' | '60' | '120' | '240' | '360' | '720' | 'D' | 'M' | 'W' = '60'; // Default 1 hour
    if (durationDays > 30) {
      interval = 'D'; // Daily for long durations
    } else if (durationDays > 7) {
      interval = '240'; // 4 hours
    } else if (durationDays > 1) {
      interval = '60'; // 1 hour
    } else {
      interval = '15'; // 15 minutes for short trades
    }

    console.log(`Using interval: ${interval}, fetching from ${startTime.toISOString()} to ${endTime.toISOString()}`);

    const klineResponse = await bybitClient.getKline({
      category: 'linear',
      symbol: symbol,
      interval: interval,
      start: startTime.valueOf(),
      end: endTime.valueOf(),
      limit: limit,
    });

    if (klineResponse.retCode !== 0) {
      console.error(`❌ Bybit API error: ${klineResponse.retMsg}`);
      return;
    }

    const klines = klineResponse.result.list || [];
    if (klines.length === 0) {
      console.log('⚠️  No price data returned from Bybit');
      return;
    }

    // Parse klines: [startTime, open, high, low, close, volume, endTime]
    const priceData = klines.map((k: string[]) => ({
      timestamp: parseInt(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));

    console.log(`\n📊 Price Data Points: ${priceData.length}`);
    console.log(`Price Range: ${Math.min(...priceData.map(p => p.low)).toFixed(6)} - ${Math.max(...priceData.map(p => p.high)).toFixed(6)}`);

    // Check each TP level
    console.log(`\n🎯 Checking TP Levels:`);
    for (let i = 0; i < takeProfits.length; i++) {
      const tpPrice = takeProfits[i];
      const tpOrder = tpOrders.find(o => o.tp_index === i);
      const isFilled = tpOrder?.status === 'filled';
      
      // Check if price reached this TP
      let reached = false;
      let reachedAt: dayjs.Dayjs | null = null;
      let reachedPrice = 0;

      for (const candle of priceData) {
        const candleTime = dayjs(candle.timestamp);
        if (isLong) {
          // For LONG: price reached TP if high >= TP price
          if (candle.high >= tpPrice) {
            reached = true;
            reachedAt = candleTime;
            reachedPrice = Math.max(candle.high, tpPrice);
            break;
          }
        } else {
          // For SHORT: price reached TP if low <= TP price
          if (candle.low <= tpPrice) {
            reached = true;
            reachedAt = candleTime;
            reachedPrice = Math.min(candle.low, tpPrice);
            break;
          }
        }
      }

      const status = isFilled ? '✅ FILLED' : (reached ? '⚠️  REACHED BUT NOT FILLED' : '❌ NOT REACHED');
      console.log(`TP${i + 1} (${tpPrice}): ${status}`);
      if (reached && !isFilled) {
        console.log(`   └─ Price reached at ${reachedAt?.toISOString()} (${reachedPrice.toFixed(6)})`);
        console.log(`   └─ This indicates a potential bug in TP fill logic!`);
      } else if (reached && isFilled) {
        console.log(`   └─ Price reached and order filled correctly`);
      } else if (!reached) {
        const entryPrice = trade.entry_price;
        const distance = isLong 
          ? ((tpPrice - entryPrice) / entryPrice * 100).toFixed(2)
          : ((entryPrice - tpPrice) / entryPrice * 100).toFixed(2);
        console.log(`   └─ TP is ${distance}% away from entry`);
      }
    }

    // Check stop loss
    console.log(`\n🛑 Stop Loss Check:`);
    let slReached = false;
    let slReachedAt: dayjs.Dayjs | null = null;
    
    for (const candle of priceData) {
      const candleTime = dayjs(candle.timestamp);
      if (isLong) {
        if (candle.low <= trade.stop_loss) {
          slReached = true;
          slReachedAt = candleTime;
          break;
        }
      } else {
        if (candle.high >= trade.stop_loss) {
          slReached = true;
          slReachedAt = candleTime;
          break;
        }
      }
    }

    if (slReached) {
      console.log(`Stop Loss (${trade.stop_loss}) was hit at ${slReachedAt?.toISOString()}`);
      if (trade.status === 'stopped') {
        console.log(`✅ Stop loss correctly triggered`);
      }
    } else {
      console.log(`⚠️  Stop loss (${trade.stop_loss}) was not reached in price data`);
    }

  } catch (error) {
    console.error(`❌ Error fetching price data:`, error);
  }
}

async function main() {
  const tradeIds = process.argv.slice(2).map(Number);
  
  if (tradeIds.length === 0) {
    console.log('Usage: tsx verify_tps_bybit.ts <trade_id1> [trade_id2] ...');
    console.log('\nExample trades to check:');
    const sampleTrades = db.prepare(`
      SELECT t.id, t.trading_pair, t.status, 
             COUNT(CASE WHEN o.order_type = 'take_profit' AND o.status = 'filled' THEN 1 END) as filled_tps
      FROM trades t
      LEFT JOIN orders o ON t.id = o.trade_id
      WHERE t.channel = '1459607851' 
        AND t.status IN ('stopped', 'closed')
        AND t.entry_filled_at IS NOT NULL
      GROUP BY t.id
      HAVING filled_tps = 0
      ORDER BY t.id DESC
      LIMIT 5
    `).all() as any[];
    
    sampleTrades.forEach(t => {
      console.log(`  Trade ${t.id}: ${t.trading_pair} (${t.status})`);
    });
    process.exit(1);
  }

  for (const tradeId of tradeIds) {
    await checkTradeTPs(tradeId);
  }

  db.close();
}

main().catch(console.error);

