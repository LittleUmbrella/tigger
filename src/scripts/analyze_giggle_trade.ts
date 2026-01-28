#!/usr/bin/env node
/**
 * Analyze trading signals from pasted text format
 * 
 * Expected format:
 * Jan 23
 * $GIGGLE / USDT — FUTURES & SPOT (1H)
 * 
 * Bias: 🟢 BULLISH / LONG
 * 
 * Entry Zone:
 * ➡️ 51.20 – 52.80
 * 
 * Stop Loss:
 * ⛔ 48.80 – 49.00
 * 
 * Targets:
 * 🎯 TP1: 55.00 – 56.00
 * 🎯 TP2: 57.50 – 58.20
 */

import 'dotenv/config';
import { RestClientV5 } from 'bybit-api';
import dayjs from 'dayjs';
import { createHistoricalPriceProvider } from '../utils/historicalPriceProvider.js';

interface ParsedSignal {
  date: dayjs.Dayjs;
  tradingPair: string;
  bias: string;
  entryZoneMin: number;
  entryZoneMax: number;
  stopLossMin: number;
  stopLossMax: number;
  tp1Min: number;
  tp1Max: number;
  tp2Min: number;
  tp2Max: number;
}

interface TradeAnalysis {
  entryPrice: number;
  entryTime: string;
  stopLossHit: boolean;
  stopLossTime: string | null;
  tp1Hit: boolean;
  tp1Time: string | null;
  tp2Hit: boolean;
  tp2Time: string | null;
  finalPrice: number;
  finalTime: string;
  result: 'WIN' | 'LOSS' | 'BREAKEVEN';
  profitLoss: number;
  profitLossPercent: number;
}

function parseSignalText(signalText: string): ParsedSignal {
  const lines = signalText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // Parse date (first line, e.g., "Jan 23")
  const dateMatch = lines[0].match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)/i);
  if (!dateMatch) {
    throw new Error(`Could not parse date from: ${lines[0]}`);
  }
  const monthName = dateMatch[1];
  const day = parseInt(dateMatch[2], 10);
  const monthMap: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };
  const month = monthMap[monthName.toLowerCase()];
  // Assume current year (or next year if date has passed)
  const now = dayjs();
  let year = now.year();
  const signalDateThisYear = dayjs().year(year).month(month).date(day);
  if (signalDateThisYear.isBefore(now.subtract(6, 'months'))) {
    year = year + 1;
  }
  const date = dayjs().year(year).month(month).date(day).hour(0).minute(0).second(0).millisecond(0);
  
  // Parse trading pair (second line, e.g., "$GIGGLE / USDT — FUTURES & SPOT (1H)")
  const pairMatch = lines[1].match(/\$?(\w+)\s*\/\s*(\w+)/i);
  if (!pairMatch) {
    throw new Error(`Could not parse trading pair from: ${lines[1]}`);
  }
  const tradingPair = `${pairMatch[1].toUpperCase()}/${pairMatch[2].toUpperCase()}`;
  
  // Parse bias
  const biasLine = lines.find(l => /bias/i.test(l));
  const bias = biasLine ? biasLine.replace(/bias:\s*/i, '').trim() : 'UNKNOWN';
  
  // Parse entry zone (e.g., "➡️ 51.20 – 52.80" or after "Entry Zone:")
  let entryLine = lines.find(l => /entry/i.test(l) && /\d+\.\d+\s*[–-]\s*\d+\.\d+/.test(l));
  if (!entryLine) {
    // Look for line after "Entry Zone:" header
    const entryZoneIndex = lines.findIndex(l => /entry\s+zone/i.test(l));
    if (entryZoneIndex >= 0 && entryZoneIndex + 1 < lines.length) {
      entryLine = lines[entryZoneIndex + 1];
    }
  }
  const entryMatch = entryLine?.match(/(\d+\.\d+)\s*[–-]\s*(\d+\.\d+)/);
  if (!entryMatch) {
    throw new Error(`Could not parse entry zone from: ${entryLine || 'not found'}`);
  }
  const entryZoneMin = parseFloat(entryMatch[1]);
  const entryZoneMax = parseFloat(entryMatch[2]);
  
  // Parse stop loss (e.g., "⛔ 48.80 – 49.00" or after "Stop Loss:")
  let stopLossLine = lines.find(l => /stop/i.test(l) && /\d+\.\d+\s*[–-]\s*\d+\.\d+/.test(l));
  if (!stopLossLine) {
    // Look for line after "Stop Loss:" header
    const stopLossIndex = lines.findIndex(l => /stop\s+loss/i.test(l));
    if (stopLossIndex >= 0 && stopLossIndex + 1 < lines.length) {
      stopLossLine = lines[stopLossIndex + 1];
    }
  }
  const stopLossMatch = stopLossLine?.match(/(\d+\.\d+)\s*[–-]\s*(\d+\.\d+)/);
  if (!stopLossMatch) {
    throw new Error(`Could not parse stop loss from: ${stopLossLine || 'not found'}`);
  }
  const stopLossMin = parseFloat(stopLossMatch[1]);
  const stopLossMax = parseFloat(stopLossMatch[2]);
  
  // Parse TP1 (e.g., "🎯 TP1: 55.00 – 56.00")
  const tp1Line = lines.find(l => /tp1/i.test(l) && /\d+\.\d+\s*[–-]\s*\d+\.\d+/.test(l));
  const tp1Match = tp1Line?.match(/(\d+\.\d+)\s*[–-]\s*(\d+\.\d+)/);
  if (!tp1Match) {
    throw new Error(`Could not parse TP1 from: ${tp1Line || 'not found'}`);
  }
  const tp1Min = parseFloat(tp1Match[1]);
  const tp1Max = parseFloat(tp1Match[2]);
  
  // Parse TP2 (e.g., "🎯 TP2: 57.50 – 58.20")
  const tp2Line = lines.find(l => /tp2/i.test(l) && /\d+\.\d+\s*[–-]\s*\d+\.\d+/.test(l));
  const tp2Match = tp2Line?.match(/(\d+\.\d+)\s*[–-]\s*(\d+\.\d+)/);
  if (!tp2Match) {
    throw new Error(`Could not parse TP2 from: ${tp2Line || 'not found'}`);
  }
  const tp2Min = parseFloat(tp2Match[1]);
  const tp2Max = parseFloat(tp2Match[2]);
  
  return {
    date,
    tradingPair,
    bias,
    entryZoneMin,
    entryZoneMax,
    stopLossMin,
    stopLossMax,
    tp1Min,
    tp1Max,
    tp2Min,
    tp2Max
  };
}

async function analyzeTrade(): Promise<void> {
  // Get demo API credentials
  const apiKey = process.env.BYBIT_DEMO_API_KEY;
  const apiSecret = process.env.BYBIT_DEMO_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.error('❌ BYBIT_DEMO_API_KEY and BYBIT_DEMO_API_SECRET must be set in .env file');
    process.exit(1);
  }

  // Parse signal from pasted text
  const signalText = `Jan 23
$GIGGLE / USDT — FUTURES & SPOT (1H)

Bias: 🟢 BULLISH / LONG

Entry Zone:

➡️ 51.20 – 52.80

Stop Loss:

⛔ 48.80 – 49.00

Targets:

🎯 TP1: 55.00 – 56.00

🎯 TP2: 57.50 – 58.20`;

  let signal: ParsedSignal;
  try {
    signal = parseSignalText(signalText);
  } catch (error) {
    console.error('❌ Failed to parse signal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log('🔍 Analyzing Trade Signal');
  console.log('='.repeat(60));
  console.log(`Signal Date: ${signal.date.format('MMM D, YYYY')}`);
  console.log(`Trading Pair: ${signal.tradingPair} (Futures & Spot)`);
  console.log(`Bias: ${signal.bias}`);
  console.log(`Entry Zone: ${signal.entryZoneMin} – ${signal.entryZoneMax}`);
  console.log(`Stop Loss: ${signal.stopLossMin} – ${signal.stopLossMax}`);
  console.log(`TP1: ${signal.tp1Min} – ${signal.tp1Max}`);
  console.log(`TP2: ${signal.tp2Min} – ${signal.tp2Max}`);
  console.log('='.repeat(60));
  console.log('');

  // Create Bybit client (demo trading uses api-demo.bybit.com)
  const bybitClient = new RestClientV5({
    key: apiKey,
    secret: apiSecret,
    testnet: false,
    baseUrl: 'https://api-demo.bybit.com'
  });

  // Create historical price provider with authenticated API to fetch trade execution data
  // This gives us actual trade prices rather than kline OHLC data, which is more accurate
  // Note: We use regular Bybit API (not demo) for historical trade data
  // The provider will try execution history first (authenticated), then public trades, then klines
  const priceProvider = createHistoricalPriceProvider(
    signal.date.toISOString(),
    1.0,
    apiKey, // Use authenticated API to fetch trade execution history (more accurate than klines)
    apiSecret
  );
  
  const {
    date: signalDate,
    tradingPair,
    entryZoneMin,
    entryZoneMax,
    stopLossMin,
    stopLossMax,
    tp1Min,
    tp1Max,
    tp2Min,
    tp2Max
  } = signal;

  // Analysis window: from signal date to 7 days later
  const analysisStart = signalDate;
  const analysisEnd = signalDate.add(7, 'days');

  console.log('📊 Fetching historical price data...');
  const normalizedSymbol = tradingPair.replace('/', '');
  console.log(`   Symbol: ${normalizedSymbol}`);
  console.log(`   Start: ${analysisStart.toISOString()}`);
  console.log(`   End: ${analysisEnd.toISOString()}`);
  console.log('');

  // Fetch price history
  const priceHistory = await priceProvider.getPriceHistory(
    tradingPair,
    analysisStart,
    analysisEnd
  );

  if (priceHistory.length === 0) {
    console.error('❌ No price data found for GIGGLE/USDT');
    console.error('   This could mean:');
    console.error('   - Symbol does not exist on Bybit');
    console.error('   - Symbol name format is incorrect');
    console.error('   - No trading data available for this period');
    process.exit(1);
  }

  console.log(`✅ Retrieved ${priceHistory.length} price data points`);
  console.log(`   First price: $${priceHistory[0].price} at ${new Date(priceHistory[0].timestamp).toISOString()}`);
  console.log(`   Last price: $${priceHistory[priceHistory.length - 1].price} at ${new Date(priceHistory[priceHistory.length - 1].timestamp).toISOString()}`);
  console.log('');

  // Find entry point: first time price enters entry zone
  let entryPrice: number | null = null;
  let entryTime: dayjs.Dayjs | null = null;
  let entryIndex = -1;

  for (let i = 0; i < priceHistory.length; i++) {
    const price = priceHistory[i].price;
    if (price >= entryZoneMin && price <= entryZoneMax) {
      entryPrice = price;
      entryTime = dayjs(priceHistory[i].timestamp);
      entryIndex = i;
      break;
    }
  }

  if (!entryPrice || !entryTime) {
    console.log('⚠️  Price never entered entry zone (51.20 – 52.80)');
    console.log(`   Price range during analysis: $${Math.min(...priceHistory.map(p => p.price)).toFixed(2)} - $${Math.max(...priceHistory.map(p => p.price)).toFixed(2)}`);
    process.exit(0);
  }

  console.log(`✅ Entry found:`);
  console.log(`   Price: $${entryPrice.toFixed(2)}`);
  console.log(`   Time: ${entryTime.toISOString()}`);
  console.log('');

  // Simulate trade from entry point
  let stopLossHit = false;
  let stopLossTime: dayjs.Dayjs | null = null;
  let tp1Hit = false;
  let tp1Time: dayjs.Dayjs | null = null;
  let tp2Hit = false;
  let tp2Time: dayjs.Dayjs | null = null;

  // Check prices after entry
  for (let i = entryIndex + 1; i < priceHistory.length; i++) {
    const price = priceHistory[i].price;
    const time = dayjs(priceHistory[i].timestamp);

    // Check stop loss first (most important)
    if (!stopLossHit && price <= stopLossMax) {
      stopLossHit = true;
      stopLossTime = time;
      break; // Stop loss hit, trade is closed
    }

    // Check TP2 (higher target)
    if (!tp2Hit && price >= tp2Min) {
      tp2Hit = true;
      tp2Time = time;
      // Continue to check if stop loss is hit after TP2
    }

    // Check TP1 (lower target)
    if (!tp1Hit && price >= tp1Min) {
      tp1Hit = true;
      tp1Time = time;
      // Continue to check for TP2
    }
  }

  // Determine final result
  const finalPrice = priceHistory[priceHistory.length - 1].price;
  const finalTime = dayjs(priceHistory[priceHistory.length - 1].timestamp);

  let result: 'WIN' | 'LOSS' | 'BREAKEVEN';
  let profitLoss: number;
  let profitLossPercent: number;

  if (stopLossHit && stopLossTime) {
    result = 'LOSS';
    profitLoss = entryPrice - stopLossMax; // Use max stop loss as exit price
    profitLossPercent = (profitLoss / entryPrice) * 100;
  } else if (tp2Hit && tp2Time) {
    result = 'WIN';
    profitLoss = tp2Min - entryPrice; // Use min TP2 as exit price
    profitLossPercent = (profitLoss / entryPrice) * 100;
  } else if (tp1Hit && tp1Time) {
    result = 'WIN';
    profitLoss = tp1Min - entryPrice; // Use min TP1 as exit price
    profitLossPercent = (profitLoss / entryPrice) * 100;
  } else {
    // Trade still open at end of analysis period
    profitLoss = finalPrice - entryPrice;
    profitLossPercent = (profitLoss / entryPrice) * 100;
    if (profitLoss > 0.01) {
      result = 'WIN';
    } else if (profitLoss < -0.01) {
      result = 'LOSS';
    } else {
      result = 'BREAKEVEN';
    }
  }

  // Display results
  console.log('📈 Trade Analysis Results');
  console.log('='.repeat(60));
  console.log(`Entry Price: $${entryPrice.toFixed(2)}`);
  console.log(`Entry Time: ${entryTime.toISOString()}`);
  console.log('');

  if (stopLossHit && stopLossTime) {
    console.log(`❌ Stop Loss HIT`);
    console.log(`   Exit Price: $${stopLossMax.toFixed(2)}`);
    console.log(`   Exit Time: ${stopLossTime.toISOString()}`);
    console.log(`   Result: ${result}`);
    console.log(`   P&L: -$${Math.abs(profitLoss).toFixed(2)} (${profitLossPercent.toFixed(2)}%)`);
  } else if (tp2Hit && tp2Time) {
    console.log(`🎯 Take Profit 2 HIT`);
    console.log(`   Exit Price: $${tp2Min.toFixed(2)}`);
    console.log(`   Exit Time: ${tp2Time.toISOString()}`);
    console.log(`   Result: ${result}`);
    console.log(`   P&L: +$${profitLoss.toFixed(2)} (+${profitLossPercent.toFixed(2)}%)`);
    if (tp1Hit && tp1Time) {
      console.log(`   ✅ TP1 also hit at: ${tp1Time.toISOString()}`);
    }
  } else if (tp1Hit && tp1Time) {
    console.log(`🎯 Take Profit 1 HIT`);
    console.log(`   Exit Price: $${tp1Min.toFixed(2)}`);
    console.log(`   Exit Time: ${tp1Time.toISOString()}`);
    console.log(`   Result: ${result}`);
    console.log(`   P&L: +$${profitLoss.toFixed(2)} (+${profitLossPercent.toFixed(2)}%)`);
  } else {
    console.log(`⏳ Trade still open at end of analysis period`);
    console.log(`   Final Price: $${finalPrice.toFixed(2)}`);
    console.log(`   Final Time: ${finalTime.toISOString()}`);
    console.log(`   Result: ${result}`);
    console.log(`   P&L: ${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)} (${profitLossPercent >= 0 ? '+' : ''}${profitLossPercent.toFixed(2)}%)`);
  }

  console.log('='.repeat(60));
  console.log('');

  // Price movement summary
  const minPrice = Math.min(...priceHistory.slice(entryIndex).map(p => p.price));
  const maxPrice = Math.max(...priceHistory.slice(entryIndex).map(p => p.price));
  console.log('📊 Price Movement Summary');
  console.log(`   Lowest price after entry: $${minPrice.toFixed(2)}`);
  console.log(`   Highest price after entry: $${maxPrice.toFixed(2)}`);
  console.log(`   Price range: $${(maxPrice - minPrice).toFixed(2)}`);
  console.log('');

  // Risk/Reward analysis
  const risk = entryPrice - stopLossMax;
  const rewardTP1 = tp1Min - entryPrice;
  const rewardTP2 = tp2Min - entryPrice;
  const riskRewardTP1 = rewardTP1 / risk;
  const riskRewardTP2 = rewardTP2 / risk;

  console.log('💰 Risk/Reward Analysis');
  console.log(`   Risk (Entry to Stop Loss): $${risk.toFixed(2)}`);
  console.log(`   Reward TP1: $${rewardTP1.toFixed(2)} (R:R = 1:${riskRewardTP1.toFixed(2)})`);
  console.log(`   Reward TP2: $${rewardTP2.toFixed(2)} (R:R = 1:${riskRewardTP2.toFixed(2)})`);
  console.log('');

  // Final verdict
  console.log('🎯 Final Verdict');
  console.log('='.repeat(60));
  if (result === 'WIN') {
    console.log('✅ WINNING TRADE');
    if (tp2Hit) {
      console.log('   Both take profit targets were hit!');
    } else if (tp1Hit) {
      console.log('   First take profit target was hit.');
    }
  } else if (result === 'LOSS') {
    console.log('❌ LOSING TRADE');
    console.log('   Stop loss was hit before reaching any targets.');
  } else {
    console.log('⚖️  BREAKEVEN / INCONCLUSIVE');
    console.log('   Trade did not hit stop loss or take profit targets within analysis period.');
  }
  console.log('='.repeat(60));
}

// Run analysis
analyzeTrade().catch((error) => {
  console.error('❌ Analysis failed:', error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});

