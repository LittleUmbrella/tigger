/**
 * Evaluation Module Entry Point
 * 
 * Provides CLI and programmatic access to the evaluation subsystem
 */

import 'dotenv/config';
import { Command } from 'commander';
import { DatabaseManager } from '../db/schema.js';
import { harvestMessages, HarvestOptions } from './messageHarvester.js';
import { runEvaluation } from './evaluationOrchestrator.js';
import { EvaluationConfig, TradeObfuscationConfig } from '../types/config.js';
import { logger } from '../utils/logger.js';
import fs from 'fs-extra';
import path from 'path';
// Register initiators before using them
import '../initiators/index.js';

const program = new Command();

program
  .name('evaluate')
  .description('Evaluate Telegram channel signals against prop firm rules')
  .version('1.0.0');

/** Parse "min,max" string into { minPercent, maxPercent }. Returns undefined if invalid or not provided. */
const parsePercentRange = (value: string | undefined): { minPercent: number; maxPercent: number } | undefined => {
  if (!value || typeof value !== 'string') return undefined;
  const parts = value.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return undefined;
  return { minPercent: parts[0], maxPercent: parts[1] };
};

/** Build TradeObfuscationConfig from CLI options. Returns undefined if none provided. */
const buildTradeObfuscationFromCli = (options: { obfuscationSl?: string; obfuscationEntry?: string; obfuscationTp?: string }): TradeObfuscationConfig | undefined => {
  const sl = parsePercentRange(options.obfuscationSl);
  const entry = parsePercentRange(options.obfuscationEntry);
  const tp = parsePercentRange(options.obfuscationTp);
  if (!sl && !entry && !tp) return undefined;
  return { ...(sl && { sl }), ...(entry && { entry }), ...(tp && { tp }) };
};

// Helper function to log all options
const logOptions = (commandName: string, options: any) => {
  logger.info('Command options', {
    command: commandName,
    options: JSON.parse(JSON.stringify(options, (key, value) => {
      // Handle undefined values
      if (value === undefined) return undefined;
      return value;
    }))
  });
};

// Harvest command
program
  .command('harvest')
  .description('Harvest historical messages from a Telegram or Discord channel')
  .requiredOption('-c, --channel <channel>', 'Channel identifier (Telegram: username/invite/channel ID, Discord: channel ID)')
  .option('-p, --platform <platform>', 'Platform type: telegram, discord, or discord-selfbot (default: telegram)', 'telegram')
  .option('-a, --access-hash <hash>', 'Access hash for private Telegram channels')
  .option('--bot-token <token>', 'Discord bot token (can also use DISCORD_BOT_TOKEN env var)')
  .option('--user-token <token>', 'Discord user token for self-bot (can also use DISCORD_USER_TOKEN env var)')
  .option('-s, --start-date <date>', 'Start date (YYYY-MM-DD or ISO format)')
  .option('-e, --end-date <date>', 'End date (YYYY-MM-DD or ISO format)')
  .option('-k, --keywords <keywords>', 'Comma-separated keywords to filter messages')
  .option('-l, --limit <n>', 'Maximum messages to harvest (0 = unlimited)', '0')
  .option('-d, --delay <ms>', 'Delay between batches in ms, or "auto"', 'auto')
  .option('--download-images', 'Download and store images from messages', false)
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)', 'data/evaluation.db')
  .option('--db-type <type>', 'Database type: sqlite or postgresql', 'sqlite')
  .action(async (options) => {
    logOptions('harvest', options);
    try {
      const db = new DatabaseManager({
        type: options.dbType,
        path: options.dbType === 'sqlite' ? options.dbPath : undefined,
        url: options.dbType === 'postgresql' ? options.dbPath : undefined,
      });
      await db.initialize();

      const platform = options.platform === 'discord' ? 'discord' 
        : options.platform === 'discord-selfbot' ? 'discord-selfbot'
        : 'telegram';

      const harvestOptions: HarvestOptions = {
        channel: options.channel,
        platform: platform,
        accessHash: options.accessHash,
        botToken: options.botToken,
        userToken: options.userToken,
        startDate: options.startDate,
        endDate: options.endDate,
        keywords: options.keywords ? options.keywords.split(',').map((k: string) => k.trim()) : undefined,
        limit: parseInt(options.limit, 10) || 0,
        delay: options.delay === 'auto' ? 'auto' : parseInt(options.delay, 10) || 0,
        downloadImages: options.downloadImages || false,
      };

      const result = await harvestMessages(db, harvestOptions);
      
      console.log('\n✅ Harvest completed:');
      console.log(`   Total messages processed: ${result.totalMessages}`);
      console.log(`   New messages saved: ${result.newMessages}`);
      console.log(`   Skipped messages: ${result.skippedMessages}`);
      console.log(`   Errors: ${result.errors}`);
      console.log(`   Last message ID: ${result.lastMessageId}\n`);

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Harvest failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Evaluate command
program
  .command('evaluate')
  .description('Run evaluation against prop firm rules')
  .requiredOption('-c, --channel <channel>', 'Channel to evaluate')
  .requiredOption('-p, --parser <parser>', 'Parser name to use')
  .requiredOption('--prop-firms <firms>', 'Comma-separated list of prop firms (e.g., crypto-fund-trader,hyrotrader,mubite)')
  .option('--config <path>', 'Path to evaluation config JSON file')
  .option('--initial-balance <amount>', 'Initial account balance in USDT', '10000')
  .option('--start-date <date>', 'Start date (YYYY-MM-DD or ISO format)')
  .option('--speed-multiplier <n>', 'Speed multiplier (0 = max speed)', '0')
  .option('--max-trade-duration <days>', 'Maximum trade duration in days', '7')
  .option('--risk-percentage <n>', 'Risk percentage per trade', '3')
  .option('--base-leverage <n>', 'Base/default leverage if not specified in message. Also used as confidence indicator for risk adjustment')
  .option('--breakeven-after-tps <n>', 'Number of take profits to hit before moving stop-loss to breakeven (default: 1; ignored if --dynamic-breakeven-after-tps)', '1')
  .option('--dynamic-breakeven-after-tps', 'Scale breakeven threshold from total TP count (see computeDynamicBreakevenAfterTPs)', false)
  .option('--entry-timeout-minutes <n>', 'Minutes to wait for entry before cancelling trade (default: 2880 = 2 days)', '2880')
  .option('--sl-adjustment-tolerance-percent <n>', 'When price past SL, max overshoot % to allow proportional adjustment (0 = reject)')
  .option('--obfuscation-sl <min,max>', 'Trade obfuscation for SL: percent range as "min,max" (e.g. "-0.5,0.5")')
  .option('--obfuscation-entry <min,max>', 'Trade obfuscation for entry: percent range as "min,max" (e.g. "-0.3,0.3")')
  .option('--obfuscation-tp <min,max>', 'Trade obfuscation for TP: percent range as "min,max" (e.g. "-0.2,0.2")')
  .option('--monitor-type <type>', 'Monitor/exchange type: bybit or ctrader (default: bybit)', 'bybit')
  .option('--ctrader-use-tick-data', 'Use tick data instead of M1 candles (ctrader only, more precise)', false)
  .option('--ctrader-symbol-map <json>', 'cTrader symbol map JSON, e.g. \'{"XAUUSD":"GOLD"}\' when broker uses different names')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)', 'data/evaluation.db')
  .option('--db-type <type>', 'Database type: sqlite or postgresql', 'sqlite')
  .action(async (options) => {
    logOptions('evaluate', options);
    try {
      const db = new DatabaseManager({
        type: options.dbType,
        path: options.dbType === 'sqlite' ? options.dbPath : undefined,
        url: options.dbType === 'postgresql' ? options.dbPath : undefined,
      });
      await db.initialize();

      let evalConfig: EvaluationConfig;

      if (options.config) {
        // Load from config file
        const configPath = path.resolve(options.config);
        if (!fs.existsSync(configPath)) {
          throw new Error(`Config file not found: ${configPath}`);
        }
        const configData = await fs.readJson(configPath);
        evalConfig = configData.evaluation;
        if (!evalConfig) {
          throw new Error('No evaluation config found in config file');
        }
      } else {
        // Build config from command line options
        const propFirms = options.propFirms.split(',').map((f: string) => f.trim());
        
        evalConfig = {
          channel: options.channel,
          parser: options.parser,
          initiator: {
            name: 'evaluation',
            riskPercentage: parseFloat(options.riskPercentage) || 3,
            baseLeverage: options.baseLeverage ? parseFloat(options.baseLeverage) : undefined,
            testnet: false,
          },
          monitor: {
            type: options.monitorType || 'bybit',
            testnet: false,
            ctraderUseTickData: options.ctraderUseTickData || false,
            ctraderSymbolMap: options.ctraderSymbolMap ? (() => {
              try {
                return JSON.parse(options.ctraderSymbolMap) as Record<string, string>;
              } catch {
                throw new Error('Invalid --ctrader-symbol-map JSON');
              }
            })() : undefined,
            pollInterval: 10000,
            entryTimeoutMinutes: parseInt(options.entryTimeoutMinutes || '2880', 10),
            breakevenAfterTPs: parseInt(options.breakevenAfterTps || '1', 10),
            dynamicBreakevenAfterTPs: Boolean(options.dynamicBreakevenAfterTps),
          },
          propFirms,
          initialBalance: parseFloat(options.initialBalance) || 10000,
          startDate: options.startDate,
          speedMultiplier: parseFloat(options.speedMultiplier) || 0,
          maxTradeDurationDays: parseFloat(options.maxTradeDuration) || 7,
          slAdjustmentTolerancePercent: options.slAdjustmentTolerancePercent != null ? parseFloat(options.slAdjustmentTolerancePercent) : undefined,
          tradeObfuscation: buildTradeObfuscationFromCli(options),
        };
      }

      console.log('\n🚀 Starting evaluation...\n');
      const result = await runEvaluation(
        db,
        evalConfig,
        evalConfig.channel,
        evalConfig.parser,
        evalConfig.initiator,
        evalConfig.monitor
      );

      console.log('\n📊 Evaluation Results:\n');
      console.log(`Channel: ${result.channel}`);
      console.log(`Total Messages: ${result.totalMessages}`);
      console.log(`Total Trades: ${result.totalTrades}`);
      console.log(`Start Date: ${result.startDate}`);
      console.log(`End Date: ${result.endDate}\n`);

      for (const propFirmResult of result.propFirmResults) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Prop Firm: ${propFirmResult.propFirmName}`);
        console.log(`Status: ${propFirmResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`\nMetrics:`);
        console.log(`  Initial Balance: $${propFirmResult.metrics.initialBalance.toFixed(2)}`);
        console.log(`  Final Balance: $${propFirmResult.metrics.finalBalance.toFixed(2)}`);
        console.log(`  Total P&L: $${propFirmResult.metrics.totalPnL.toFixed(2)} (${propFirmResult.metrics.totalPnLPercentage.toFixed(2)}%)`);
        console.log(`  Max Drawdown: $${propFirmResult.metrics.maxDrawdown.toFixed(2)} (${propFirmResult.metrics.maxDrawdownPercentage.toFixed(2)}%)`);
        console.log(`  Trading Days: ${propFirmResult.metrics.tradingDays}`);
        console.log(`  Total Trades: ${propFirmResult.metrics.totalTrades}`);
        console.log(`  Win Rate: ${propFirmResult.metrics.winRate.toFixed(2)}%`);
        console.log(`  Winning Trades: ${propFirmResult.metrics.winningTrades}`);
        console.log(`  Losing Trades: ${propFirmResult.metrics.losingTrades}`);

        if (propFirmResult.violations.length > 0) {
          console.log(`\n⚠️  Violations (${propFirmResult.violations.length}):`);
          for (const violation of propFirmResult.violations) {
            const icon = violation.severity === 'error' ? '❌' : '⚠️';
            console.log(`  ${icon} [${violation.rule}] ${violation.message}`);
          }
        } else {
          console.log(`\n✅ No violations`);
        }
      }

      console.log(`\n${'='.repeat(60)}\n`);

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Evaluation failed:', error instanceof Error ? error.message : String(error));
      logger.error('Evaluation error', { error: error instanceof Error ? error.stack : String(error) });
      process.exit(1);
    }
  });

// Analyze messages command
program
  .command('analyze')
  .description('Analyze messages to identify signal and management formats')
  .requiredOption('-c, --channel <channel>', 'Channel to analyze')
  .option('--message-ids <ids>', 'Comma-delimited list of message IDs to analyze (if not provided, analyzes all messages)')
  .option('--ollama-url <url>', 'Ollama base URL', 'http://localhost:11434')
  .option('--ollama-model <model>', 'Ollama model to use', 'llama3.2:1b')
  .option('--ollama-timeout <ms>', 'Ollama request timeout in milliseconds', '60000')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)', 'data/evaluation.db')
  .option('--db-type <type>', 'Database type: sqlite or postgresql', 'sqlite')
  .action(async (options) => {
    logOptions('analyze', options);
    try {
      const db = new DatabaseManager({
        type: options.dbType,
        path: options.dbType === 'sqlite' ? options.dbPath : undefined,
        url: options.dbType === 'postgresql' ? options.dbPath : undefined,
      });
      await db.initialize();

      const { analyzeChannelMessages } = await import('./messageAnalyzer.js');
      
      // Parse message IDs if provided (as strings)
      let messageIds: string[] | undefined;
      if (options.messageIds) {
        messageIds = options.messageIds
          .split(',')
          .map((id: string) => id.trim());
      }
      
      const result = await analyzeChannelMessages(db, options.channel, {
        baseUrl: options.ollamaUrl,
        model: options.ollamaModel,
        timeout: parseInt(options.ollamaTimeout, 10) || 60000,
      }, messageIds);

      console.log('\n✅ Analysis completed:');
      console.log(`   Total messages: ${result.totalMessages}`);
      console.log(`   Signals found: ${result.signalsFound}`);
      console.log(`   Management commands found: ${result.managementFound}`);
      console.log(`   Trade progress updates found: ${result.tradeProgressUpdatesFound}`);
      console.log(`   Unique formats: ${result.uniqueFormats}\n`);

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Analysis failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Generate parser command
program
  .command('generate-parser')
  .description('Generate a parser for a channel based on analyzed signal formats')
  .requiredOption('-c, --channel <channel>', 'Channel name')
  .requiredOption('-n, --name <name>', 'Parser name')
  .option('--ollama-url <url>', 'Ollama base URL', 'http://localhost:11434')
  .option('--ollama-model <model>', 'Ollama model to use', 'llama3.2:1b')
  .option('--ollama-timeout <ms>', 'Ollama request timeout in milliseconds', '60000')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)', 'data/evaluation.db')
  .option('--db-type <type>', 'Database type: sqlite or postgresql', 'sqlite')
  .action(async (options) => {
    logOptions('generate-parser', options);
    try {
      const db = new DatabaseManager({
        type: options.dbType,
        path: options.dbType === 'sqlite' ? options.dbPath : undefined,
        url: options.dbType === 'postgresql' ? options.dbPath : undefined,
      });
      await db.initialize();

      const { generateParserForChannel, generateChannelParserIndex } = await import('./parserGenerator.js');
      
      const parserPath = await generateParserForChannel(
        db,
        options.channel,
        options.name,
        {
          baseUrl: options.ollamaUrl,
          model: options.ollamaModel,
          timeout: parseInt(options.ollamaTimeout, 10) || 60000,
        }
      );

      await generateChannelParserIndex(options.channel, options.name);

      console.log('\n✅ Parser generated:');
      console.log(`   Channel: ${options.channel}`);
      console.log(`   Parser name: ${options.name}`);
      console.log(`   Path: ${parserPath}\n`);
      console.log('⚠️  Review and refine the generated parser before using it in production.\n');

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Parser generation failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// List formats command
program
  .command('formats')
  .description('List signal and management formats for a channel')
  .option('-c, --channel <channel>', 'Filter by channel')
  .option('--classification <type>', 'Filter by classification: signal or management')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)', 'data/evaluation.db')
  .option('--db-type <type>', 'Database type: sqlite or postgresql', 'sqlite')
  .action(async (options) => {
    logOptions('formats', options);
    try {
      const db = new DatabaseManager({
        type: options.dbType,
        path: options.dbType === 'sqlite' ? options.dbPath : undefined,
        url: options.dbType === 'postgresql' ? options.dbPath : undefined,
      });
      await db.initialize();

      let formats = await db.getSignalFormats(options.channel);
      
      if (options.classification) {
        formats = formats.filter(f => f.classification === options.classification);
      }

      if (formats.length === 0) {
        console.log('No formats found.');
        await db.close();
        process.exit(0);
      }

      console.log(`\n📋 Signal Formats (${formats.length}):\n`);
      for (const format of formats) {
        console.log(`${'='.repeat(60)}`);
        console.log(`Channel: ${format.channel}`);
        console.log(`Classification: ${format.classification}`);
        console.log(`Examples: ${format.example_count}`);
        console.log(`First seen: ${format.first_seen}`);
        console.log(`Last seen: ${format.last_seen}`);
        console.log(`\nExample format:`);
        console.log(`  ${format.format_pattern.substring(0, 200)}${format.format_pattern.length > 200 ? '...' : ''}`);
        console.log();
      }

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Failed to list formats:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// List results command
program
  .command('results')
  .description('List evaluation results')
  .option('-c, --channel <channel>', 'Filter by channel')
  .option('-f, --firm <firm>', 'Filter by prop firm name')
  .option('--db-path <path>', 'Database path (SQLite) or connection string (PostgreSQL)', 'data/evaluation.db')
  .option('--db-type <type>', 'Database type: sqlite or postgresql', 'sqlite')
  .action(async (options) => {
    logOptions('results', options);
    try {
      const db = new DatabaseManager({
        type: options.dbType,
        path: options.dbType === 'sqlite' ? options.dbPath : undefined,
        url: options.dbType === 'postgresql' ? options.dbPath : undefined,
      });
      await db.initialize();

      const results = await db.getEvaluationResults(options.channel, options.firm);

      if (results.length === 0) {
        console.log('No evaluation results found.');
        await db.close();
        process.exit(0);
      }

      console.log(`\n📋 Evaluation Results (${results.length}):\n`);
      for (const result of results) {
        const metrics = JSON.parse(result.metrics);
        console.log(`${'='.repeat(60)}`);
        console.log(`Channel: ${result.channel}`);
        console.log(`Prop Firm: ${result.prop_firm_name}`);
        console.log(`Status: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`Date: ${new Date(result.created_at).toLocaleString()}`);
        console.log(`Period: ${result.start_date} to ${result.end_date}`);
        console.log(`Total P&L: $${metrics.totalPnL?.toFixed(2) || '0.00'} (${metrics.totalPnLPercentage?.toFixed(2) || '0.00'}%)`);
        console.log(`Trades: ${metrics.totalTrades || 0}`);
        console.log(`Win Rate: ${metrics.winRate?.toFixed(2) || '0.00'}%`);
        console.log();
      }

      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('❌ Failed to list results:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Parse command line arguments
if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse();
}

export { harvestMessages, runEvaluation };
export * from './propFirmRules.js';
export * from './propFirmEvaluator.js';
export * from './evaluationOrchestrator.js';
export * from './messageAnalyzer.js';
export * from './parserGenerator.js';

