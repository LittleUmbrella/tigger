/**
 * Interactive workflow: harvest → optional sample message IDs (printed for manual parser work) →
 * evaluate with an existing parser over a 1–5 month window.
 *
 * When config.json contains a matching channel row, evaluation defaults mirror live bot settings
 * (entry timeout, concurrent symbols, obfuscation, prop firms, etc.). CLI flags override config.
 */

import '../initiators/index.js';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import dayjs from 'dayjs';
import { DatabaseManager } from '../db/schema.js';
import { harvestMessages } from './messageHarvester.js';
import { runEvaluation } from './evaluationOrchestrator.js';
import type { HarvestOptions } from './messageHarvester.js';
import {
  buildEvaluationConfig,
  formatChannelEvalDefaultsSummary,
  loadBotConfig,
  resolveChannelEvalDefaults,
} from './channelEvalConfig.js';
import { CustomPropFirmConfig } from '../types/config.js';

export interface ChannelEvalWizardOptions {
  channel?: string;
  months?: string;
  platform?: string;
  skipHarvest?: boolean;
  sampleIds?: string;
  /** If true, do not prompt for sample IDs or print reference text */
  skipSamples?: boolean;
  parserName?: string;
  propFirms?: string;
  dbPath?: string;
  dbType?: string;
  riskPercentage?: string;
  baseLeverage?: string;
  monitorType?: string;
  initialBalance?: string;
  /** Path to config.json (default: CONFIG_PATH or config.json) */
  configPath?: string;
  /** Skip loading channel defaults from config.json */
  noChannelConfig?: boolean;
  entryTimeoutMinutes?: string;
  /** Auto-confirm harvest and other y/n prompts (non-interactive) */
  yes?: boolean;
}

async function question(
  rl: ReturnType<typeof createInterface>,
  text: string,
  defaultValue?: string
): Promise<string> {
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]: ` : ': ';
  const raw = (await rl.question(text + suffix)).trim();
  if (!raw && defaultValue !== undefined) return defaultValue;
  return raw;
}

function parseMonths(value: string | undefined): number {
  const n = parseInt(value || '3', 10);
  if (!Number.isFinite(n) || n < 1 || n > 5) {
    throw new Error('Months must be an integer from 1 to 5');
  }
  return n;
}

async function printSampleMessageReferences(
  db: DatabaseManager,
  channel: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;

  console.log('\n--- Sample message(s) for manual parser work (human / agent) ---\n');
  for (const id of ids) {
    const msg = await db.getMessageByMessageId(id, channel);
    if (!msg) {
      console.log(`message_id ${id}: not found in DB for this channel\n`);
      continue;
    }
    const preview =
      msg.content.length > 4000 ? `${msg.content.slice(0, 4000)}\n… [truncated]` : msg.content;
    console.log(`message_id=${id}`);
    console.log(`date=${msg.date}`);
    console.log('---');
    console.log(preview);
    console.log('');
  }
  console.log(
    '--- Use the text above to implement or choose a parser, then enter its registry name at the prompt. ---\n'
  );
}

const PLATFORM_OPTIONS = new Set(['telegram', 'discord', 'discord-selfbot']);

const parsePropFirms = (value: string): (string | CustomPropFirmConfig)[] =>
  value.split(',').map((f) => f.trim()).filter(Boolean);

export async function runChannelEvalWizard(cli: ChannelEvalWizardOptions): Promise<void> {
  const rl = createInterface(process.stdin as any, process.stdout as any);
  let db: DatabaseManager | undefined;

  try {
    let channel = cli.channel?.trim() || (await question(rl, 'Channel ID or username')).trim();
    if (!channel) {
      throw new Error('Channel is required');
    }

    const useChannelConfig = !cli.noChannelConfig;
    const botConfig = useChannelConfig ? await loadBotConfig(cli.configPath) : null;
    const channelDefaults =
      botConfig && useChannelConfig
        ? resolveChannelEvalDefaults(botConfig, channel, cli.monitorType)
        : null;

    if (channelDefaults) {
      console.log(
        `\nUsing channel defaults from config.json: ${formatChannelEvalDefaultsSummary(channelDefaults)}\n`
      );
    } else if (useChannelConfig && botConfig) {
      console.log(`\nNo config.json row for channel ${channel}; using CLI / prompts only.\n`);
    }

    const monthsStr =
      cli.months?.trim() ||
      (await question(
        rl,
        'Months back from today (1-5). Oldest messages = start of this span; newest = today',
        '3'
      ));
    const months = parseMonths(monthsStr);
    const endHarvestDate = dayjs().format('YYYY-MM-DD');
    const startHarvestDate = dayjs().subtract(months, 'month').format('YYYY-MM-DD');

    console.log(
      `\nEvaluation message window: ${startHarvestDate} (oldest, startDate) → ${endHarvestDate} (newest inclusive, endDate).\n` +
        '  startDate = furthest back to include; endDate = latest day to include (not the lookback length).\n'
    );
    let platformRaw =
      cli.platform?.trim() ||
      (await question(rl, 'Platform (telegram | discord | discord-selfbot)', 'telegram')).trim();
    platformRaw = platformRaw || 'telegram';
    if (!PLATFORM_OPTIONS.has(platformRaw)) {
      throw new Error(`Invalid platform: ${platformRaw}`);
    }
    const platform = platformRaw as HarvestOptions['platform'];

    const dbPath = cli.dbPath || (await question(rl, 'Database path', 'data/evaluation.db'));
    const dbType = cli.dbType || (await question(rl, 'Database type (sqlite | postgresql)', 'sqlite'));
    if (dbType !== 'sqlite' && dbType !== 'postgresql') {
      throw new Error(`Invalid db type: ${dbType}`);
    }

    db = new DatabaseManager({
      type: dbType,
      path: dbType === 'sqlite' ? dbPath : undefined,
      url: dbType === 'postgresql' ? dbPath : undefined,
    });
    await db.initialize();

    const skipHarvest = Boolean(cli.skipHarvest);
    const nonInteractive = Boolean(cli.yes || cli.channel?.trim());
    if (!skipHarvest) {
      let go = 'y';
      if (!nonInteractive) {
        go = (await question(rl, `Harvest ${channel} from ${startHarvestDate} to ${endHarvestDate}? (y/n)`, 'y'))
          .toLowerCase();
      } else {
        console.log(
          `\nHarvest ${channel} from ${startHarvestDate} to ${endHarvestDate} (auto-confirmed — channel set via CLI)\n`
        );
      }
      if (go !== 'y' && go !== 'yes') {
        console.log('Skipped harvest. Ensure messages for this window are already in the database.');
      } else {
        const harvestOpts: HarvestOptions = {
          channel,
          platform,
          startDate: startHarvestDate,
          endDate: endHarvestDate,
          limit: 0,
          delay: 'auto',
        };
        console.log('\nHarvesting…');
        const harvestResult = await harvestMessages(db, harvestOpts);
        console.log(
          `Done: processed ${harvestResult.totalMessages}, new ${harvestResult.newMessages}, skipped ${harvestResult.skippedMessages}, errors ${harvestResult.errors}\n`
        );
      }
    }

    let sampleIds: string[] = [];
    if (cli.skipSamples) {
      // no samples
    } else if (cli.sampleIds?.trim()) {
      sampleIds = cli.sampleIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      console.log(
        'Optional: enter message IDs from this channel (as stored after harvest), one per line.\n' +
          'Text is printed so you or an agent can implement a parser. Empty line skips.\n'
      );
      for (;;) {
        const line = (await rl.question('Sample message ID (blank to finish): ')).trim();
        if (!line) break;
        sampleIds.push(line);
      }
    }

    await printSampleMessageReferences(db, channel, sampleIds);

    const defaultParser = channelDefaults?.parser ?? '';
    let parserName = cli.parserName?.trim() || defaultParser;
    if (!parserName) {
      parserName = (await question(rl, 'Parser registry name (must already exist; see src/parsers/signalParser)', defaultParser)).trim();
    } else if (cli.parserName?.trim() && channelDefaults?.parser && cli.parserName.trim() !== channelDefaults.parser) {
      console.log(
        `\nNote: CLI parser "${cli.parserName.trim()}" overrides config.json parser "${channelDefaults.parser}" for this channel.\n`
      );
    } else if (!cli.parserName?.trim() && channelDefaults?.parser) {
      console.log(`\nUsing parser from config.json: ${channelDefaults.parser}\n`);
    }
    if (!parserName) {
      throw new Error('Parser name is required (implement and register it before running evaluation).');
    }
    if (!/^[$A-Za-z_][$0-9A-Za-z_]*$/.test(parserName)) {
      throw new Error(`Invalid parser name "${parserName}"`);
    }

    const { getParser } = await import('../parsers/parserRegistry.js');
    const parserFn = await getParser(parserName);
    if (!parserFn) {
      throw new Error(
        `Parser "${parserName}" not loaded. Register it in src/parsers/signalParser.ts or add it under src/parsers/channels/*/ then rebuild.`
      );
    }

    const defaultPropFirms =
      channelDefaults?.propFirms?.map((f) => (typeof f === 'string' ? f : f.name)).join(',') ??
      'crypto-fund-trader';
    const propFirmsStr =
      cli.propFirms?.trim() ||
      (await question(rl, 'Prop firms (comma-separated)', defaultPropFirms));
    const propFirms = parsePropFirms(propFirmsStr);
    if (propFirms.length === 0) {
      throw new Error('At least one prop firm name is required.');
    }

    const defaultRisk = String(channelDefaults?.riskPercentage ?? 3);
    const riskPercentage =
      parseFloat(cli.riskPercentage || (await question(rl, 'Risk % per trade', defaultRisk))) || 3;

    const defaultLeverage =
      cli.baseLeverage ??
      (channelDefaults?.baseLeverage != null ? String(channelDefaults.baseLeverage) : '');
    const baseLeverageRaw =
      defaultLeverage || (await question(rl, 'Base leverage (optional, blank to omit)', ''));
    const baseLeverage = baseLeverageRaw.trim() ? parseFloat(baseLeverageRaw) : undefined;

    const defaultMonitor = channelDefaults?.monitorType ?? 'bybit';
    const monitorType =
      cli.monitorType || (await question(rl, 'Monitor type (bybit | ctrader)', defaultMonitor));
    if (monitorType !== 'bybit' && monitorType !== 'ctrader') {
      throw new Error(`Invalid monitor type: ${monitorType}`);
    }

    const defaultBalance = String(
      cli.initialBalance != null
        ? cli.initialBalance
        : (channelDefaults?.initialBalance ?? 10000)
    );
    const initialBalance =
      parseFloat(cli.initialBalance || (await question(rl, 'Initial balance (USDT)', defaultBalance))) ||
      10000;

    const entryTimeoutMinutes = cli.entryTimeoutMinutes
      ? parseInt(cli.entryTimeoutMinutes, 10)
      : channelDefaults?.entryTimeoutMinutes;

    const evalConfig = buildEvaluationConfig(
      {
        channel,
        parser: parserName,
        propFirms,
        startDate: startHarvestDate,
        endDate: endHarvestDate,
        initialBalance,
        riskPercentage,
        baseLeverage,
        monitorType: monitorType as 'bybit' | 'ctrader',
        entryTimeoutMinutes,
      },
      channelDefaults
    );

    console.log('\nRunning evaluation (this may take a while)…');
    console.log(
      `  entryTimeout=${evalConfig.monitor.entryTimeoutMinutes}m` +
        ` concurrentSymbols=${evalConfig.allowConcurrentSymbolTrades ?? false}` +
        (evalConfig.tradeObfuscation ? ` obfuscation=${JSON.stringify(evalConfig.tradeObfuscation)}` : '')
    );
    const result = await runEvaluation(db, evalConfig, channel, parserName, evalConfig.initiator, evalConfig.monitor);

    console.log('\nEvaluation summary');
    console.log(`  Channel: ${result.channel}`);
    console.log(
      `  Message window: ${startHarvestDate} (oldest/startDate) → ${endHarvestDate} (newest/endDate)`
    );
    console.log(`  Messages in window: ${result.totalMessages}`);
    console.log(`  Completed trades (with entry fill): ${result.totalTrades}`);
    console.log(`  Last simulated activity: ${result.endDate}`);
    for (const p of result.propFirmResults) {
      console.log(`  ${p.propFirmName}: ${p.passed ? 'PASSED' : 'FAILED'} — PnL $${p.metrics.totalPnL.toFixed(2)}`);
    }

    await db.close();
    db = undefined;
  } catch (err) {
    if (db) {
      await db.close().catch(() => undefined);
    }
    throw err;
  } finally {
    rl.close();
  }
}
