/**
 * Investigate whether M1 candles touched eval limit entry prices in the entry window.
 */
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { CTraderClient } from '../clients/ctraderClient.js';
import { calculateEntryPrice } from '../utils/entryPriceStrategy.js';

dayjs.extend(utc);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envInv = path.join(projectRoot, '.env-investigation');
dotenv.config({ path: fs.existsSync(envInv) ? envInv : path.join(projectRoot, '.env') });

type SampleTrade = {
  id: number;
  messageId: string;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  createdAt: string;
  expiresAt: string;
  message: string;
  entryRange?: [number, number];
};

const samples: SampleTrade[] = [
  {
    id: 5119,
    messageId: '14277',
    direction: 'short',
    entryPrice: 4499,
    stopLoss: 4509,
    createdAt: '2026-05-19T18:51:33.000Z',
    expiresAt: '2026-05-19T19:01:33.000Z',
    message: 'SELL 4502–4499',
    entryRange: [4502, 4499],
  },
  {
    id: 5131,
    messageId: '14401',
    direction: 'long',
    entryPrice: 4529,
    stopLoss: 4517,
    createdAt: '2026-05-21T17:15:15.000Z',
    expiresAt: '2026-05-21T17:25:15.000Z',
    message: 'Buy 4529-4523',
    entryRange: [4529, 4523],
  },
  {
    id: 5144,
    messageId: '14702',
    direction: 'short',
    entryPrice: 4558,
    stopLoss: 4568,
    createdAt: '2026-05-25T23:58:59.000Z',
    expiresAt: '2026-05-26T00:08:59.000Z',
    message: 'SELL 4558-4563',
    entryRange: [4558, 4563],
  },
  {
    id: 5159,
    messageId: '14968',
    direction: 'short',
    entryPrice: 4415,
    stopLoss: 4430,
    createdAt: '2026-05-27T13:14:07.000Z',
    expiresAt: '2026-05-27T13:24:07.000Z',
    message: 'SELL 4420-4415',
    entryRange: [4420, 4415],
  },
];

const wouldFillLimit = (
  direction: 'long' | 'short',
  entryPrice: number,
  high: number,
  low: number
): boolean => {
  const tolerance = entryPrice * 0.001;
  if (direction === 'long') return low <= entryPrice + tolerance;
  return high >= entryPrice - tolerance;
};

const rangeTouched = (
  direction: 'long' | 'short',
  range: [number, number],
  high: number,
  low: number
): boolean => {
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  return high >= lo && low <= hi;
};

async function main() {
  const client = new CTraderClient({
    clientId: process.env.CTRADER_CLIENT_ID || '',
    clientSecret: process.env.CTRADER_CLIENT_SECRET || '',
    accessToken: process.env.CTRADER_ACCESS_TOKEN || '',
    refreshToken: process.env.CTRADER_REFRESH_TOKEN,
    accountId: process.env.CTRADER_ACCOUNT_ID || '',
    environment: process.env.CTRADER_ENVIRONMENT === 'live' ? 'live' : 'demo',
  });

  await client.connect();
  await client.authenticate();

  console.log('\n=== Eval entry fill investigation (XAUUSD M1 from cTrader) ===\n');

  for (const trade of samples) {
    const startMs = dayjs(trade.createdAt).valueOf();
    const endMs = dayjs(trade.expiresAt).valueOf();
    const worstFromRange =
      trade.entryRange != null
        ? calculateEntryPrice(trade.entryRange[0], trade.entryRange[1], trade.direction, 'worst')
        : trade.entryPrice;

    const bars = await client.getTrendbars({
      symbol: 'XAUUSD',
      fromTimestamp: startMs - 60_000,
      toTimestamp: endMs + 60_000,
      period: 'M1',
    });

    const inWindow = bars.filter((b) => b.timestamp >= startMs && b.timestamp <= endMs);

    let fillAtStored = false;
    let fillAtWorst = false;
    let fillAnyInRange = false;
    let minLow = Infinity;
    let maxHigh = -Infinity;
    let closestToEntry = Infinity;

    for (const bar of inWindow) {
      const high = bar.high ?? bar.price;
      const low = bar.low ?? bar.price;
      minLow = Math.min(minLow, low);
      maxHigh = Math.max(maxHigh, high);
      closestToEntry = Math.min(closestToEntry, Math.abs(bar.price - trade.entryPrice));

      if (wouldFillLimit(trade.direction, trade.entryPrice, high, low)) fillAtStored = true;
      if (wouldFillLimit(trade.direction, worstFromRange, high, low)) fillAtWorst = true;
      if (trade.entryRange && rangeTouched(trade.direction, trade.entryRange, high, low)) {
        fillAnyInRange = true;
      }
    }

    console.log('─'.repeat(72));
    console.log(`Trade #${trade.id}  message ${trade.messageId}  (${trade.direction.toUpperCase()})`);
    console.log(`Signal: ${trade.message}`);
    console.log(`Window: ${trade.createdAt} → ${trade.expiresAt} (10 min)`);
    console.log(
      `Stored entry (eval DB): ${trade.entryPrice}  |  Range: ${trade.entryRange?.join('–')}  |  Worst-case limit: ${worstFromRange}`
    );
    console.log(`M1 bars returned (in window): ${inWindow.length}  (total fetch: ${bars.length})`);

    if (inWindow.length === 0) {
      console.log('⚠️  NO M1 DATA in entry window — eval would cancel with empty price history');
      if (bars.length > 0) {
        const first = bars[0];
        const last = bars[bars.length - 1];
        console.log(
          `   Nearest fetch span: ${dayjs(first.timestamp).utc().format()} → ${dayjs(last.timestamp).utc().format()}`
        );
      }
    } else {
      console.log(`Price span in window: low ${minLow.toFixed(2)} – high ${maxHigh.toFixed(2)}`);
      console.log(`Closest close to stored entry: ${closestToEntry.toFixed(2)} pts`);
      console.log(`Mock limit @ stored entry (${trade.entryPrice}): ${fillAtStored ? '✅ WOULD FILL' : '❌ no touch'}`);
      console.log(`Mock limit @ worst in range (${worstFromRange}): ${fillAtWorst ? '✅ WOULD FILL' : '❌ no touch'}`);
      console.log(`Any M1 overlap with full entry range: ${fillAnyInRange ? '✅ YES' : '❌ NO'}`);

      console.log('\n  Candles in window:');
      for (const bar of inWindow) {
        const high = bar.high ?? bar.price;
        const low = bar.low ?? bar.price;
        const ts = dayjs(bar.timestamp).utc().format('HH:mm:ss');
        const touchStored = wouldFillLimit(trade.direction, trade.entryPrice, high, low);
        const touchRange = trade.entryRange
          ? rangeTouched(trade.direction, trade.entryRange, high, low)
          : false;
        const flags = [
          touchStored ? 'HIT_ENTRY' : null,
          touchRange ? 'IN_RANGE' : null,
        ]
          .filter(Boolean)
          .join(',');
        console.log(
          `    ${ts}  O≈${bar.price.toFixed(2)}  H=${high.toFixed(2)}  L=${low.toFixed(2)}${flags ? `  [${flags}]` : ''}`
        );
      }
    }
    console.log('');
  }

  await client.disconnect?.().catch(() => undefined);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
