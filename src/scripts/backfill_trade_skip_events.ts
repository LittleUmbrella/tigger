#!/usr/bin/env tsx
/**
 * Backfill trade skip events from historical logs into trade_events table.
 *
 * Targets cTrader trade initiation failures where price is already beyond TP.
 *
 * Usage:
 *   npm run backfill-trade-skip-events
 *   npm run backfill-trade-skip-events -- --days-back 30 --window-hours 6 --dry-run
 *   npm run backfill-trade-skip-events -- --from 2026-01-01T00:00:00Z --until 2026-04-20T23:59:59Z
 *   npm run backfill-trade-skip-events -- --max-results-per-query 1000 --min-window-minutes 1
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseManager } from '../db/schema.js';
import { createLogglyApiClient, LogglyLogEntry } from '../utils/logglyApiClient.js';

const TRADE_SKIP_PRICE_BEYOND_TP_EVENT = 'trade_skipped_price_beyond_tp';

type BackfillReason =
  | 'market_range_boundary_tp_already_past'
  | 'too_many_take_profits_already_past_price'
  | 'all_take_profits_already_past_price';

interface BackfillCandidate {
  messageId: string;
  channel: string;
  timestamp: string;
  reason: BackfillReason;
  signalType?: string;
  currentPrice?: number;
  boundaryTp?: number;
  pastCount?: number;
  rawError: string;
}

interface Args {
  from?: string;
  until?: string;
  daysBack: number;
  windowHours: number;
  maxResultsPerQuery: number;
  minWindowMinutes: number;
  dryRun: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

function loadEnv(): void {
  const envInvestigationPath = path.join(projectRoot, '.env-investigation');
  const envPath = path.join(projectRoot, '.env');
  if (fs.existsSync(envInvestigationPath)) {
    dotenv.config({ path: envInvestigationPath });
    return;
  }
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    return;
  }
  dotenv.config();
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    daysBack: 30,
    windowHours: 6,
    maxResultsPerQuery: 1000,
    minWindowMinutes: 1,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--from' && next) {
      args.from = next;
      i++;
      continue;
    }
    if (arg === '--until' && next) {
      args.until = next;
      i++;
      continue;
    }
    if (arg === '--days-back' && next) {
      args.daysBack = Number.parseInt(next, 10);
      i++;
      continue;
    }
    if (arg === '--window-hours' && next) {
      args.windowHours = Number.parseInt(next, 10);
      i++;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--max-results-per-query' && next) {
      args.maxResultsPerQuery = Number.parseInt(next, 10);
      i++;
      continue;
    }
    if (arg === '--min-window-minutes' && next) {
      args.minWindowMinutes = Number.parseInt(next, 10);
      i++;
      continue;
    }
  }

  return args;
}

function resolveTimeRange(args: Args): { fromIso: string; untilIso: string } {
  const until = args.until ? new Date(args.until) : new Date();
  const from = args.from
    ? new Date(args.from)
    : new Date(until.getTime() - args.daysBack * 24 * 60 * 60 * 1000);

  if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime())) {
    throw new Error('Invalid --from/--until timestamp. Use ISO-8601 format.');
  }
  if (from >= until) {
    throw new Error('--from must be earlier than --until.');
  }

  return { fromIso: from.toISOString(), untilIso: until.toISOString() };
}

function getPayload(entry: LogglyLogEntry): Record<string, any> {
  const raw = (entry?.event ?? entry) as Record<string, any>;
  if (raw?.json && typeof raw.json === 'object') return raw.json as Record<string, any>;
  return raw;
}

function extractErrorText(payload: Record<string, any>): string {
  const rawError = payload?.error;
  if (typeof rawError === 'string') return rawError;
  if (rawError && typeof rawError === 'object' && typeof rawError.message === 'string') return rawError.message;
  return '';
}

function parseReason(errorText: string): BackfillReason | null {
  if (!errorText) return null;
  if (errorText.includes('already at or past boundary TP')) {
    return 'market_range_boundary_tp_already_past';
  }
  if (errorText.includes('TP(s) already past current price')) {
    return 'too_many_take_profits_already_past_price';
  }
  if (
    errorText.includes('all TPs already past current price') ||
    errorText.includes('all take profits already past current price')
  ) {
    return 'all_take_profits_already_past_price';
  }
  if (errorText.includes('Cannot place cTrader market order')) {
    return 'cannot_place_ctrader_market_order';
  }
  return null;
}

function extractNumber(pattern: RegExp, text: string): number | undefined {
  const match = text.match(pattern);
  if (!match || !match[1]) return undefined;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildCandidate(entry: LogglyLogEntry): BackfillCandidate | null {
  const payload = getPayload(entry);
  const message = String(payload?.message ?? '');
  if (message !== 'Error initiating trade') return null;
  if (String(payload?.initiatorName ?? '') !== 'ctrader') return null;

  const messageId = payload?.messageId != null ? String(payload.messageId) : '';
  const channel = payload?.channel != null ? String(payload.channel) : '';
  if (!messageId || !channel) return null;

  const errorText = extractErrorText(payload);
  const reason = parseReason(errorText);
  if (!reason) return null;

  return {
    messageId,
    channel,
    timestamp: String(payload?.timestamp ?? entry?.timestamp ?? new Date().toISOString()),
    reason,
    signalType: typeof payload?.signalType === 'string' ? payload.signalType : undefined,
    currentPrice: extractNumber(/current price ([0-9]+(?:\.[0-9]+)?)/i, errorText),
    boundaryTp: extractNumber(/boundary TP ([0-9]+(?:\.[0-9]+)?)/i, errorText),
    pastCount: extractNumber(/([0-9]+) TP\(s\) already past current price/i, errorText),
    rawError: errorText,
  };
}

function dedupeCandidates(candidates: BackfillCandidate[]): BackfillCandidate[] {
  const seen = new Set<string>();
  const unique: BackfillCandidate[] = [];
  for (const item of candidates) {
    const key = [
      item.messageId,
      item.channel,
      item.reason,
      item.rawError,
      item.timestamp,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

async function fetchEventsPaginated(params: {
  query: string;
  fromIso: string;
  untilIso: string;
  windowHours: number;
  maxResultsPerQuery: number;
  minWindowMinutes: number;
  search: (opts: {
    query: string;
    from: string;
    until: string;
    size: number;
    order: 'asc' | 'desc';
  }) => Promise<{ events?: LogglyLogEntry[]; total_events?: number }>;
}): Promise<{ events: LogglyLogEntry[]; queriedWindows: number; splitWindows: number }> {
  const {
    query,
    fromIso,
    untilIso,
    windowHours,
    maxResultsPerQuery,
    minWindowMinutes,
    search,
  } = params;

  const minWindowMs = minWindowMinutes * 60 * 1000;
  const baseWindowMs = windowHours * 60 * 60 * 1000;
  const results: LogglyLogEntry[] = [];
  let queriedWindows = 0;
  let splitWindows = 0;

  const queryRange = async (startMs: number, endMs: number): Promise<void> => {
    queriedWindows++;
    const response = await search({
      query,
      from: new Date(startMs).toISOString(),
      until: new Date(endMs).toISOString(),
      size: maxResultsPerQuery,
      order: 'asc',
    });

    const windowEvents = response.events ?? [];
    results.push(...windowEvents);

    const likelySaturated =
      windowEvents.length >= maxResultsPerQuery ||
      (response.total_events != null && response.total_events > maxResultsPerQuery);

    const windowMs = endMs - startMs;
    if (likelySaturated && windowMs > minWindowMs) {
      splitWindows++;
      // Remove events already added for this saturated window to avoid overlap duplicates;
      // we'll replace with child windows.
      results.splice(results.length - windowEvents.length, windowEvents.length);

      const midMs = startMs + Math.floor(windowMs / 2);
      if (midMs <= startMs || midMs >= endMs) {
        results.push(...windowEvents);
        return;
      }
      await queryRange(startMs, midMs);
      await queryRange(midMs, endMs);
    }
  };

  const fromMs = new Date(fromIso).getTime();
  const untilMs = new Date(untilIso).getTime();
  for (let cursor = fromMs; cursor < untilMs; cursor += baseWindowMs) {
    const windowEnd = Math.min(cursor + baseWindowMs, untilMs);
    await queryRange(cursor, windowEnd);
  }

  return { events: results, queriedWindows, splitWindows };
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const loggly = createLogglyApiClient();
  if (!loggly) {
    console.error('Loggly API client not configured. Set LOGGLY_SUBDOMAIN and LOGGLY_API_TOKEN (or LOGGLY_TOKEN).');
    process.exit(1);
  }

  const db = new DatabaseManager();
  await db.initialize();

  try {
    // Prefer Loggly JSON field paths, but include full-text fallbacks for mixed/legacy formats.
    const query = [
      '(',
      '((json.message:"Error initiating trade") OR ("Error initiating trade"))',
      'AND',
      '((json.initiatorName:ctrader) OR (initiatorName:ctrader) OR ("initiatorName":"ctrader") OR ("\\\"initiatorName\\\":\\\"ctrader\\\""))',
      'AND',
      '(',
      '"already at or past boundary TP"',
      'OR "TP(s) already past current price"',
      'OR "all TPs already past current price"',
      'OR "all take profits already past current price"',
      'OR "Cannot place cTrader market order"',
      ')',
      ')',
    ].join(' ');

    const { fromIso, untilIso } = resolveTimeRange(args);

    const paged = await fetchEventsPaginated({
      query,
      fromIso,
      untilIso,
      windowHours: args.windowHours,
      maxResultsPerQuery: args.maxResultsPerQuery,
      minWindowMinutes: args.minWindowMinutes,
      search: (opts) => loggly.search({
        query: opts.query,
        from: opts.from,
        until: opts.until,
        size: opts.size,
        order: opts.order,
      }),
    });

    const events = paged.events;
    const candidates = dedupeCandidates(events.map(buildCandidate).filter((x): x is BackfillCandidate => x != null));

    let inserted = 0;
    for (const candidate of candidates) {
      const metadata = {
        timestamp: candidate.timestamp,
        reason: candidate.reason,
        exchange: 'ctrader',
        signalType: candidate.signalType,
        currentPrice: candidate.currentPrice,
        boundaryTp: candidate.boundaryTp,
        pastCount: candidate.pastCount,
        source: 'loggly_backfill',
        rawError: candidate.rawError,
      };

      if (!args.dryRun) {
        await db.insertTradeEvent({
          message_id: candidate.messageId,
          channel: candidate.channel,
          event_type: TRADE_SKIP_PRICE_BEYOND_TP_EVENT,
          metadata: JSON.stringify(metadata),
        });
        inserted++;
      }
    }

    console.log(JSON.stringify({
      mode: args.dryRun ? 'dry-run' : 'write',
      query,
      logEventsScanned: events.length,
      candidatesFound: candidates.length,
      inserted,
      from: fromIso,
      until: untilIso,
      daysBack: args.daysBack,
      windowHours: args.windowHours,
      maxResultsPerQuery: args.maxResultsPerQuery,
      minWindowMinutes: args.minWindowMinutes,
      queriedWindows: paged.queriedWindows,
      splitWindows: paged.splitWindows,
    }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error('Backfill failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

