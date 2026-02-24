#!/usr/bin/env tsx
/**
 * Analyze TP vs SL order using tick/historical price data.
 * Determines whether take-profit levels or stop-loss would have been hit first
 * after entry fill.
 *
 * Usage:
 *   npm run analyze-tp-sl -- message:817 channel:3469900302
 *   npm run analyze-tp-sl -- trade:123
 *
 * Data sources (first available wins):
 *   - cTrader: cTrader OpenAPI tick data (venue-specific, highest accuracy)
 *   - cTrader XAUUSD fallback: Dukascopy M1 candles
 *   - Bybit: Historical price provider (klines/execution history)
 */

import '../scripts/dotenv-preload.js';
import { DatabaseManager } from '../db/schema.js';
import { getIsLong } from '../monitors/shared.js';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { normalizeCTraderSymbol } from '../utils/ctraderSymbolUtils.js';
import dayjs from 'dayjs';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

interface PricePoint {
  timestamp: number;
  price: number;
  high?: number;
  low?: number;
}

type HitResult = { type: 'tp'; index: number; price: number; timestamp: number } | { type: 'sl'; price: number; timestamp: number };

type EntryFillResult = { met: boolean; metAt?: { timestamp: number; price: number; index: number } };

/**
 * Shared synthetic price extraction for OHLC candles.
 * Bullish: low then high; bearish: high then low.
 */
function getSyntheticPrices(p: PricePoint): number[] {
  if (p.high != null && p.low != null) {
    const high = p.high;
    const low = p.low;
    const close = p.price;
    const mid = (high + low) / 2;
    const isBullish = close >= mid;
    return isBullish ? [low, high] : [high, low];
  }
  return [p.price];
}

/**
 * Walk tick-by-tick to see if entry price was ever met (limit order would have filled).
 * Long: entry met when price <= entryPrice.
 * Short: entry met when price >= entryPrice.
 */
function findEntryFill(
  points: PricePoint[],
  entryPrice: number,
  isLong: boolean,
  startIndex: number
): EntryFillResult & { minPrice: number; maxPrice: number } {
  let minPrice = Infinity;
  let maxPrice = -Infinity;

  for (let i = startIndex; i < points.length; i++) {
    const pts = points[i];
    const synthetic = getSyntheticPrices(pts);
    for (const price of synthetic) {
      if (price < minPrice) minPrice = price;
      if (price > maxPrice) maxPrice = price;

      const wouldFill = isLong ? price <= entryPrice : price >= entryPrice;
      if (wouldFill) {
        return {
          met: true,
          metAt: { timestamp: pts.timestamp, price, index: i },
          minPrice,
          maxPrice
        };
      }
    }
  }
  if (minPrice === Infinity) minPrice = maxPrice = entryPrice;
  return { met: false, minPrice, maxPrice };
}

/**
 * Walk through price points to find which level (TP or SL) was hit first.
 * For OHLC: synthesizes intra-candle order (bullish: low then high, bearish: high then low).
 */
function findFirstHit(
  points: PricePoint[],
  entryPrice: number,
  isLong: boolean,
  takeProfits: number[],
  stopLoss: number,
  startIndex: number,
  initialPrevPrice?: number
): { hit: HitResult | null; lastPrice: number } {
  const eps = 1e-9;
  const crossesLevel = (prev: number, curr: number, level: number, isLevelAbove: boolean): boolean => {
    if (isLevelAbove) return prev < level - eps && curr >= level + eps;
    return prev > level + eps && curr <= level - eps;
  };

  let prevPrice = initialPrevPrice ?? entryPrice;
  for (let i = startIndex; i < points.length; i++) {
    const pts = points[i];
    const synthetic = getSyntheticPrices(pts);
    for (const price of synthetic) {
      const currPrice = price;

      if (isLong) {
        for (let j = 0; j < takeProfits.length; j++) {
          if (crossesLevel(prevPrice, currPrice, takeProfits[j], true)) {
            return { hit: { type: 'tp', index: j + 1, price: takeProfits[j], timestamp: pts.timestamp }, lastPrice: prevPrice };
          }
        }
        if (crossesLevel(prevPrice, currPrice, stopLoss, false)) {
          return { hit: { type: 'sl', price: stopLoss, timestamp: pts.timestamp }, lastPrice: prevPrice };
        }
      } else {
        for (let j = 0; j < takeProfits.length; j++) {
          if (crossesLevel(prevPrice, currPrice, takeProfits[j], false)) {
            return { hit: { type: 'tp', index: j + 1, price: takeProfits[j], timestamp: pts.timestamp }, lastPrice: prevPrice };
          }
        }
        if (crossesLevel(prevPrice, currPrice, stopLoss, true)) {
          return { hit: { type: 'sl', price: stopLoss, timestamp: pts.timestamp }, lastPrice: prevPrice };
        }
      }
      prevPrice = currPrice;
    }
  }
  return { hit: null, lastPrice: prevPrice };
}

async function getCTraderClientForAnalysis(accountName?: string): Promise<CTraderClient | undefined> {
  const configPath = process.env.CONFIG_PATH || path.join(projectRoot, 'config.json');
  let config: any = null;
  try {
    if (await fs.pathExists(configPath)) {
      config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    }
  } catch {
    return undefined;
  }
  const account =
    config?.accounts?.find((acc: any) =>
      acc.exchange === 'ctrader' && (accountName ? acc.name === accountName : true)
    ) ?? config?.accounts?.find((acc: any) => acc.exchange === 'ctrader');
  const envKey = account?.envVarNames?.apiKey ?? account?.envVars?.apiKey;
  const envSecret = account?.envVarNames?.apiSecret ?? account?.envVars?.apiSecret;
  const envToken = account?.envVarNames?.accessToken ?? account?.envVars?.accessToken;
  const envAccountId = account?.envVarNames?.accountId ?? account?.envVars?.accountId;
  const clientId = envKey ? process.env[envKey] : process.env.CTRADER_CLIENT_ID;
  const clientSecret = envSecret ? process.env[envSecret] : process.env.CTRADER_CLIENT_SECRET;
  const accessToken = envToken ? process.env[envToken] : process.env.CTRADER_ACCESS_TOKEN;
  const accountId = envAccountId ? process.env[envAccountId] : process.env.CTRADER_ACCOUNT_ID;
  if (!clientId || !clientSecret || !accessToken || !accountId) return undefined;
  const clientConfig: CTraderClientConfig = {
    clientId,
    clientSecret,
    accessToken,
    accountId,
    environment: account?.demo ? 'demo' : 'live'
  };
  const client = new CTraderClient(clientConfig);
  try {
    await client.connect();
    await client.authenticate();
    return client;
  } catch {
    return undefined;
  }
}

/**
 * Fetch cTrader tick data. Returns points for entry-fill and TP/SL analysis.
 */
async function fetchCTraderTickPoints(
  ctraderClient: CTraderClient,
  symbol: string,
  fromTimestamp: number,
  toTimestamp: number
): Promise<{ points: PricePoint[]; effectiveStart: number }> {
  const normalizedSymbol = normalizeCTraderSymbol(symbol);
  const ticks = await ctraderClient.getTickData({
    symbol: normalizedSymbol,
    fromTimestamp,
    toTimestamp
  });
  const points: PricePoint[] = ticks.map((t) => ({ timestamp: t.timestamp, price: t.price }));
  const startIndex = points.findIndex((p) => p.timestamp >= fromTimestamp);
  const effectiveStart = startIndex >= 0 ? startIndex : 0;
  return { points, effectiveStart };
}

/**
 * Fetch Dukascopy M1 data (tick causes OOM). Uses OHLC for intra-candle order.
 * Skips if dates are in the future (dukascopy-node OOMs on future ranges).
 */
async function fetchDukascopyPoints(
  symbol: string,
  fromDate: Date,
  toDate: Date
): Promise<{ points: PricePoint[]; effectiveStart: number; skipped?: string }> {
  const sym = symbol.toUpperCase().replace(/[/-]/g, '');
  if (sym !== 'XAUUSD' && sym !== 'XAU') {
    return { points: [], effectiveStart: 0 };
  }
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000; // 5 min buffer – dukascopy-node OOMs near "now"
  if (fromDate.getTime() >= now - bufferMs || toDate.getTime() > now + bufferMs) {
    return { points: [], effectiveStart: 0, skipped: 'Dates too close to now (Dukascopy OOM)' };
  }
  const ctx = path.join(projectRoot, 'node_modules', '.cache', 'dukascopy');
  await fs.ensureDir(ctx);
  const { getHistoricalRates } = await import('dukascopy-node');
  const data = await getHistoricalRates({
    instrument: 'xauusd',
    dates: { from: fromDate, to: toDate },
    timeframe: 'm1',
    format: 'json',
    useCache: true,
    cacheFolderPath: ctx
  });
  if (!Array.isArray(data) || data.length === 0) {
    return { points: [], effectiveStart: 0 };
  }
  type Candle = { timestamp?: number; open?: number; high?: number; low?: number; close?: number };
  const candles = data as Candle[];
  const points: PricePoint[] = candles
    .filter((c): c is Candle & { timestamp: number } => typeof c.timestamp === 'number')
    .map((c) => ({
      timestamp: c.timestamp,
      price: c.close ?? c.open ?? 0,
      high: c.high,
      low: c.low
    }))
    .filter((p) => Number.isFinite(p.price))
    .sort((a, b) => a.timestamp - b.timestamp);
  const startIndex = points.findIndex((p) => p.timestamp >= fromDate.getTime());
  const effectiveStart = startIndex >= 0 ? startIndex : 0;
  return { points, effectiveStart };
}

async function fetchBybitPriceData(
  symbol: string,
  startTime: dayjs.Dayjs,
  endTime: dayjs.Dayjs
): Promise<PricePoint[]> {
  const { createHistoricalPriceProvider } = await import('../utils/historicalPriceProvider.js');
  const configPath = process.env.CONFIG_PATH || path.join(projectRoot, 'config.json');
  let apiKey: string | undefined;
  let apiSecret: string | undefined;
  if (await fs.pathExists(configPath)) {
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const acct = config?.accounts?.[0];
    if (acct?.envVarNames?.apiKey) {
      apiKey = process.env[acct.envVarNames.apiKey];
    }
    if (acct?.envVarNames?.apiSecret) {
      apiSecret = process.env[acct.envVarNames.apiSecret];
    }
    if (!apiKey) apiKey = process.env.BYBIT_API_KEY;
    if (!apiSecret) apiSecret = process.env.BYBIT_API_SECRET;
  }
  const provider = createHistoricalPriceProvider(
    startTime.toISOString(),
    1,
    apiKey,
    apiSecret
  );
  const history = await provider.getPriceHistory(symbol.replace('/', ''), startTime, endTime);
  return history.map((p) => ({
    timestamp: p.timestamp,
    price: p.price,
    high: p.high,
    low: p.low
  }));
}

async function main() {
  const args = process.argv.slice(2).join(' ');
  let messageId: string | undefined;
  let channel: string | undefined;
  let tradeId: number | undefined;

  const msgMatch = args.match(/message:(\d+)/i);
  if (msgMatch) messageId = msgMatch[1];
  const chMatch = args.match(/channel:(\S+)/i);
  if (chMatch) channel = chMatch[1];
  const trMatch = args.match(/trade:(\d+)/i);
  if (trMatch) tradeId = parseInt(trMatch[1], 10);

  if (!messageId && !tradeId) {
    console.error('Usage: npm run analyze-tp-sl -- message:<id> channel:<channel>');
    console.error('   or: npm run analyze-tp-sl -- trade:<id>');
    process.exit(1);
  }

  const db = new DatabaseManager();
  await db.initialize();

  let trades: Awaited<ReturnType<DatabaseManager['getTradesByMessageId']>>;
  if (tradeId) {
    const t = await db.getTradeWithMessage(tradeId);
    trades = t ? [t] : [];
  } else {
    trades = await db.getTradesByMessageId(messageId!, channel || 'unknown');
  }

  if (trades.length === 0) {
    console.error('No trade found for the given message/channel or trade ID');
    process.exit(1);
  }

  for (const trade of trades) {
    const takeProfits = JSON.parse(trade.take_profits || '[]') as number[];
    const isLong = getIsLong(trade as any);
    const symbol = trade.trading_pair?.replace('/', '') ?? '';
    const exchange = (trade as any).exchange ?? 'bybit';

    // Use message_date as primary for analysis – created_at/entry_filled_at can have timezone bugs
    const tradeWithMsg = (trade as { source_message?: { date: string } });
    const message = tradeWithMsg.source_message ?? await db.getMessageByMessageId(trade.message_id, trade.channel);
    const messageDate = message?.date ? dayjs(message.date) : null;
    let startTime: dayjs.Dayjs;
    let startTimeSource: 'message_date' | 'entry_filled_at' | 'created_at';
    if (messageDate) {
      startTime = messageDate;
      startTimeSource = 'message_date';
      if (trade.entry_filled_at) {
        const filled = dayjs(trade.entry_filled_at);
        const diffMin = filled.diff(messageDate, 'minute');
        if (Math.abs(diffMin) > 15) {
          console.log(`   ⚠️  entry_filled_at is ${diffMin} min from message date – using message_date for analysis (created_at/filled_at had timezone bugs)`);
        }
      } else if (trade.created_at) {
        const created = dayjs(trade.created_at);
        const diffMin = created.diff(messageDate, 'minute');
        if (Math.abs(diffMin) > 15) {
          console.log(`   ⚠️  created_at is ${diffMin} min from message date – using message_date for analysis`);
        }
      }
    } else if (trade.entry_filled_at) {
      startTime = dayjs(trade.entry_filled_at);
      startTimeSource = 'entry_filled_at';
    } else {
      startTime = dayjs(trade.created_at);
      startTimeSource = 'created_at';
    }
    const symbolUpper = symbol.toUpperCase();
    const isGoldSymbol = symbolUpper.includes('XAU') || symbolUpper.includes('GOLD');
    const windowHours = isGoldSymbol ? 12 : 24 * 7; // 12h for gold (Dukascopy), 7d for Bybit
    const endTime = startTime.add(windowHours, 'hours');
    const fromDate = startTime.toDate();
    const toDate = endTime.toDate();

    console.log('\n' + '='.repeat(60));
    console.log(`Trade ${trade.id} | ${symbol} | ${exchange}`);
    console.log(`Entry: ${trade.entry_price} | SL: ${trade.stop_loss} | TPs: [${takeProfits.join(', ')}]`);
    console.log(`Direction: ${isLong ? 'LONG' : 'SHORT'}`);
    console.log(`Analysis from: ${startTime.toISOString()} (source: ${startTimeSource})`);
    console.log('='.repeat(60));

    let points: PricePoint[] = [];
    let effectiveStart = 0;
    let dataSourceLabel = '';

    if (exchange === 'ctrader') {
      const ctraderClient = await getCTraderClientForAnalysis((trade as any).account_name);
      if (ctraderClient) {
        try {
          console.log('\nFetching cTrader tick data...');
          const ctrResult = await fetchCTraderTickPoints(
            ctraderClient,
            symbol,
            startTime.valueOf(),
            endTime.valueOf()
          );
          points = ctrResult.points;
          effectiveStart = ctrResult.effectiveStart;
          dataSourceLabel = 'cTrader ticks';
          console.log(`  Processed ${points.length} ticks`);
          if (points.length === 0) console.log('  No ticks returned, falling back to Dukascopy');
        } catch (err) {
          console.log(`  cTrader tick failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        console.log('\n  cTrader client not available (check CTRADER_* env or config)');
      }
    }

    if (points.length === 0 && exchange === 'ctrader' && isGoldSymbol) {
      try {
        console.log('\nFetching Dukascopy M1 data (XAUUSD)...');
        const dukResult = await fetchDukascopyPoints(symbol, fromDate, toDate);
        points = dukResult.points;
        effectiveStart = dukResult.effectiveStart;
        dataSourceLabel = 'Dukascopy M1';
        if (dukResult.skipped) {
          console.log(`  Skipped: ${dukResult.skipped}`);
        } else {
          console.log(`  Fetched ${points.length} candles`);
        }
      } catch (err) {
        console.log(`  Dukascopy failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (points.length === 0 && exchange !== 'ctrader') {
      const bybitSymbol = symbol.replace('/', '') || symbol;
      console.log(`\nFetching Bybit historical price data (${bybitSymbol})...`);
      points = await fetchBybitPriceData(bybitSymbol, startTime, endTime);
      const withOhlc = points.filter((p) => p.high != null && p.low != null).length;
      dataSourceLabel = 'Bybit';
      console.log(`  Fetched ${points.length} points (${withOhlc} with OHLC)`);
      effectiveStart = points.findIndex((p) => p.timestamp >= startTime.valueOf());
      if (effectiveStart < 0) effectiveStart = 0;
    }

    if (points.length === 0) {
      console.log('\n⚠️  No price data available. Cannot determine entry fill or TP vs SL order.');
      continue;
    }

    // Verify tick window covers message/order time (order placed ~15–30s after message)
    const firstTs = points[effectiveStart]?.timestamp ?? points[0]?.timestamp;
    const lastTs = points[points.length - 1]?.timestamp;
    const requestedFrom = startTime.valueOf();
    const firstPrice = points[effectiveStart]?.price ?? points[0]?.price;
    const firstTickTime = firstTs ? new Date(firstTs).toISOString() : 'N/A';
    const lastTickTime = lastTs ? new Date(lastTs).toISOString() : 'N/A';
    const startDeltaMin = firstTs != null ? (firstTs - requestedFrom) / 60000 : null;
    const coversStart = firstTs != null && startDeltaMin != null && startDeltaMin >= -1 && startDeltaMin <= 5;
    console.log(`\n  Tick range: ${firstTickTime} → ${lastTickTime}`);
    console.log(`  First tick price: ${firstPrice?.toFixed(2) ?? 'N/A'}`);
    console.log(`  Requested from: ${startTime.toISOString()} (message/signal time)`);
    if (startDeltaMin != null) {
      console.log(`  First tick is ${startDeltaMin >= 0 ? '+' : ''}${startDeltaMin.toFixed(1)} min vs requested`);
    }
    if (!coversStart && points.length > 0) {
      console.log(`  ⚠️  Tick data may not cover order placement time – first tick is ${startDeltaMin != null ? (startDeltaMin > 5 ? 'too late' : startDeltaMin < -1 ? 'too early' : '?') : 'unknown'}`);
    }

    // Step 1: Check if entry price was ever met (tick-by-tick)
    const entryResult = findEntryFill(points, trade.entry_price, isLong, effectiveStart);
    console.log('\n--- Entry fill check ---');
    if (entryResult.met && entryResult.metAt) {
      const fillTs = new Date(entryResult.metAt.timestamp).toISOString();
      console.log(`✅ Entry price REACHED at ${fillTs}`);
      console.log(`   Fill price: ${entryResult.metAt.price}`);
      console.log(`   (Limit ${isLong ? 'BUY' : 'SELL'} would have filled)`);

      // Step 2: From fill point, determine TP vs SL
      const { hit } = findFirstHit(
        points,
        trade.entry_price,
        isLong,
        takeProfits,
        trade.stop_loss,
        entryResult.metAt.index,
        entryResult.metAt.price
      );

      console.log('\n--- TP vs SL (after entry) ---');
      if (hit) {
        const ts = new Date(hit.timestamp).toISOString();
        if (hit.type === 'tp') {
          console.log(`✅ TP${hit.index} would have HIT FIRST`);
          console.log(`   Level: ${hit.price}`);
          console.log(`   Time:  ${ts}`);
          console.log(`   (Stop loss was NOT hit before TP${hit.index})`);
        } else {
          console.log(`❌ STOP LOSS would have HIT FIRST`);
          console.log(`   Level: ${hit.price}`);
          console.log(`   Time:  ${ts}`);
          console.log(`   (TPs were not hit before SL)`);
        }
      } else {
        console.log(`⏳ Neither TP nor SL was hit within the analysis window`);
        const last = points[points.length - 1];
        console.log(`   Last price: ${last.price} at ${new Date(last.timestamp).toISOString()}`);
      }
    } else {
      console.log(`❌ Entry price NEVER REACHED`);
      console.log(`   Price range in window: ${entryResult.minPrice.toFixed(2)} – ${entryResult.maxPrice.toFixed(2)}`);
      console.log(`   Entry limit: ${trade.entry_price} (${isLong ? 'BUY fills when price ≤ entry' : 'SELL fills when price ≥ entry'})`);
      console.log(`   TP/SL analysis: N/A (entry never filled)`);
    }
    console.log(`\n   Data source: ${dataSourceLabel}`);
    console.log(`   Analysis time source: ${startTimeSource}`);
  }

  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
