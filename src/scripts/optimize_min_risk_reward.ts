#!/usr/bin/env tsx
/**
 * Sweep minRiskReward over a grid and pick the value that maximizes PnL.
 * Purges channel eval data between runs so results are independent.
 */
import './dotenv-preload.js';
import '../initiators/index.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import { Command } from 'commander';
import { DatabaseManager, Trade } from '../db/schema.js';
import { runEvaluation } from '../evaluation/evaluationOrchestrator.js';
import {
  buildEvaluationConfig,
  loadBotConfig,
  resolveChannelEvalDefaults,
} from '../evaluation/channelEvalConfig.js';

process.env.LOGGLY_ENABLED = process.env.LOGGLY_ENABLED ?? 'false';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

/** 0.50 … 2.45 in 0.15 steps, plus 2.50 as the 15th point. */
export const buildMinRiskRewardGrid = (): number[] => {
  const stepped = Array.from({ length: 14 }, (_, i) => (50 + i * 15) / 100);
  return [...stepped, 2.5];
};

export interface SweepRunSummary {
  minRiskReward: number;
  totalPnL: number;
  maxDrawdownPct: number;
  passed: boolean;
  filledTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;
  totalMessages: number;
  stopped: number;
  closed: number;
  worstLoss: number;
  bestWin: number;
  tradesFile: string;
}

const completedTrade = (t: Trade): boolean =>
  t.entry_filled_at != null && t.entry_filled_at !== '';

const summarizeTrades = (trades: Trade[]): Omit<SweepRunSummary, 'minRiskReward' | 'tradesFile' | 'totalPnL' | 'maxDrawdownPct' | 'passed' | 'totalMessages'> => {
  const filled = trades.filter(completedTrade);
  const withPnl = filled.filter((t) => t.pnl != null);
  const wins = withPnl.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = withPnl.filter((t) => (t.pnl ?? 0) < 0).length;
  const breakeven = withPnl.filter((t) => (t.pnl ?? 0) === 0).length;
  const pnls = withPnl.map((t) => t.pnl as number);
  return {
    filledTrades: filled.length,
    wins,
    losses,
    breakeven,
    winRatePct: filled.length > 0 ? (wins / filled.length) * 100 : 0,
    stopped: filled.filter((t) => t.status === 'stopped').length,
    closed: filled.filter((t) => t.status === 'closed').length,
    worstLoss: pnls.length > 0 ? Math.min(...pnls) : 0,
    bestWin: pnls.length > 0 ? Math.max(...pnls) : 0,
  };
};

const tradeRowCsv = (t: Trade): string => {
  const cols = [
    t.id,
    t.created_at,
    t.status,
    t.pnl ?? '',
    t.entry_price,
    t.stop_loss,
    t.quantity ?? '',
    t.entry_filled_at ?? '',
    t.exit_filled_at ?? '',
    t.trading_pair,
  ];
  return cols.map((c) => String(c)).join(',');
};

const writeTradesCsv = async (filePath: string, trades: Trade[]): Promise<void> => {
  const header =
    'trade_id,created_at,status,pnl,entry_price,stop_loss,quantity,entry_filled_at,exit_filled_at,trading_pair';
  const filled = trades
    .filter(completedTrade)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  await fs.writeFile(filePath, [header, ...filled.map(tradeRowCsv)].join('\n') + '\n');
};

export const formatSweepMarkdownTable = (runs: SweepRunSummary[]): string => {
  const sorted = [...runs].sort((a, b) => b.totalPnL - a.totalPnL);
  const lines = [
    '| minRR | PnL | maxDD% | Pass | Filled | W/L | Win% | Stopped | Worst | Best |',
    '|-------|-----|--------|------|--------|-----|------|---------|-------|------|',
  ];
  for (const r of sorted) {
    lines.push(
      `| ${r.minRiskReward.toFixed(2)} | $${r.totalPnL.toFixed(2)} | ${r.maxDrawdownPct.toFixed(2)}% | ${r.passed ? 'yes' : 'no'} | ${r.filledTrades} | ${r.wins}/${r.losses} | ${r.winRatePct.toFixed(1)}% | ${r.stopped} | $${r.worstLoss.toFixed(2)} | $${r.bestWin.toFixed(2)} |`
    );
  }
  return lines.join('\n');
};

const collectChannelTrades = async (db: DatabaseManager, channel: string): Promise<Trade[]> => {
  const statuses = ['pending', 'active', 'closed', 'stopped', 'cancelled'] as const;
  const batches = await Promise.all(statuses.map((s) => db.getTradesByStatus(s)));
  return batches.flat().filter((t) => t.channel === channel);
};

const program = new Command();
program
  .option('-c, --channel <id>', 'Channel ID', '3469900302')
  .option('--months <n>', 'Months back', '5')
  .option('--db-path <path>', 'Eval DB path', 'data/evaluation.db')
  .option('--output-dir <dir>', 'Output directory', 'data/eval-minrr-sweep')
  .option('--monitor-type <type>', 'bybit | ctrader', 'ctrader')
  .option('--prop-firms <firms>', 'Comma-separated prop firms', 'the5ers')
  .option('--risk-percentage <n>', 'Risk % per trade', '1')
  .option('--base-leverage <n>', 'Base leverage', '20')
  .option('--initial-balance <n>', 'Initial balance', '5000')
  .option('--parser <name>', 'Parser override (default: config.json)')
  .parse(process.argv);

const main = async (): Promise<void> => {
  const opts = program.opts();
  const channel = String(opts.channel);
  const months = parseInt(String(opts.months), 10);
  const endDate = dayjs().format('YYYY-MM-DD');
  const startDate = dayjs().subtract(months, 'month').format('YYYY-MM-DD');
  const outputDir = path.resolve(projectRoot, String(opts.outputDir));
  await fs.ensureDir(outputDir);

  const botConfig = await loadBotConfig();
  const channelDefaults = botConfig
    ? resolveChannelEvalDefaults(botConfig, channel, String(opts.monitorType))
    : null;

  const parserName = opts.parser ?? channelDefaults?.parser;
  if (!parserName) {
    throw new Error('Parser required (--parser or config.json channel row)');
  }

  const propFirms = String(opts.propFirms)
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

  const db = new DatabaseManager({ type: 'sqlite', path: String(opts.dbPath) });
  await db.initialize();

  const grid = buildMinRiskRewardGrid();
  const runs: SweepRunSummary[] = [];

  console.log(`\nminRiskReward sweep: ${grid.length} runs`);
  console.log(`  channel=${channel} window=${startDate} → ${endDate}`);
  console.log(`  output=${outputDir}\n`);

  for (let i = 0; i < grid.length; i++) {
    const minRiskReward = grid[i];
    const label = minRiskReward.toFixed(2);
    console.log(`[${i + 1}/${grid.length}] minRiskReward=${label} …`);

    await db.purgeChannelEvaluationData(channel);

    const evalConfig = buildEvaluationConfig(
      {
        channel,
        parser: parserName,
        propFirms,
        startDate,
        endDate,
        initialBalance: parseFloat(String(opts.initialBalance)),
        riskPercentage: parseFloat(String(opts.riskPercentage)),
        baseLeverage: parseFloat(String(opts.baseLeverage)),
        monitorType: String(opts.monitorType) as 'bybit' | 'ctrader',
        minRiskReward,
      },
      channelDefaults
    );

    const result = await runEvaluation(
      db,
      evalConfig,
      channel,
      parserName,
      evalConfig.initiator,
      evalConfig.monitor
    );

    const prop = result.propFirmResults[0];
    const trades = await collectChannelTrades(db, channel);
    const tradeStats = summarizeTrades(trades);
    const tradesFile = path.join(outputDir, `trades-minrr-${label.replace('.', '_')}.csv`);
    await writeTradesCsv(tradesFile, trades);

    const summary: SweepRunSummary = {
      minRiskReward,
      totalPnL: prop?.metrics.totalPnL ?? 0,
      maxDrawdownPct: prop?.metrics.maxDrawdownPercentage ?? 0,
      passed: prop?.passed ?? false,
      totalMessages: result.totalMessages,
      tradesFile: path.relative(projectRoot, tradesFile),
      ...tradeStats,
    };
    runs.push(summary);

    console.log(
      `  → PnL $${summary.totalPnL.toFixed(2)} | maxDD ${summary.maxDrawdownPct.toFixed(2)}% | ` +
        `trades ${summary.filledTrades} | ${summary.passed ? 'PASS' : 'FAIL'}`
    );
  }

  const sorted = [...runs].sort((a, b) => b.totalPnL - a.totalPnL);
  const best = sorted[0];

  await fs.writeJson(path.join(outputDir, 'sweep-results.json'), { startDate, endDate, channel, runs: sorted }, { spaces: 2 });

  const md = [
    `# minRiskReward sweep — ${channel}`,
    ``,
    `Window: ${startDate} → ${endDate} (${months} months)`,
    ``,
    `**Best PnL:** minRR=${best.minRiskReward.toFixed(2)} → $${best.totalPnL.toFixed(2)} (maxDD ${best.maxDrawdownPct.toFixed(2)}%, ${best.passed ? 'PASSED' : 'FAILED'})`,
    ``,
    formatSweepMarkdownTable(runs),
    ``,
    `## Per-run trade CSVs`,
    ...sorted.map(
      (r) =>
        `- minRR ${r.minRiskReward.toFixed(2)}: ${r.tradesFile} (${r.filledTrades} trades, PnL $${r.totalPnL.toFixed(2)})`
    ),
  ].join('\n');

  const mdPath = path.join(outputDir, 'sweep-results.md');
  await fs.writeFile(mdPath, md + '\n');

  console.log('\n' + formatSweepMarkdownTable(runs));
  console.log(`\nBest: minRR=${best.minRiskReward.toFixed(2)} → PnL $${best.totalPnL.toFixed(2)}`);
  console.log(`Results: ${path.relative(projectRoot, mdPath)}`);

  await db.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
