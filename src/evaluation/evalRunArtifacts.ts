/**
 * Write evaluation run artifacts (trade CSV + JSON/MD summary) for wizard and optimizer review.
 */

import fs from 'fs-extra';
import path from 'path';
import { Trade } from '../db/schema.js';
import type { EvaluationResult } from './propFirmEvaluator.js';

export interface EvalTradeStats {
  filledTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;
  stopped: number;
  closed: number;
  worstLoss: number;
  bestWin: number;
}

export interface EvalRunSummary extends EvalTradeStats {
  minRiskReward?: number;
  riskPercentage?: number;
  totalPnL: number;
  maxDrawdownPct: number;
  passed: boolean;
  totalMessages: number;
  tradesFile: string;
  propFirmName: string;
  violations?: EvaluationResult['violations'];
}

export const completedTrade = (t: Trade): boolean =>
  t.entry_filled_at != null && t.entry_filled_at !== '';

export const collectChannelTrades = async (
  db: { getTradesByStatus: (status: Trade['status']) => Promise<Trade[]> },
  channel: string
): Promise<Trade[]> => {
  const statuses = ['pending', 'active', 'closed', 'stopped', 'cancelled'] as const;
  const batches = await Promise.all(statuses.map((s) => db.getTradesByStatus(s)));
  return batches.flat().filter((t) => t.channel === channel);
};

export const summarizeTrades = (
  trades: Trade[]
): EvalTradeStats => {
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

export const writeTradesCsv = async (filePath: string, trades: Trade[]): Promise<void> => {
  const header =
    'trade_id,created_at,status,pnl,entry_price,stop_loss,quantity,entry_filled_at,exit_filled_at,trading_pair';
  const filled = trades
    .filter(completedTrade)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  await fs.writeFile(filePath, [header, ...filled.map(tradeRowCsv)].join('\n') + '\n');
};

export const formatRunSummaryRow = (r: EvalRunSummary): string =>
  `| ${r.minRiskReward?.toFixed(2) ?? '—'} | $${r.totalPnL.toFixed(2)} | ${r.maxDrawdownPct.toFixed(2)}% | ${r.passed ? 'yes' : 'no'} | ${r.filledTrades} | ${r.wins}/${r.losses} | ${r.winRatePct.toFixed(1)}% | ${r.stopped} | $${r.worstLoss.toFixed(2)} | $${r.bestWin.toFixed(2)} |`;

export interface WriteEvalRunArtifactsParams {
  outputDir: string;
  projectRoot: string;
  channel: string;
  startDate: string;
  endDate: string;
  months: number;
  minRiskReward?: number;
  riskPercentage?: number;
  propFirmResults: EvaluationResult[];
  totalMessages: number;
  trades: Trade[];
  tradesCsvName?: string;
  jsonName?: string;
  mdName?: string;
  title?: string;
}

export const writeEvalRunArtifacts = async (
  params: WriteEvalRunArtifactsParams
): Promise<{ jsonPath: string; mdPath: string; tradesPath: string }> => {
  const {
    outputDir,
    projectRoot,
    channel,
    startDate,
    endDate,
    months,
    minRiskReward,
    riskPercentage,
    propFirmResults,
    totalMessages,
    trades,
    tradesCsvName = 'trades.csv',
    jsonName = 'run-results.json',
    mdName = 'run-results.md',
    title,
  } = params;

  await fs.ensureDir(outputDir);

  const tradesPath = path.join(outputDir, tradesCsvName);
  await writeTradesCsv(tradesPath, trades);
  const tradeStats = summarizeTrades(trades);
  const tradesFileRel = path.relative(projectRoot, tradesPath);

  const runs: EvalRunSummary[] = propFirmResults.map((prop) => ({
    minRiskReward,
    riskPercentage,
    totalPnL: prop.metrics.totalPnL ?? 0,
    maxDrawdownPct: prop.metrics.maxDrawdownPercentage ?? 0,
    passed: prop.passed,
    totalMessages,
    tradesFile: tradesFileRel,
    propFirmName: prop.propFirmName,
    violations: prop.violations,
    ...tradeStats,
  }));

  const jsonPath = path.join(outputDir, jsonName);
  await fs.writeJson(
    jsonPath,
    { startDate, endDate, months, channel, minRiskReward, riskPercentage, runs },
    { spaces: 2 }
  );

  const primary = runs[0];
  const heading = title ?? `Evaluation run — ${channel}`;
  const mdLines = [
    `# ${heading}`,
    '',
    `Window: ${startDate} → ${endDate} (${months} months)`,
    minRiskReward != null ? `minRiskReward: ${minRiskReward}` : '',
    riskPercentage != null ? `riskPercentage: ${riskPercentage}%` : '',
    '',
  ].filter(Boolean);

  if (primary) {
    mdLines.push(
      `**${primary.propFirmName}:** PnL $${primary.totalPnL.toFixed(2)} | maxDD ${primary.maxDrawdownPct.toFixed(2)}% | ${primary.passed ? 'PASSED' : 'FAILED'}`,
      ''
    );
  }

  mdLines.push(
    '| minRR | PnL | maxDD% | Pass | Filled | W/L | Win% | Stopped | Worst | Best |',
    '|-------|-----|--------|------|--------|-----|------|---------|-------|------|',
    ...runs.map(formatRunSummaryRow),
    '',
    '## Trade CSV',
    `- ${tradesFileRel} (${tradeStats.filledTrades} filled trades)`,
    ''
  );

  if (primary?.violations?.length) {
    mdLines.push('## Violations', '');
    for (const v of primary.violations) {
      mdLines.push(`- **${v.rule}**: ${v.message}`);
    }
    mdLines.push('');
  }

  const mdPath = path.join(outputDir, mdName);
  await fs.writeFile(mdPath, mdLines.join('\n'));

  return { jsonPath, mdPath, tradesPath };
};
