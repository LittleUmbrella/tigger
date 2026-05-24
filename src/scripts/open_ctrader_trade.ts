#!/usr/bin/env tsx
/**
 * Open cTrader Trade Script
 *
 * Uses the cTrader initiator to place a trade manually.
 * Requires cTrader credentials (CTRADER_* env vars or --account).
 *
 * Usage:
 *   tsx src/scripts/open_ctrader_trade.ts EURUSD long --sl 1.05 --tp 1.08,1.09,1.10
 *   tsx src/scripts/open_ctrader_trade.ts --channel 3469900302 --content "$(cat signal.txt)"
 *   npm run open-ctrader-trade -- --channel 2120484771 --content "Gold buy now..." --force
 *
 * Options:
 *   --content <text>    Parse channel signal text and place (requires --channel)
 *   --entry <price>     Entry price (omit for market price)
 *   --sl <price>        Stop loss price (required without --content)
 *   --tp <prices>       Take profit prices, comma-separated (required without --content)
 *   --leverage <n>      Leverage (default: 20, manual mode only)
 *   --account <name>    Override account (manual mode default: ctrader_demo_2)
 *   --channel <id>      Channel ID for config context
 *   --dry-run           Simulation mode - no real trade
 *   --force             Bypass existing-trade check
 *   --config <path>     Path to config.json
 */

import dotenv from 'dotenv';
import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import dayjs from 'dayjs';
import { DatabaseManager, Message } from '../db/schema.js';
import { getInitiator } from '../initiators/initiatorRegistry.js';
import { InitiatorContext } from '../initiators/initiatorRegistry.js';
import { BotConfig, ChannelSetConfig, InitiatorConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';
import { parseMessage } from '../parsers/signalParser.js';
import { applyTradeObfuscation } from '../utils/tradeObfuscation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const envInvestigationPath = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

import '../initiators/index.js';

const resolveChannelConfig = (config: BotConfig, channel: string) => {
  const channelConfig = config.channels.find(c => c.channel === channel);
  if (!channelConfig) return null;

  const initiatorConfig = config.initiators.find(
    i => i.name === channelConfig.initiator || i.type === channelConfig.initiator
  );

  return { channelConfig, initiatorConfig };
};

const buildManualOrder = (opts: {
  symbol: string;
  side: string;
  sl: string | undefined;
  tp: string | undefined;
  entry: string | undefined;
  leverage: string;
}): ParsedOrder => {
  const side = opts.side.toLowerCase();
  if (side !== 'long' && side !== 'short') {
    console.error('❌ Side must be "long" or "short"');
    process.exit(1);
  }

  const slPrice = opts.sl != null ? parseFloat(String(opts.sl)) : NaN;
  if (!Number.isFinite(slPrice) || slPrice <= 0) {
    console.error('❌ Stop loss (--sl) is required and must be positive');
    process.exit(1);
  }

  const tpRaw = opts.tp;
  const tpPrices: number[] = tpRaw
    ? String(tpRaw).split(',').map(s => parseFloat(s.trim())).filter(p => Number.isFinite(p) && p > 0)
    : [];
  if (tpPrices.length === 0) {
    console.error('❌ At least one take profit (--tp) is required (e.g. --tp 1.08,1.09,1.10)');
    process.exit(1);
  }

  const leverage = parseInt(opts.leverage, 10);
  if (!Number.isFinite(leverage) || leverage < 1) {
    console.error('❌ Leverage must be a positive number');
    process.exit(1);
  }

  const tradingPair = opts.symbol.replace('/', '').toUpperCase();
  const entryPrice = opts.entry != null ? parseFloat(opts.entry) : undefined;

  return {
    tradingPair: tradingPair.endsWith('USD') || tradingPair.endsWith('USDT') ? tradingPair : `${tradingPair}USD`,
    leverage,
    entryPrice,
    stopLoss: slPrice,
    takeProfits: tpPrices,
    signalType: side as 'long' | 'short'
  };
};

const parseSignalContent = (
  content: string,
  channelConfig: ChannelSetConfig,
  config: BotConfig
): ParsedOrder => {
  const parserConfig = config.parsers?.find(p => p.name === channelConfig.parser);
  const parserOptions = parserConfig?.entryPriceStrategy
    ? { entryPriceStrategy: parserConfig.entryPriceStrategy }
  : undefined;

  let order = parseMessage(content, channelConfig.parser, parserOptions);
  if (!order) {
    console.error(`❌ Could not parse signal with parser "${channelConfig.parser}"`);
    process.exit(1);
  }

  if (channelConfig.tradeObfuscation) {
    order = applyTradeObfuscation(order, channelConfig.tradeObfuscation);
  }

  return order;
};

const program = new Command();

program
  .name('open-ctrader-trade')
  .description('Place a cTrader trade using the initiator')
  .option('-s, --symbol <symbol>', 'Trading pair (e.g. EURUSD, BTCUSD)')
  .option('--side <long|short>', 'long or short')
  .option('-c, --content <text>', 'Channel signal text to parse and place')
  .option('-e, --entry <price>', 'Entry price (omit for market price)')
  .option('--sl <price>', 'Stop loss price')
  .option('-t, --tp <prices>', 'Take profit prices (comma-separated)')
  .option('-l, --leverage <n>', 'Leverage', '20')
  .option('--account <name>', 'Account name override')
  .option('--channel <id>', 'Channel ID for config context')
  .option('--dry-run', 'Simulation mode - no real trade')
  .option('--force', 'Bypass existing-trade check')
  .option('--config <path>', 'Path to config.json', path.join(projectRoot, 'config.json'))
  .action(async (opts) => {
    const posArgs = program.args;
    const symbolArg = opts.symbol || posArgs[0];
    const sideArg = opts.side || posArgs[1];
    const contentMode = Boolean(opts.content?.trim());
    const channelId = opts.channel;

    if (contentMode && !channelId) {
      console.error('❌ --channel is required when using --content');
      process.exit(1);
    }

    if (!contentMode && (!symbolArg || !sideArg)) {
      program.outputHelp();
      const requestedHelp = process.argv.some(a => a === '--help' || a === '-h');
      if (!requestedHelp) {
        console.error('\n❌ Symbol and side are required without --content.');
        console.error('   Example: npm run open-ctrader-trade -- EURUSD long --sl 1.05 --tp 1.08,1.09');
        console.error('   Or:      npm run open-ctrader-trade -- --channel 3469900302 --content "gold buy now..."');
      }
      process.exit(requestedHelp ? 0 : 1);
    }

    if (opts.dryRun && !contentMode && (opts.entry == null || parseFloat(opts.entry) <= 0)) {
      console.error('❌ --dry-run requires --entry in manual mode (simulation cannot fetch live price)');
      process.exit(1);
    }

    const configPath = path.resolve(projectRoot, opts.config);
    if (!(await fs.pathExists(configPath))) {
      console.error(`❌ Config not found: ${configPath}`);
      process.exit(1);
    }

    const config: BotConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const initiatorConfig = config.initiators?.find(i => i.name === 'ctrader');
    if (!initiatorConfig) {
      console.error('❌ cTrader initiator not found in config');
      process.exit(1);
    }

    const ctraderInitiator = getInitiator('ctrader');
    if (!ctraderInitiator) {
      console.error('❌ cTrader initiator not registered');
      process.exit(1);
    }

    let order: ParsedOrder;
    let channel = channelId || 'manual_channel';
    let entryTimeoutMinutes = 90;
    let riskPercentage = initiatorConfig.riskPercentage ?? 1;
    let mergedConfig: InitiatorConfig = { ...initiatorConfig };
    let contextAccounts = config.accounts || [];
    let accountFilters = undefined;
    let propFirms: InitiatorContext['propFirms'] = [];
    let slAdjustmentTolerancePercent: number | undefined;
    let useLimitOrderForEntry: boolean | undefined;
    let maxSkippablePastTPs: number | undefined;
    let useMarketRangeForEntry: boolean | undefined;
    let maxRisk: number | undefined;
    let messageContent: string;

    if (contentMode) {
      const resolved = resolveChannelConfig(config, channelId);
      if (!resolved) {
        console.error(`❌ Channel ${channelId} not found in config`);
        process.exit(1);
      }

      const { channelConfig } = resolved;
      if (channelConfig.initiator !== 'ctrader') {
        console.error(`❌ Channel ${channelId} uses initiator "${channelConfig.initiator}", not cTrader`);
        console.error('   Use the matching data/signal_templates script for Bybit channels.');
        process.exit(1);
      }

      channel = channelConfig.channel;
      order = parseSignalContent(opts.content.trim(), channelConfig, config);
      messageContent = opts.content.trim();

      entryTimeoutMinutes = channelConfig.entryTimeoutMinutes ?? entryTimeoutMinutes;
      riskPercentage = channelConfig.riskPercentage ?? riskPercentage;
      mergedConfig = {
        ...initiatorConfig,
        baseLeverage: channelConfig.baseLeverage ?? initiatorConfig.baseLeverage
      };
      accountFilters = channelConfig.accountFilters;
      propFirms = channelConfig.propFirms;
      slAdjustmentTolerancePercent = channelConfig.slAdjustmentTolerancePercent;
      useLimitOrderForEntry = channelConfig.useLimitOrderForEntry;
      maxSkippablePastTPs = channelConfig.maxSkippablePastTPs;
      useMarketRangeForEntry = channelConfig.useMarketRangeForEntry;
      maxRisk = channelConfig.maxRisk;

      if (opts.account) {
        const account = contextAccounts.find(a => a.name === opts.account && a.exchange === 'ctrader');
        if (!account && !opts.dryRun) {
          console.error(`❌ Account "${opts.account}" not found or not a cTrader account`);
          process.exit(1);
        }
        mergedConfig = { ...mergedConfig, accounts: [opts.account] };
        contextAccounts = account ? [account] : [];
        accountFilters = undefined;
      }

      console.log('Parsed signal:', {
        channel,
        parser: channelConfig.parser,
        symbol: order.tradingPair,
        side: order.signalType,
        entry: order.entryPrice ?? '(market)',
        stopLoss: order.stopLoss,
        takeProfits: order.takeProfits
      });
    } else {
      order = buildManualOrder({
        symbol: symbolArg,
        side: sideArg,
        sl: opts.sl,
        tp: opts.tp,
        entry: opts.entry,
        leverage: opts.leverage
      });
      messageContent = `[Manual Trade] ${order.tradingPair} ${order.signalType} SL=${order.stopLoss} TP=${order.takeProfits.join(',')}`;

      const accountName = opts.account || 'ctrader_demo_2';
      const account = contextAccounts.find(a => a.name === accountName && a.exchange === 'ctrader');
      if (!account && !opts.dryRun) {
        console.error(`❌ Account "${accountName}" not found or not a cTrader account`);
        process.exit(1);
      }

      mergedConfig = {
        ...initiatorConfig,
        baseLeverage: order.leverage ?? parseInt(opts.leverage, 10),
        accounts: [accountName]
      };
      contextAccounts = account ? [account] : [];
    }

    const db = new DatabaseManager();
    await db.initialize();

    const messageId = `manual-${Date.now()}`;
    const messageData = {
      message_id: messageId,
      channel,
      content: messageContent,
      sender: 'open_ctrader_trade',
      date: dayjs().toISOString()
    };

    const msgId = await db.insertMessage(messageData);
    const message: Message = {
      id: msgId,
      ...messageData,
      created_at: dayjs().toISOString(),
      parsed: false,
      analyzed: false
    };

    const context: InitiatorContext = {
      channel,
      riskPercentage,
      entryTimeoutMinutes,
      message,
      order,
      db,
      isSimulation: opts.dryRun ?? false,
      config: mergedConfig,
      accounts: contextAccounts,
      accountFilters,
      propFirms,
      maxRisk,
      slAdjustmentTolerancePercent,
      useLimitOrderForEntry,
      maxSkippablePastTPs,
      useMarketRangeForEntry,
      forcePlaceTrade: opts.force ?? false
    };

    if (opts.dryRun) {
      console.log('\n🔸 DRY RUN - no real trade will be placed\n');
    }

    console.log('Trade parameters:', {
      symbol: order.tradingPair,
      side: order.signalType,
      entry: order.entryPrice ?? '(market)',
      stopLoss: order.stopLoss,
      takeProfits: order.takeProfits,
      leverage: order.leverage,
      channel,
      dryRun: opts.dryRun
    });
    console.log('');

    try {
      await ctraderInitiator(context);
      console.log('\n✅ Trade initiated successfully');
    } catch (error) {
      console.error('\n❌ Trade failed:', error instanceof Error ? error.message : String(error));
      logger.error('open_ctrader_trade failed', {
        error: error instanceof Error ? error.message : String(error),
        channel
      });
      process.exit(1);
    }
  });

program.parse(process.argv);
