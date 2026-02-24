#!/usr/bin/env node
/**
 * Trace gold (XAUUSD) price from a start timestamp to find when it first
 * drops into a target range. Uses Dukascopy tick data.
 *
 * Usage: npx ts-node src/scripts/gold_price_trace.ts [startISO] [targetLow] [targetHigh]
 * Example: npx ts-node src/scripts/gold_price_trace.ts 2026-02-23T15:49:27.950Z 5194 5197
 */

import { getHistoricalRates } from 'dukascopy-node';

const startISO = process.argv[2] ?? '2026-02-23T15:49:27.950Z';
const targetLow = parseFloat(process.argv[3] ?? '5194');
const targetHigh = parseFloat(process.argv[4] ?? '5197');

const startDate = new Date(startISO);
const endDate = new Date(startDate);
endDate.setUTCHours(23, 59, 59, 999);

async function main() {
  console.log(`Gold (XAUUSD) price trace`);
  console.log(`Start: ${startDate.toISOString()}`);
  console.log(`Target range: ${targetLow} - ${targetHigh}`);
  console.log(`Fetching tick data from Dukascopy...\n`);

  const data = await getHistoricalRates({
    instrument: 'xauusd',
    dates: { from: startDate, to: endDate },
    timeframe: 'tick',
    format: 'json'
  });

  if (!Array.isArray(data) || data.length === 0) {
    console.log('No data returned.');
    return;
  }

  type Tick = { timestamp?: number; askPrice?: number; bidPrice?: number };
  const ticks = data as Tick[];
  const startMs = startDate.getTime();

  function price(t: Tick): number {
    const bid = t.bidPrice;
    const ask = t.askPrice;
    return bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask ?? NaN);
  }

  const firstInRange = ticks.find(
    (t) => {
      const ts = t.timestamp;
      if (ts == null || ts < startMs) return false;
      const p = price(t);
      return p >= targetLow && p <= targetHigh;
    }
  );

  if (!firstInRange || firstInRange.timestamp == null) {
    console.log(`Price did not re-enter range ${targetLow}-${targetHigh} after start (within ${ticks.length} ticks).`);
    const last = ticks[ticks.length - 1];
    console.log(`Last tick: ${new Date(last.timestamp ?? 0).toISOString()} bid=${last.bidPrice?.toFixed(2)} ask=${last.askPrice?.toFixed(2)}`);
    return;
  }

  const elapsedMs = firstInRange.timestamp - startMs;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  console.log(`First tick in range ${targetLow}-${targetHigh}:`);
  console.log(`  Time: ${new Date(firstInRange.timestamp).toISOString()}`);
  console.log(`  Bid: ${firstInRange.bidPrice?.toFixed(2)} Ask: ${firstInRange.askPrice?.toFixed(2)}`);
  console.log(`\nElapsed from message time: ${elapsedSec} seconds`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
