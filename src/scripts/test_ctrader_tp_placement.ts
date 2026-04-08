#!/usr/bin/env node
/**
 * Test cTrader take profit placement (single-TP via modifyPosition, multi-TP via placeLimitOrder)
 *
 * Requires an open position. Verifies the TP placement flow end-to-end including
 * volume conversion (API units -> lots).
 *
 * Usage:
 *   tsx src/scripts/test_ctrader_tp_placement.ts --symbol XAUUSD --tp 2650
 *   tsx src/scripts/test_ctrader_tp_placement.ts --symbol XAUUSD --tp 2650 2660 2670
 *   tsx src/scripts/test_ctrader_tp_placement.ts --position-id 12345 --tp 2650 2660
 *   tsx src/scripts/test_ctrader_tp_placement.ts --symbol XAUUSD --tp 2650 --dry-run
 *   npm run test-ctrader-tp
 *
 * Options:
 *   --symbol <name>    Symbol (e.g. XAUUSD) - used to find position if --position-id not given
 *   --position-id <id> Specific position ID (optional; otherwise first position for symbol)
 *   --tp <prices...>   Take profit price(s). One = single-TP (modifyPosition), multiple = limit orders
 *   --dry-run          Validate flow only, do not place orders
 */

import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { AccountConfig } from '../types/config.js';
import { roundPrice, distributeQuantityAcrossTPs, validateAndRedistributeTPQuantities, type TpSplitRoundingOptions } from '../utils/positionSizing.js';

const CTRADER_TP_SPLIT_OPTIONS: TpSplitRoundingOptions = { lastSliceRounding: 'floor' };
import { protobufLongToNumber } from '../utils/protobufLong.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

const envPath = path.join(projectRoot, '.env-investigation');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

const getAccountCredentials = (account: AccountConfig | null) => {
  const environment = (process.env.CTRADER_ENVIRONMENT as 'demo' | 'live') ||
    (account?.demo ? 'demo' : 'live');
  return {
    clientId: process.env.CTRADER_CLIENT_ID,
    clientSecret: process.env.CTRADER_CLIENT_SECRET,
    accessToken: process.env.CTRADER_ACCESS_TOKEN,
    refreshToken: process.env.CTRADER_REFRESH_TOKEN,
    accountId: process.env.CTRADER_ACCOUNT_ID,
    environment
  };
};

// Normalize cTrader symbol (e.g. "XAUUSD" -> "XAUUSD", "EUR/USD" -> "EURUSD")
const normalizeSymbol = (s: string) => s.replace(/\//g, '').toUpperCase();

const program = new Command();
program
  .name('test-ctrader-tp')
  .description('Test cTrader take profit placement (single-TP and multi-TP)')
  .option('--symbol <name>', 'Symbol (e.g. XAUUSD)')
  .option('--position-id <id>', 'Specific position ID')
  .option('--tp <prices...>', 'Take profit price(s)')
  .option('--dry-run', 'Validate only, do not place orders')
  .option('--config <path>', 'Path to config.json', path.join(projectRoot, 'config.json'));

program.parse();
const opts = program.opts();
const tpPrices = opts.tp
  ? (Array.isArray(opts.tp) ? opts.tp : [opts.tp]).map((p: string) => parseFloat(p)).filter((n: number) => !isNaN(n))
  : [];

const main = async () => {
  if (tpPrices.length === 0) {
    console.error('❌ At least one TP price (--tp) is required');
    process.exit(1);
  }

  const configPath = opts.config;
  const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const account = (config.accounts || []).find(
    (a: AccountConfig) => a.name === 'ctrader_demo' && a.exchange === 'ctrader'
  );

  const creds = getAccountCredentials(account);
  if (!creds.clientId || !creds.clientSecret || !creds.accessToken || !creds.accountId) {
    console.error('❌ Missing CTRADER_* credentials');
    process.exit(1);
  }

  const client = new CTraderClient({ ...creds } as CTraderClientConfig);
  await client.connect();
  await client.authenticate();

  const symbol = opts.symbol ? normalizeSymbol(opts.symbol) : undefined;
  const positionIdArg = opts.positionId;
  const dryRun = !!opts.dryRun;

  console.log('\n📋 Fetching positions...\n');
  const positions = await client.getOpenPositions();

  let position: (typeof positions)[0] | undefined;
  if (positionIdArg) {
    position = positions.find(
      (p: any) => String(p.positionId ?? p.id) === String(positionIdArg)
    );
  } else if (symbol) {
    position = positions.find((p: any) => {
      const pSym = (p.symbolName || p.symbol || '').replace(/\//g, '').toUpperCase();
      return pSym === symbol && (p.volume ?? p.quantity);
    });
  } else {
    position = positions.find((p: any) => (p.volume ?? p.quantity) > 0);
  }

  if (!position) {
    console.error('❌ No position found. Open a position first (e.g. npm run open-ctrader-trade) or specify --symbol and/or --position-id');
    await client.disconnect();
    process.exit(1);
  }

  const posId = position.positionId ?? position.id;
  const posSymbol = (position.symbolName || position.symbol || '').replace(/\//g, '');
  const positionVolume = Math.abs(Number(position.volume ?? position.quantity ?? 0));
  const positionSide = (position.tradeSide || position.side || '').toUpperCase() as 'BUY' | 'SELL';

  if (positionVolume <= 0) {
    console.error('❌ Position has zero volume');
    await client.disconnect();
    process.exit(1);
  }

  console.log('Position:', {
    symbol: posSymbol,
    positionId: posId,
    volume: positionVolume,
    side: positionSide
  });

  const symbolInfo = await client.getSymbolInfo(posSymbol);
  const lotSize = protobufLongToNumber(symbolInfo.lotSize) ?? 100;
  const stepVolume = protobufLongToNumber(symbolInfo.stepVolume) ?? lotSize;
  const pricePrecision = symbolInfo.digits ?? 5;
  const quantityPrecision = symbolInfo.volumePrecision ?? 2;
  const volumeStep = protobufLongToNumber(symbolInfo.volumeStep) ?? protobufLongToNumber(symbolInfo.stepVolume) ?? lotSize;
  const minOrderVolume = protobufLongToNumber(symbolInfo.minVolume) ?? 0;
  const maxOrderVolume = protobufLongToNumber(symbolInfo.maxVolume);

  console.log('Symbol info:', { lotSize, stepVolume, minOrderVolume, maxOrderVolume });

  const roundedTPPrices = tpPrices.map((p) => roundPrice(p, pricePrecision, undefined));
  const tpSide = positionSide === 'BUY' ? 'SELL' : 'BUY';

  if (roundedTPPrices.length === 1 && tpPrices.length === 1) {
    // Single TP: modifyPosition
    console.log('\n=== Single TP (modifyPosition) ===');
    console.log('TP price:', roundedTPPrices[0]);
    if (dryRun) {
      console.log('(dry-run: would call modifyPosition)');
    } else {
      await client.modifyPosition({
        positionId: String(posId),
        takeProfit: roundedTPPrices[0]
      });
      console.log('✅ modifyPosition succeeded');
    }
  } else {
    // Multi TP: placeLimitOrder for each
    console.log('\n=== Multi TP (placeLimitOrder) ===');
    const tpQuantities = distributeQuantityAcrossTPs(
      positionVolume,
      roundedTPPrices.length,
      quantityPrecision,
      CTRADER_TP_SPLIT_OPTIONS
    );
    const validTPOrders = validateAndRedistributeTPQuantities(
      tpQuantities,
      roundedTPPrices,
      positionVolume,
      volumeStep,
      minOrderVolume,
      maxOrderVolume,
      quantityPrecision,
      CTRADER_TP_SPLIT_OPTIONS
    );

    if (validTPOrders.length === 0) {
      console.error('❌ No valid TP orders (quantities round to zero or below min)');
      await client.disconnect();
      process.exit(1);
    }

    for (const tp of validTPOrders) {
      const volumeLots = tp.quantity / lotSize;
      console.log(`  TP ${tp.index}: price=${tp.price} volApi=${tp.quantity} volLots=${volumeLots.toFixed(4)}`);
    }

    if (dryRun) {
      console.log('(dry-run: would place limit orders)');
    } else {
      for (const tp of validTPOrders) {
        const volumeLots = tp.quantity / lotSize;
        const orderId = await client.placeLimitOrder({
          symbol: posSymbol,
          volume: volumeLots,
          tradeSide: tpSide,
          price: tp.price,
          positionId: String(posId) // Link to position so order auto-cancels when position closes
        });
        console.log(`  ✅ TP ${tp.index} order placed: ${orderId}`);
      }
    }
  }

  console.log('');
  await client.disconnect();
};

main().catch((e) => {
  console.error('Error:', e);
  process.exit(1);
});
