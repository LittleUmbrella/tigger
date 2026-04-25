#!/usr/bin/env tsx
import 'dotenv/config';
import fs from 'fs-extra';
import { Command } from 'commander';
import { DatabaseManager, Trade } from '../db/schema.js';
import { BotConfig } from '../types/config.js';

type PerformanceRow = {
  channel: string;
  consideredTrades: number;
  skippedBeforeFirstStopped: number;
  filteredOutByDate: number;
  firstStoppedAt: string;
  dateWindowStart: string;
  dateWindowEnd: string;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;
  totalGain: number;
  totalLoss: number;
  netPnl: number;
  profitFactor: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
};

const CLOSED_STATUSES: Trade['status'][] = ['closed', 'stopped', 'cancelled', 'completed'];

const program = new Command();

function parseDateToMs(input?: string): number | undefined {
  if (!input) return undefined;
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

function pickTradeTimestampMs(trade: Trade): number | undefined {
  const candidate = trade.exit_filled_at || trade.updated_at || trade.created_at;
  if (!candidate) return undefined;
  const ms = Date.parse(candidate);
  return Number.isNaN(ms) ? undefined : ms;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toFixedSafe(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function csvEscape(value: string | number): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }

  if (value.includes('"') || value.includes(',') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function buildCsv(rows: PerformanceRow[]): string {
  const header = [
    'channel',
    'considered_trades',
    'skipped_before_first_stopped',
    'filtered_out_by_date',
    'first_stopped_at',
    'date_window_start',
    'date_window_end',
    'wins',
    'losses',
    'breakeven',
    'win_rate_pct',
    'total_gain',
    'total_loss',
    'net_pnl',
    'profit_factor',
    'avg_pnl',
    'avg_win',
    'avg_loss',
    'largest_win',
    'largest_loss',
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.channel,
        row.consideredTrades,
        row.skippedBeforeFirstStopped,
        row.filteredOutByDate,
        row.firstStoppedAt,
        row.dateWindowStart,
        row.dateWindowEnd,
        row.wins,
        row.losses,
        row.breakeven,
        row.winRatePct,
        row.totalGain,
        row.totalLoss,
        row.netPnl,
        row.profitFactor,
        row.avgPnl,
        row.avgWin,
        row.avgLoss,
        row.largestWin,
        row.largestLoss,
      ]
        .map(csvEscape)
        .join(',')
    );
  }

  return `${lines.join('\n')}\n`;
}

function summarizeChannel(
  channel: string,
  trades: Trade[],
  fromMs?: number,
  toMs?: number
): PerformanceRow | null {
  const sortedTrades = [...trades].sort((a, b) => {
    const aMs = pickTradeTimestampMs(a) ?? 0;
    const bMs = pickTradeTimestampMs(b) ?? 0;
    return aMs - bMs;
  });

  const firstStoppedIndex = sortedTrades.findIndex((trade) => trade.status === 'stopped');
  if (firstStoppedIndex === -1) {
    return null;
  }

  const skippedBeforeFirstStopped = firstStoppedIndex;
  const trimmed = sortedTrades.slice(firstStoppedIndex);

  const dateFiltered = trimmed.filter((trade) => {
    const timestamp = pickTradeTimestampMs(trade);
    if (timestamp === undefined) return false;
    if (fromMs !== undefined && timestamp < fromMs) return false;
    if (toMs !== undefined && timestamp > toMs) return false;
    return true;
  });

  const filteredOutByDate = trimmed.length - dateFiltered.length;

  const pnls = dateFiltered
    .map((trade) => trade.pnl)
    .filter((value): value is number => isFiniteNumber(value));

  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const breakeven = pnls.filter((p) => p === 0).length;

  const totalGain = wins.reduce((sum, p) => sum + p, 0);
  const totalLoss = Math.abs(losses.reduce((sum, p) => sum + p, 0));
  const netPnl = totalGain - totalLoss;
  const profitFactor = totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? Number.POSITIVE_INFINITY : 0;
  const consideredTrades = pnls.length;
  const winRatePct = consideredTrades > 0 ? (wins.length / consideredTrades) * 100 : 0;

  const avgPnl = consideredTrades > 0 ? netPnl / consideredTrades : 0;
  const avgWin = wins.length > 0 ? totalGain / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;

  const largestWin = wins.length > 0 ? Math.max(...wins) : 0;
  const largestLoss = losses.length > 0 ? Math.min(...losses) : 0;

  const firstStoppedAt = pickTradeTimestampMs(sortedTrades[firstStoppedIndex]);

  return {
    channel,
    consideredTrades,
    skippedBeforeFirstStopped,
    filteredOutByDate,
    firstStoppedAt: firstStoppedAt ? new Date(firstStoppedAt).toISOString() : '',
    dateWindowStart: fromMs ? new Date(fromMs).toISOString() : '',
    dateWindowEnd: toMs ? new Date(toMs).toISOString() : '',
    wins: wins.length,
    losses: losses.length,
    breakeven,
    winRatePct: toFixedSafe(winRatePct, 2),
    totalGain: toFixedSafe(totalGain),
    totalLoss: toFixedSafe(totalLoss),
    netPnl: toFixedSafe(netPnl),
    profitFactor: Number.isFinite(profitFactor) ? toFixedSafe(profitFactor, 4) : Number.POSITIVE_INFINITY,
    avgPnl: toFixedSafe(avgPnl),
    avgWin: toFixedSafe(avgWin),
    avgLoss: toFixedSafe(avgLoss),
    largestWin: toFixedSafe(largestWin),
    largestLoss: toFixedSafe(largestLoss),
  };
}

program
  .name('channel-trade-performance-csv')
  .description('Export per-channel trade performance as CSV')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--from <iso-date>', 'Include trades on/after this date (ISO string)')
  .option('--to <iso-date>', 'Include trades on/before this date (ISO string)')
  .option('--out <path>', 'Optional output file path (defaults to stdout)')
  .action(async (options) => {
    const configPath = options.config || 'config.json';
    if (!fs.existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }

    const fromMs = parseDateToMs(options.from);
    const toMs = parseDateToMs(options.to);

    if (options.from && fromMs === undefined) {
      console.error(`Invalid --from date: ${options.from}`);
      process.exit(1);
    }
    if (options.to && toMs === undefined) {
      console.error(`Invalid --to date: ${options.to}`);
      process.exit(1);
    }
    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
      console.error('--from cannot be later than --to');
      process.exit(1);
    }

    const config: BotConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const rawDbType = (config.database?.type || 'sqlite').toLowerCase();
    const dbType = rawDbType === 'postgres' || rawDbType === 'postgresql' ? 'postgresql' : 'sqlite';
    const dbPath =
      dbType === 'sqlite'
        ? (config.database?.path || 'data/trading_bot.db')
        : (config.database?.url || process.env.DATABASE_URL || '');

    if (dbType === 'postgresql' && !dbPath) {
      console.error('PostgreSQL database selected but no URL provided');
      process.exit(1);
    }

    const db = new DatabaseManager({
      type: dbType,
      path: dbType === 'sqlite' ? dbPath : undefined,
      url: dbType === 'postgresql' ? dbPath : undefined,
    });

    await db.initialize();

    try {
      const closedTrades = await db.getClosedTrades();
      const byChannel = new Map<string, Trade[]>();

      for (const trade of closedTrades) {
        if (!CLOSED_STATUSES.includes(trade.status)) continue;
        const channelTrades = byChannel.get(trade.channel) || [];
        channelTrades.push(trade);
        byChannel.set(trade.channel, channelTrades);
      }

      const rows: PerformanceRow[] = [];
      for (const [channel, trades] of byChannel.entries()) {
        const row = summarizeChannel(channel, trades, fromMs, toMs);
        if (row && row.consideredTrades > 0) {
          rows.push(row);
        }
      }

      rows.sort((a, b) => {
        if (b.netPnl !== a.netPnl) return b.netPnl - a.netPnl;
        if (b.profitFactor !== a.profitFactor) return b.profitFactor - a.profitFactor;
        return b.winRatePct - a.winRatePct;
      });

      const csv = buildCsv(rows);

      if (options.out) {
        await fs.outputFile(options.out, csv, 'utf-8');
        console.error(`Wrote ${rows.length} channels to ${options.out}`);
      } else {
        process.stdout.write(csv);
      }
    } finally {
      await db.close();
    }
  });

program.parse(process.argv);
