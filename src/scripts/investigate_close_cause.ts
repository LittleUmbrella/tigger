#!/usr/bin/env tsx
/**
 * Investigate cause of trade 228 close: (1) management commands in messages, (2) price retrace to SL
 * Usage: npx tsx src/scripts/investigate_close_cause.ts 228
 */
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseManager } from '../db/schema.js';
import { RestClientV5 } from 'bybit-api';
import { BotConfig } from '../types/config.js';
import dayjs from 'dayjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envPath = path.join(projectRoot, '.env-investigation');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const CLOSE_TRIGGERS = [
  'close all',
  'closed all',
  'close all positions',
  'close all trades',
  'close everything',
  'close it',
  'close longs',
  'close shorts',
  'close half',
  'secure half',
  'take half',
  'close #apt',
  'close apt'
];

async function getBybitClient(accountName: string, config: BotConfig | null): Promise<RestClientV5 | null> {
  const account = config?.accounts?.find((a) => a.name === accountName);
  if (!account) return null;
  const keyEnv = account.envVarNames?.apiKey || (account as any).envVars?.apiKey;
  const secretEnv = account.envVarNames?.apiSecret || (account as any).envVars?.apiSecret;
  const apiKey = keyEnv ? process.env[keyEnv] : process.env.BYBIT_API_KEY;
  const apiSecret = secretEnv ? process.env[secretEnv] : process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  const demo = account.demo || false;
  const baseUrl = demo ? 'https://api-demo.bybit.com' : undefined;
  return new RestClientV5({
    key: apiKey,
    secret: apiSecret,
    testnet: account.testnet || false,
    ...(baseUrl && { baseUrl }),
  });
}

async function main() {
  const tradeId = parseInt(process.argv[2] || '228', 10);
  const configPath = process.env.CONFIG_PATH || path.join(projectRoot, 'config.json');
  const config: BotConfig | null = fs.existsSync(configPath)
    ? JSON.parse(await fs.readFile(configPath, 'utf-8'))
    : null;

  const db = new DatabaseManager();
  await db.initialize();

  const trade = await db.getTradeWithMessage(tradeId);
  if (!trade) {
    console.error('Trade not found');
    await db.close();
    process.exit(1);
  }

  const entryAt = trade.entry_filled_at ? dayjs(trade.entry_filled_at) : null;
  const channel = trade.channel;
  const symbol = (trade.trading_pair || '').replace('/', '');
  const slPrice = trade.stop_loss ?? 0;
  const entryPrice = trade.entry_price ?? 0;
  const isLong = trade.direction === 'long' || (trade.stop_loss != null && trade.stop_loss < entryPrice);

  console.log('\n=== Investigate close cause for trade', tradeId, '===\n');
  console.log('Channel:', channel, '| Symbol:', symbol, '| Entry:', entryPrice, '| SL:', slPrice);
  console.log('Entry filled:', trade.entry_filled_at, '| Direction:', isLong ? 'LONG' : 'SHORT');
  console.log('Breakeven stop would trigger when price', isLong ? 'drops to' : 'rises to', entryPrice, '\n');

  // --- 1. Check messages for management commands ---
  console.log('--- 1. Messages that could trigger close ---');
  if (!entryAt) {
    console.log('No entry_filled_at, cannot scope message query.\n');
  } else {
    const startDate = entryAt.subtract(5, 'minute').toISOString();
    const endDate = entryAt.add(4, 'hour').toISOString();
    const pool = (db as unknown as { adapter?: { pool?: { query: (q: string, p?: any[]) => Promise<{ rows: any[] }> } } }).adapter?.pool;
    let list: any[] = [];
    if (pool) {
      const res = await pool.query(
        `SELECT message_id, content, date, sender FROM messages 
         WHERE channel = $1 AND date >= $2 AND date <= $3 
         ORDER BY date ASC`,
        [channel, startDate, endDate]
      );
      list = res?.rows ?? [];
    }
    const candidates = list.filter((r: any) => {
      const norm = (r.content || '').toLowerCase().trim();
      return CLOSE_TRIGGERS.some((t) => norm.includes(t) || norm === 'close');
    });
    if (candidates.length > 0) {
      console.log('Found', candidates.length, 'message(s) that could trigger close:\n');
      for (const m of candidates) {
        console.log('  date:', m.date);
        console.log('  content:', (m.content || '').slice(0, 120));
        console.log('  message_id:', m.message_id, '\n');
      }
    } else {
      console.log('No messages in window that match close triggers.');
      if (list.length > 0) {
        console.log('Sample of messages in window:');
        list.slice(0, 5).forEach((m: any) => {
          console.log('  ', m.date, (m.content || '').slice(0, 80));
        });
      } else {
        console.log('(No messages in window - query may need schema adjustment)');
      }
    }
  }

  // --- 2. Historical price: did price touch SL/breakeven? ---
  console.log('\n--- 2. Historical price: did price retrace to breakeven (', entryPrice, ')? ---');
  const client = await getBybitClient(trade.account_name || 'demo', config);
  if (!client) {
    console.log('No Bybit client, skipping price check.');
  } else {
    const sym = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
    const startMs = entryAt ? entryAt.valueOf() : Date.now() - 6 * 60 * 60 * 1000;
    const endMs = Math.min(startMs + 6 * 60 * 60 * 1000, Date.now());
    try {
      const klines = await client.getKline({
        category: 'linear',
        symbol: sym,
        interval: '1',
        start: startMs,
        end: endMs,
        limit: 500,
      });
      const list = (klines as any).result?.list ?? [];
      if (list.length === 0) {
        console.log('No kline data returned.');
      } else {
        // Bybit returns [startTime, open, high, low, close, volume, turnover]
        const parseKline = (k: any) => {
          if (Array.isArray(k)) {
            return { start: parseFloat(k[0] || '0'), open: parseFloat(k[1] || '0'), high: parseFloat(k[2] || '0'), low: parseFloat(k[3] || '0'), close: parseFloat(k[4] || '0') };
          }
          return { start: parseFloat(k.start || '0'), open: parseFloat(k.open || '0'), high: parseFloat(k.high || '0'), low: parseFloat(k.low || '0'), close: parseFloat(k.close || '0') };
        };
        const touches: { time: string; low: number; high: number; closed: boolean }[] = [];
        for (const k of list) {
          const { start, open, high, low, close } = parseKline(k);
          const time = start ? new Date(start).toISOString() : '';
          const touchedSl = isLong ? low <= entryPrice : high >= entryPrice;
          if (touchedSl || Math.min(low, open, close) <= entryPrice + 0.002) {
            touches.push({ time, low, high, closed: touchedSl });
          }
        }
        if (touches.length > 0) {
          const slTouches = touches.filter((t) => (isLong ? t.low <= entryPrice : t.high >= entryPrice));
          console.log(
            'Price',
            isLong ? 'touched or went below' : 'touched or went above',
            entryPrice,
            'in',
            slTouches.length,
            'candle(s):'
          );
          slTouches.slice(0, 10).forEach((t) => {
            console.log('  ', t.time, 'low:', t.low, 'high:', t.high, '-> SL would trigger:', t.closed);
          });
        } else {
          console.log('Price did NOT retrace to', entryPrice, 'in the window.');
          if (list.length > 0) {
            const parsed = list.map((k: any) => parseKline(k));
            const minLow = Math.min(...parsed.map((p: { low: number }) => p.low));
            const maxHigh = Math.max(...parsed.map((p: { high: number }) => p.high));
            console.log(
              'Range in window: low',
              minLow,
              'high',
              maxHigh,
              '| Breakeven',
              entryPrice,
              minLow <= entryPrice && entryPrice <= maxHigh ? 'was within range' : 'was NOT in range'
            );
          }
        }
      }
    } catch (e) {
      console.log('Kline error:', (e as Error).message);
    }
  }

  await db.close();
  console.log('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
