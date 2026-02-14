#!/usr/bin/env node
/**
 * Validate Symbol on Bybit
 *
 * Checks if a trading symbol exists on Bybit (linear perpetual or spot).
 * Used for investigations when Trade Creation fails - rules out "invalid symbol"
 * as a root cause.
 *
 * Usage:
 *   npm run validate-symbol NIL
 *   npm run validate-symbol NILUSDT
 *   npm run validate-symbol NIL --account demo
 *   tsx src/scripts/validate_symbol.ts NIL [--account <name>]
 */

import dotenv from 'dotenv';
import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { RestClientV5 } from 'bybit-api';
import { validateBybitSymbol } from '../initiators/symbolValidator.js';
import { BotConfig } from '../types/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Load .env-investigation first, then .env
const envInvestigationPath = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');
if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const program = new Command();

program
  .name('validate-symbol')
  .description('Validate if a trading symbol exists on Bybit')
  .option('-s, --symbol <symbol>', 'Symbol to validate (e.g., NIL, NILUSDT, 1000FLOKI)')
  .option('--account <name>', 'Account name from config for API credentials (default: first account or BYBIT_* env vars)')
  .option('--config <path>', 'Path to config.json', 'config.json');

program.parse();
const opts = program.opts();
const symbolArg = opts.symbol || program.args[0];
if (!symbolArg) {
  console.error('❌ Symbol required. Usage: npm run validate-symbol NIL  or  --symbol NIL');
  process.exit(1);
}

(async () => {
  try {
    let apiKey: string | undefined = process.env.BYBIT_API_KEY;
    let apiSecret: string | undefined = process.env.BYBIT_API_SECRET;
    let testnet = process.env.BYBIT_TESTNET === 'true';
    let baseUrl: string | undefined;

    if (opts.account || fs.existsSync(opts.config)) {
      const configContent = await fs.readFile(opts.config, 'utf-8');
      const config: BotConfig = JSON.parse(configContent);

      const account = opts.account
        ? config.accounts?.find((acc) => acc.name === opts.account)
        : config.accounts?.[0];

      if (account) {
        const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
        const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
        apiKey = envVarNameForKey ? process.env[envVarNameForKey] : account.apiKey || process.env.BYBIT_API_KEY;
        apiSecret = envVarNameForSecret ? process.env[envVarNameForSecret] : account.apiSecret || process.env.BYBIT_API_SECRET;
        testnet = account.testnet || false;
        baseUrl = account.demo ? 'https://api-demo.bybit.com' : undefined;
      }
    }

      if (!apiKey || !apiSecret) {
        console.error('❌ Bybit API credentials not found');
        console.error('   Set BYBIT_API_KEY and BYBIT_API_SECRET, or use --account with config');
        process.exit(1);
      }

      const bybitClient = new RestClientV5({
        key: apiKey,
        secret: apiSecret,
        testnet,
        ...(baseUrl && { baseUrl })
      });

      const normalizedSymbol = symbolArg.replace('/', '').toUpperCase();
      const symbolToCheck = normalizedSymbol.endsWith('USDT') || normalizedSymbol.endsWith('USDC')
        ? normalizedSymbol
        : `${normalizedSymbol}USDT`;

      console.log(`\n🔍 Validating symbol on Bybit`);
      console.log(`   Symbol: ${symbolToCheck}`);
      console.log(`   Endpoint: ${baseUrl || (testnet ? 'testnet' : 'mainnet')}\n`);

      const result = await validateBybitSymbol(bybitClient, symbolToCheck);

      if (result.valid) {
        console.log(`✅ Symbol is valid and trading on Bybit`);
        console.log(`   Actual symbol: ${result.actualSymbol || symbolToCheck}`);
        process.exit(0);
      } else {
        console.log(`❌ Symbol validation failed`);
        console.log(`   Error: ${result.error || 'Symbol not found'}`);
        if (result.actualSymbol) {
          console.log(`   Note: Symbol exists as ${result.actualSymbol} but may not be in Trading status`);
        }
        process.exit(1);
      }
  } catch (error) {
    console.error('❌ Validation error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();
