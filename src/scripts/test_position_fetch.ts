#!/usr/bin/env node
/**
 * Test Bybit getPositionInfo API call with retry logic
 * Tests the same call pattern used in prop firm validation
 * 
 * Usage:
 *   tsx src/scripts/test_position_fetch.ts --account <account-name>
 *   tsx src/scripts/test_position_fetch.ts --api-key <key> --api-secret <secret> [--testnet] [--demo]
 */

import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs-extra';
import { RestClientV5 } from 'bybit-api';
import { BotConfig } from '../types/config.js';

const program = new Command();

program
  .name('test-position-fetch')
  .description('Test Bybit getPositionInfo API call with retry logic')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--account <name>', 'Account name from config (e.g., demo, testnet)')
  .option('--api-key <key>', 'API key (direct)')
  .option('--api-secret <secret>', 'API secret (direct)')
  .option('--testnet', 'Use testnet (default: false)', false)
  .option('--demo', 'Use demo trading endpoint (api-demo.bybit.com)', false)
  .action(async (options) => {
    try {
      let apiKey: string | undefined;
      let apiSecret: string | undefined;
      let testnet: boolean = false;
      let demo: boolean = false;
      let baseUrl: string | undefined;
      let accountName: string = 'custom';

      // Method 1: Use account from config
      if (options.account) {
        const configPath = options.config || 'config.json';
        if (!fs.existsSync(configPath)) {
          console.error(`❌ Config file not found: ${configPath}`);
          process.exit(1);
        }

        const configContent = await fs.readFile(configPath, 'utf-8');
        const config: BotConfig = JSON.parse(configContent);

        const account = config.accounts?.find(acc => acc.name === options.account);
        if (!account) {
          console.error(`❌ Account "${options.account}" not found in config`);
          console.error(`   Available accounts: ${config.accounts?.map(a => a.name).join(', ') || 'none'}`);
          process.exit(1);
        }

        accountName = account.name;
        testnet = account.testnet || false;
        demo = account.demo || false;
        
        if (demo) {
          baseUrl = 'https://api-demo.bybit.com';
        }

        // Get credentials from account config
        const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
        const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
        apiKey = envVarNameForKey ? process.env[envVarNameForKey] : (account.apiKey || process.env.BYBIT_API_KEY);
        apiSecret = envVarNameForSecret ? process.env[envVarNameForSecret] : (account.apiSecret || process.env.BYBIT_API_SECRET);

        console.log(`\n🔍 Account Config:`);
        console.log(`   Account name: ${account.name}`);
        console.log(`   testnet: ${testnet}`);
        console.log(`   demo: ${demo}`);
        console.log(`   baseUrl: ${baseUrl || 'default'}`);
        console.log(`   API Key env var: ${envVarNameForKey || 'N/A'}`);
        console.log(`   API Secret env var: ${envVarNameForSecret || 'N/A'}`);

        if (!apiKey || !apiSecret) {
          console.error(`❌ API credentials not found for account "${options.account}"`);
          process.exit(1);
        }
      }
      // Method 2: Use direct API key/secret
      else if (options.apiKey && options.apiSecret) {
        accountName = 'direct';
        apiKey = options.apiKey;
        apiSecret = options.apiSecret;
        testnet = options.testnet || false;
        demo = options.demo || false;
        
        if (demo) {
          baseUrl = 'https://api-demo.bybit.com';
        }
      }
      // Method 3: Use default env vars
      else {
        accountName = 'default';
        apiKey = process.env.BYBIT_API_KEY;
        apiSecret = process.env.BYBIT_API_SECRET;
        testnet = process.env.BYBIT_TESTNET === 'true';
        demo = false;
      }

      if (!apiKey || !apiSecret) {
        console.error(`❌ API credentials not found`);
        console.error(`   Set BYBIT_API_KEY and BYBIT_API_SECRET environment variables`);
        console.error(`   Or use --account, --api-key/--api-secret, or --env-key/--env-secret`);
        process.exit(1);
      }

      // Don't use testnet if demo is enabled
      const effectiveTestnet = testnet && !demo;

      console.log(`\n📡 Creating Bybit client:`);
      console.log(`   Account: ${accountName}`);
      console.log(`   Testnet: ${effectiveTestnet}`);
      console.log(`   Demo: ${demo}`);
      console.log(`   Base URL: ${baseUrl || (effectiveTestnet ? 'testnet' : 'production')}`);
      console.log(`   API Key: ${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`);

      const client = new RestClientV5({ 
        key: apiKey, 
        secret: apiSecret, 
        testnet: effectiveTestnet,
        ...(baseUrl && { baseUrl })
      });

      console.log(`\n🧪 Testing getPositionInfo({ category: 'linear' })...\n`);

      // Test 1: Try without additional parameters (original call)
      console.log('Test 1: Calling getPositionInfo({ category: "linear" })');
      try {
        const positionsResponse1 = await client.getPositionInfo({ category: 'linear' });
        
        console.log(`   ✅ Success!`);
        console.log(`   retCode: ${positionsResponse1.retCode}`);
        console.log(`   retMsg: ${positionsResponse1.retMsg || 'N/A'}`);
        
        if (positionsResponse1.retCode === 0) {
          const positions = positionsResponse1.result?.list || [];
          const openPositions = positions.filter((p: any) => {
            const size = parseFloat(p.size || '0');
            return isFinite(size) && size !== 0;
          });
          
          console.log(`   Total positions returned: ${positions.length}`);
          console.log(`   Open positions (size != 0): ${openPositions.length}`);
          
          if (openPositions.length > 0) {
            console.log(`\n   Open positions:`);
            openPositions.forEach((p: any) => {
              console.log(`     - ${p.symbol}: ${p.side} ${p.size} (P&L: ${p.unrealisedPnl || '0'})`);
            });
          }
        } else {
          console.log(`   ⚠️  API returned error code: ${positionsResponse1.retCode}`);
          if (positionsResponse1.retCode === 10001) {
            console.log(`   This is the retCode=10001 error we're trying to fix!`);
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`   ❌ Exception: ${errorMsg}`);
      }

      // Test 2: Try with settleCoin parameter (retry logic)
      console.log(`\nTest 2: Calling getPositionInfo({ category: "linear", settleCoin: "USDT" })`);
      try {
        const positionsResponse2 = await client.getPositionInfo({ 
          category: 'linear',
          settleCoin: 'USDT'
        });
        
        console.log(`   ✅ Success!`);
        console.log(`   retCode: ${positionsResponse2.retCode}`);
        console.log(`   retMsg: ${positionsResponse2.retMsg || 'N/A'}`);
        
        if (positionsResponse2.retCode === 0) {
          const positions = positionsResponse2.result?.list || [];
          const openPositions = positions.filter((p: any) => {
            const size = parseFloat(p.size || '0');
            return isFinite(size) && size !== 0;
          });
          
          console.log(`   Total positions returned: ${positions.length}`);
          console.log(`   Open positions (size != 0): ${openPositions.length}`);
          
          if (openPositions.length > 0) {
            console.log(`\n   Open positions:`);
            openPositions.forEach((p: any) => {
              console.log(`     - ${p.symbol}: ${p.side} ${p.size} (P&L: ${p.unrealisedPnl || '0'})`);
            });
          }
        } else {
          console.log(`   ⚠️  API returned error code: ${positionsResponse2.retCode}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`   ❌ Exception: ${errorMsg}`);
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ Test completed`);
      console.log(`\n💡 Summary:`);
      console.log(`   - If Test 1 succeeds: The original call works for this account`);
      console.log(`   - If Test 1 fails with retCode=10001 but Test 2 succeeds: The retry logic will fix it`);
      console.log(`   - If both fail: The account may need different parameters or has permission issues`);

    } catch (error) {
      console.error('\n❌ Fatal error:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program.parse();

