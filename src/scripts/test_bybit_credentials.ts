#!/usr/bin/env node
/**
 * Test Bybit API credentials
 * 
 * Usage:
 *   tsx src/scripts/test_bybit_credentials.ts --account <account-name>
 *   tsx src/scripts/test_bybit_credentials.ts --api-key <key> --api-secret <secret> --testnet
 *   tsx src/scripts/test_bybit_credentials.ts --env-key <env-var-name> --env-secret <env-var-name> --testnet
 */

import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs-extra';
import { RestClientV5 } from 'bybit-api';
import { BotConfig, AccountConfig } from '../types/config.js';
import { logger } from '../utils/logger.js';

const program = new Command();

program
  .name('test-bybit-credentials')
  .description('Test Bybit API credentials')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--account <name>', 'Account name from config (e.g., testnet, testnet2)')
  .option('--api-key <key>', 'API key (direct)')
  .option('--api-secret <secret>', 'API secret (direct)')
  .option('--env-key <name>', 'Environment variable name for API key')
  .option('--env-secret <name>', 'Environment variable name for API secret')
  .option('--testnet', 'Use testnet (default: false)', false)
  .option('--demo', 'Use demo trading endpoint (api-demo.bybit.com)', false)
  .action(async (options) => {
    try {
      let apiKey: string | undefined;
      let apiSecret: string | undefined;
      let testnet: boolean = false;
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
        // Note: demo flag is read later when checking account config

        // Get credentials from account config
        const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
        const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
        apiKey = envVarNameForKey ? process.env[envVarNameForKey] : (account.apiKey || process.env.BYBIT_API_KEY);
        apiSecret = envVarNameForSecret ? process.env[envVarNameForSecret] : (account.apiSecret || process.env.BYBIT_API_SECRET);
        
        console.log(`\n🔍 Account Config Check:`);
        console.log(`   Account name: ${account.name}`);
        console.log(`   testnet flag: ${account.testnet}`);
        console.log(`   demo flag: ${account.demo}`);
        console.log(`   envVarNames.apiKey: ${account.envVarNames?.apiKey}`);
        console.log(`   envVarNames.apiSecret: ${account.envVarNames?.apiSecret}`);
        console.log(`   API Key env var value: ${envVarNameForKey ? (process.env[envVarNameForKey] ? 'SET' : 'NOT SET') : 'N/A'}`);
        console.log(`   API Secret env var value: ${envVarNameForSecret ? (process.env[envVarNameForSecret] ? 'SET' : 'NOT SET') : 'N/A'}`);

        if (!apiKey || !apiSecret) {
          console.error(`❌ API credentials not found for account "${options.account}"`);
          if (envVarNameForKey) {
            console.error(`   Expected environment variable for key: ${envVarNameForKey}`);
          }
          if (envVarNameForSecret) {
            console.error(`   Expected environment variable for secret: ${envVarNameForSecret}`);
          }
          process.exit(1);
        }
      }
      // Method 2: Use environment variable names
      else if (options.envKey && options.envSecret) {
        accountName = 'env-vars';
        apiKey = process.env[options.envKey];
        apiSecret = process.env[options.envSecret];
        testnet = options.testnet || false;

        if (!apiKey || !apiSecret) {
          console.error(`❌ Environment variables not set:`);
          if (!apiKey) console.error(`   ${options.envKey} is not set`);
          if (!apiSecret) console.error(`   ${options.envSecret} is not set`);
          process.exit(1);
        }
      }
      // Method 3: Use direct API key/secret
      else if (options.apiKey && options.apiSecret) {
        accountName = 'direct';
        apiKey = options.apiKey;
        apiSecret = options.apiSecret;
        testnet = options.testnet || false;
      }
      else {
        console.error('❌ Must provide one of:');
        console.error('   --account <name> (from config.json)');
        console.error('   --api-key <key> --api-secret <secret> [--testnet] [--demo]');
        console.error('   --env-key <name> --env-secret <name> [--testnet] [--demo]');
        program.help();
        process.exit(1);
      }

      // Show what we're testing (but don't expose full keys)
      const apiKeyPreview = apiKey && apiKey.length > 8 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : '***';
      
      // Check if demo mode (for accounts loaded from config, or via --demo flag)
      let isDemo = false;
      if (options.account) {
        const configPath = options.config || 'config.json';
        if (fs.existsSync(configPath)) {
          try {
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config: BotConfig = JSON.parse(configContent);
            const account = config.accounts?.find(acc => acc.name === options.account);
            isDemo = account?.demo || false;
          } catch {
            // Ignore errors
          }
        }
      } else {
        // For direct/env-var methods, use --demo flag if provided
        isDemo = options.demo || false;
      }
      
      console.log('\n🔐 Testing Bybit Credentials');
      console.log('='.repeat(60));
      console.log(`Account Name: ${accountName}`);
      console.log(`API Key: ${apiKeyPreview}`);
      
      console.log(`Testnet: ${testnet ? 'Yes' : 'No'}`);
      console.log(`Demo: ${isDemo ? 'Yes (api-demo.bybit.com)' : 'No'}`);
      if (isDemo) {
        console.log(`Environment: api-demo.bybit.com (Demo Trading)`);
        console.log(`\n💡 Demo Trading uses api-demo.bybit.com endpoint.`);
        console.log(`   Generate API keys in Demo Trading mode in your Bybit account.`);
      } else {
        console.log(`Environment: ${testnet ? 'testnet.bybit.com' : 'api.bybit.com (Production)'}`);
      }
      console.log('='.repeat(60));

      // Create Bybit client
      const baseUrl = isDemo ? 'https://api-demo.bybit.com' : undefined;
      const effectiveTestnet = testnet && !isDemo; // Don't use testnet if demo is enabled
      
      console.log('\n📡 Client Configuration:');
      console.log(`   Base URL: ${baseUrl || (effectiveTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com')}`);
      console.log(`   Testnet flag: ${effectiveTestnet}`);
      console.log(`   Demo mode: ${isDemo}`);
      console.log(`   API Key length: ${apiKey?.length || 0}`);
      console.log(`   API Secret length: ${apiSecret?.length || 0}`);
      if (!apiKey || !apiSecret) {
        console.error('\n❌ API credentials are missing!');
        console.error(`   API Key: ${apiKey ? 'Set' : 'NOT SET'}`);
        console.error(`   API Secret: ${apiSecret ? 'Set' : 'NOT SET'}`);
        process.exit(1);
      }
      console.log('');
      
      const clientOptions: any = {
        key: apiKey,
        secret: apiSecret,
        testnet: effectiveTestnet
      };
      
      if (baseUrl) {
        clientOptions.baseUrl = baseUrl;
        console.log(`✅ Using custom baseUrl: ${baseUrl}`);
      }
      
      const client = new RestClientV5(clientOptions);

      console.log('\n📡 Testing API connection...\n');

      // Test 1: Get server time (public endpoint, no auth required but tests connection)
      try {
        const serverTimeResponse = await client.getServerTime();
        // Bybit API returns { retCode: 0, retMsg: 'OK', result: { timeSecond: '...' }, ... }
        const timeSecond = (serverTimeResponse as any)?.result?.timeSecond || (serverTimeResponse as any)?.timeSecond;
        
        if (timeSecond) {
          const timestamp = typeof timeSecond === 'string' 
            ? Number(timeSecond) * 1000 
            : (timeSecond < 1e12 ? timeSecond * 1000 : timeSecond);
          console.log('✅ Server time retrieved:', new Date(timestamp).toISOString());
        } else {
          console.log('✅ Server connection successful (time format:', typeof serverTimeResponse, ')');
        }
      } catch (error) {
        // Properly serialize error
        let errorMessage: string;
        if (error instanceof Error) {
          errorMessage = error.message;
        } else if (error && typeof error === 'object') {
          errorMessage = JSON.stringify(error);
        } else {
          errorMessage = String(error);
        }
        console.error('⚠️  Failed to get server time:', errorMessage);
        console.log('   (This is just a connection test - continuing with credential validation...)\n');
      }

      // Test 2: Validate credentials by getting wallet balance (requires valid credentials)
      try {
        console.log('🔍 Attempting to get wallet balance...');
        console.log(`   Using endpoint: ${baseUrl || (effectiveTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com')}`);
        console.log(`   Demo mode: ${isDemo}`);
        console.log(`   Testnet mode: ${effectiveTestnet}`);
        
        const walletBalance = await client.getWalletBalance({ accountType: 'UNIFIED' });
        
        // Check if the response indicates success
        if (walletBalance.retCode === 0) {
          console.log('✅ API credentials are valid!');
          console.log('   Response code:', walletBalance.retCode);
          console.log('   Response message:', walletBalance.retMsg || 'OK');
        } else {
          console.error('❌ API returned error:', walletBalance.retMsg || 'Unknown error');
          console.error('   Error code:', walletBalance.retCode);
          
          if (walletBalance.retCode === 10003) {
            console.error('\n💡 Error 10003: API key is invalid');
            console.error('   This means the API key/secret combination is not valid for this endpoint.');
            if (isDemo) {
              console.error('\n   For Demo Trading:');
              console.error('   - Make sure you generated API keys while in Demo Trading mode');
              console.error('   - Demo Trading uses api-demo.bybit.com endpoint');
              console.error('   - Production/testnet keys will NOT work with demo endpoint');
              console.error('   - Steps:');
              console.error('     1. Log into Bybit');
              console.error('     2. Switch to "Demo Trading" mode (in account settings)');
              console.error('     3. Go to API Management');
              console.error('     4. Create API keys while in Demo Trading mode');
              console.error('     5. Use those keys with your environment variables');
            } else {
              console.error('\n   For Production/Testnet:');
              console.error('   - Verify API key and secret are correct');
              console.error('   - Make sure key is for the correct environment (testnet vs production)');
            }
          }
          process.exit(1);
        }
      } catch (error) {
        // Properly serialize error for display
        let errorMessage: string;
        let errorCode: number | undefined;
        let errorDetails: any = {};
        
        if (error instanceof Error) {
          errorMessage = error.message;
          errorDetails.stack = error.stack;
        } else if (error && typeof error === 'object') {
          const bybitError = error as any;
          errorCode = bybitError.code || bybitError.retCode;
          errorMessage = bybitError.message || bybitError.retMsg || JSON.stringify(bybitError);
          errorDetails = {
            code: bybitError.code,
            retCode: bybitError.retCode,
            retMsg: bybitError.retMsg,
            body: bybitError.body
          };
        } else {
          errorMessage = String(error);
        }
        
        console.error('❌ Failed to validate credentials:', errorMessage);
        if (errorCode !== undefined) {
          console.error('   Error code:', errorCode);
        }
        if (Object.keys(errorDetails).length > 0) {
          console.error('   Error details:', JSON.stringify(errorDetails, null, 2));
        }
        
        // Provide helpful hints based on error code
        if (errorCode === 401) {
          console.error('\n💡 This usually means:');
          console.error('   - API key is invalid');
          console.error('   - API key is for the wrong environment (testnet vs production)');
          console.error('   - API secret is incorrect');
          console.error('   - API key does not have required permissions');
        }
        
        process.exit(1);
      }

      // Test 3: Get wallet balance details (already validated above, now show details)
      try {
        const walletBalance = await client.getWalletBalance({ accountType: 'UNIFIED' });
        const balances = walletBalance.result?.list || [];
        if (balances.length > 0) {
          console.log('\n✅ Wallet balance details:');
          const account = balances[0];
          const coins = account.coin || [];
          if (coins.length > 0) {
            let hasBalance = false;
            coins.forEach((coin: any) => {
              const equity = parseFloat(coin.equity || '0');
              const walletBalance = parseFloat(coin.walletBalance || '0');
              if (equity > 0 || walletBalance > 0) {
                hasBalance = true;
                console.log(`   ${coin.coin}:`);
                if (walletBalance > 0) {
                  console.log(`     Wallet Balance: ${walletBalance} ${coin.coin}`);
                }
                if (equity > 0) {
                  console.log(`     Equity: ${equity} ${coin.coin}`);
                }
                const available = parseFloat(coin.availableToWithdraw || '0');
                if (available > 0) {
                  console.log(`     Available: ${available} ${coin.coin}`);
                }
              }
            });
            if (!hasBalance) {
              console.log('   No balances found (account may be empty)');
            }
          } else {
            console.log('   No coins found (account may be empty)');
          }
        } else {
          console.log('\n✅ Wallet balance retrieved (empty account)');
        }
      } catch (error) {
        // Properly serialize error
        let errorMessage: string;
        if (error instanceof Error) {
          errorMessage = error.message;
        } else if (error && typeof error === 'object') {
          const bybitError = error as any;
          errorMessage = bybitError.message || bybitError.retMsg || JSON.stringify(bybitError);
        } else {
          errorMessage = String(error);
        }
        console.error('\n⚠️  Failed to get wallet balance details:', errorMessage);
        console.error('   (Credentials are valid, but this may be due to missing read permissions)');
      }

      // Test 4: Get positions (requires read permissions)
      try {
        const positions = await client.getPositionInfo({ category: 'linear' });
        const positionList = positions.result?.list || [];
        if (positionList.length > 0) {
          const openPositions = positionList.filter((p: any) => parseFloat(p.size || '0') !== 0);
          if (openPositions.length > 0) {
            console.log('\n✅ Open positions retrieved:');
            openPositions.forEach((pos: any) => {
              console.log(`   ${pos.symbol}: ${pos.side} ${pos.size} (P&L: ${pos.unrealisedPnl || '0'})`);
            });
          } else {
            console.log('\n✅ Positions retrieved (no open positions)');
          }
        } else {
          console.log('\n✅ Positions retrieved (no positions)');
        }
      } catch (error) {
        // Properly serialize error
        let errorMessage: string;
        if (error instanceof Error) {
          errorMessage = error.message;
        } else if (error && typeof error === 'object') {
          const bybitError = error as any;
          errorMessage = bybitError.message || bybitError.retMsg || JSON.stringify(bybitError);
        } else {
          errorMessage = String(error);
        }
        console.error('\n⚠️  Failed to get positions:', errorMessage);
        console.error('   (This may be due to missing read permissions)');
      }

      console.log('\n' + '='.repeat(60));
      console.log('✅ Credentials test completed successfully!');
      console.log('='.repeat(60));
      console.log('\n💡 Summary:');
      console.log(`   - API key is valid for ${testnet ? 'testnet' : 'production'}`);
      console.log(`   - Connection to Bybit ${testnet ? 'testnet' : 'production'} is working`);
      console.log(`   - You can use these credentials with account name: "${accountName}"`);
      console.log('');

      process.exit(0);
    } catch (error) {
      console.error('\n❌ Test failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(1);
    }
  });

program.parse(process.argv);

