#!/usr/bin/env tsx
/**
 * Open cTrader Trade Script
 *
 * Uses the cTrader initiator to place a trade manually.
 * Requires cTrader credentials (CTRADER_* env vars or --account).
 *
 * Usage:
 *   tsx src/scripts/open_ctrader_trade.ts EURUSD long --sl 1.05 --tp 1.08 1.09 1.10
 *   tsx src/scripts/open_ctrader_trade.ts BTCUSD short --entry 95000 --sl 96000 --tp 94000 93000
 *   npm run open-ctrader-trade EURUSD long -- --sl 1.05 --tp 1.08
 *
 * Options:
 *   --entry <price>     Entry price (omit for market price)
 *   --sl <price>       Stop loss price (required)
 *   --tp <prices...>   Take profit prices (at least one required)
 *   --leverage <n>     Leverage (default: 20)
 *   --account <name>   Account from config (default: ctrader_demo)
 *   --channel <id>     Channel ID for context (default: 3469900302)
 *   --dry-run          Simulation mode - no real trade
 *   --config <path>    Path to config.json
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
import { BotConfig, InitiatorConfig, AccountConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Load .env from project root (before any other imports that use env vars)
const envInvestigationPath = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

// Register initiators (required before getInitiator)
import '../initiators/index.js';

const program = new Command();

program
  .name('open-ctrader-trade')
  .description('Place a cTrader trade using the initiator')
  .option('-s, --symbol <symbol>', 'Trading pair (e.g. EURUSD, BTCUSD)')
  .option('--side <long|short>', 'long or short')
  .option('-e, --entry <price>', 'Entry price (omit for market price)')
  .option('--sl <price>', 'Stop loss price')
  .option('-t, --tp <prices>', 'Take profit prices (comma-separated, e.g. 1.08,1.09,1.10)')
  .option('-l, --leverage <n>', 'Leverage', '20')
  .option('--account <name>', 'Account name from config', 'ctrader_demo')
  .option('--channel <id>', 'Channel ID for context', 'manual_channel')
  .option('--dry-run', 'Simulation mode - no real trade')
  .option('--force', 'Bypass existing-trade check (use when DB has stale data)')
  .option('--config <path>', 'Path to config.json', path.join(projectRoot, 'config.json'));

program.parse();
const opts = program.opts();

// Support positional args: symbol side (e.g. EURUSD long)
const posArgs = program.args;
const symbolArg = opts.symbol || posArgs[0];
const sideArg = opts.side || posArgs[1];

if (!symbolArg || !sideArg) {
  program.outputHelp();
  const requestedHelp = process.argv.some((a) => a === '--help' || a === '-h');
  if (!requestedHelp) {
    console.error('\n❌ Symbol and side are required. Example: npm run open-ctrader-trade EURUSD long -- --sl 1.05 --tp 1.08,1.09');
    process.exit(1);
  }
  process.exit(0);
}

const side = sideArg.toLowerCase();
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
  ? (Array.isArray(tpRaw)
      ? tpRaw.map((v) => (typeof v === 'number' ? v : parseFloat(String(v))))
      : String(tpRaw).split(',').map((s) => parseFloat(s.trim())))
        .filter((p: number) => Number.isFinite(p) && p > 0)
  : [];
if (tpPrices.length === 0 || tpPrices.some((p: number) => p <= 0)) {
  console.error('❌ At least one take profit (--tp) is required and must be positive (e.g. --tp 1.08,1.09,1.10)');
  process.exit(1);
}

if (opts.dryRun && (opts.entry == null || parseFloat(opts.entry) <= 0)) {
  console.error('❌ --dry-run requires --entry (simulation cannot fetch live price)');
  process.exit(1);
}

const leverage = parseInt(opts.leverage, 10);
if (!Number.isFinite(leverage) || leverage < 1) {
  console.error('❌ Leverage must be a positive number');
  process.exit(1);
}

const run = async (): Promise<void> => {
  const configPath = path.resolve(projectRoot, opts.config);
  if (!(await fs.pathExists(configPath))) {
    console.error(`❌ Config not found: ${configPath}`);
    process.exit(1);
  }

  const configData = await fs.readFile(configPath, 'utf-8');
  const config: BotConfig = JSON.parse(configData);

  const initiatorConfig = config.initiators?.find((i) => i.name === 'ctrader');
  if (!initiatorConfig) {
    console.error('❌ cTrader initiator not found in config');
    process.exit(1);
  }

  const accounts = config.accounts || [];
  const account = accounts.find((a) => a.name === opts.account && a.exchange === 'ctrader');
  if (!account && !opts.dryRun) {
    console.error(`❌ Account "${opts.account}" not found or not a cTrader account`);
    process.exit(1);
  }

  const ctraderInitiator = getInitiator('ctrader');
  if (!ctraderInitiator) {
    console.error('❌ cTrader initiator not registered');
    process.exit(1);
  }

  // Normalize symbol (cTrader format: EURUSD, BTCUSD)
  const tradingPair = symbolArg.replace('/', '').toUpperCase();
  if (!tradingPair.endsWith('USD') && !tradingPair.endsWith('USDT')) {
    console.warn(`⚠️  Symbol normalized to ${tradingPair}USD (cTrader typically uses XXXUSD)`);
  }

  const entryPrice = opts.entry != null ? parseFloat(opts.entry) : undefined;

  const order: ParsedOrder = {
    tradingPair: tradingPair.endsWith('USD') || tradingPair.endsWith('USDT') ? tradingPair : `${tradingPair}USD`,
    leverage,
    entryPrice,
    stopLoss: slPrice,
    takeProfits: tpPrices,
    signalType: side as 'long' | 'short'
  };

  const db = new DatabaseManager();
  await db.initialize();

  const messageId = `manual-${Date.now()}`;
  const messageData = {
    message_id: messageId,
    channel: opts.channel,
    content: `[Manual Trade] ${tradingPair} ${side} SL=${slPrice} TP=${tpPrices.join(',')}`,
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

  const mergedConfig: InitiatorConfig = {
    ...initiatorConfig,
    baseLeverage: leverage,
    accounts: [opts.account]
  };

  const context: InitiatorContext = {
    channel: opts.channel,
    riskPercentage: initiatorConfig.riskPercentage ?? 1,
    entryTimeoutMinutes: 90,
    message,
    order,
    db,
    isSimulation: opts.dryRun ?? false,
    config: mergedConfig,
    accounts: account ? [account] : [],
    accountFilters: undefined,
    propFirms: [],
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
    account: opts.account,
    dryRun: opts.dryRun
  });
  console.log('');

  try {
    await ctraderInitiator(context);
    console.log('\n✅ Trade initiated successfully');
  } catch (error) {
    console.error('\n❌ Trade failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

run();
