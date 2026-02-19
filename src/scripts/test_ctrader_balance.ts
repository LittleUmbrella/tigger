#!/usr/bin/env node
/**
 * Test cTrader account balance retrieval
 * Uses the same code pattern as ctraderInitiator
 * 
 * Usage:
 *   tsx src/scripts/test_ctrader_balance.ts
 */

import 'dotenv/config';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { logger } from '../utils/logger.js';
import { AccountConfig } from '../types/config.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Get account credentials from account config or environment variables
 * Same pattern as ctraderInitiator
 */
const getAccountCredentials = (account: AccountConfig | null): { 
  clientId: string | undefined; 
  clientSecret: string | undefined; 
  accessToken: string | undefined;
  refreshToken: string | undefined;
  accountId: string | undefined;
  environment: 'demo' | 'live';
} => {
  // Check CTRADER_ENVIRONMENT first, then fall back to account.demo from config
  const envEnvironment = process.env.CTRADER_ENVIRONMENT as 'demo' | 'live' | undefined;
  const environmentFromConfig = account ? (account.demo ? 'demo' : 'live') : 'demo';
  const environment: 'demo' | 'live' = envEnvironment || environmentFromConfig;
  
  if (account) {
    const envVarNameForClientId = account.envVarNames?.apiKey; // Reuse apiKey field for clientId
    const envVarNameForSecret = account.envVarNames?.apiSecret;
    const envVarNameForAccessToken = account.envVarNames?.accessToken;
    const envVarNameForRefreshToken = account.envVarNames?.refreshToken;
    const envVarNameForAccountId = account.envVarNames?.accountId;
    
    return {
      clientId: envVarNameForClientId ? process.env[envVarNameForClientId] : process.env.CTRADER_CLIENT_ID,
      clientSecret: envVarNameForSecret ? process.env[envVarNameForSecret] : process.env.CTRADER_CLIENT_SECRET,
      accessToken: envVarNameForAccessToken ? process.env[envVarNameForAccessToken] : process.env.CTRADER_ACCESS_TOKEN,
      refreshToken: envVarNameForRefreshToken ? process.env[envVarNameForRefreshToken] : process.env.CTRADER_REFRESH_TOKEN,
      accountId: envVarNameForAccountId ? process.env[envVarNameForAccountId] : process.env.CTRADER_ACCOUNT_ID,
      environment
    };
  } else {
    return {
      clientId: process.env.CTRADER_CLIENT_ID,
      clientSecret: process.env.CTRADER_CLIENT_SECRET,
      accessToken: process.env.CTRADER_ACCESS_TOKEN,
      refreshToken: process.env.CTRADER_REFRESH_TOKEN,
      accountId: process.env.CTRADER_ACCOUNT_ID,
      environment
    };
  }
};

/**
 * Test getting account balance from cTrader
 * Uses the same pattern as ctraderInitiator for consistency
 */
const testCTraderBalance = async (): Promise<void> => {
  try {
    logger.info('Starting cTrader balance test');

    // Get account config from config.json (same pattern as initiator)
    const configPath = join(process.cwd(), 'config.json');
    const configData = JSON.parse(readFileSync(configPath, 'utf-8'));
    const accounts = configData.accounts as AccountConfig[] | undefined;
    const account = accounts?.find(acc => acc.name === 'ctrader_demo' && acc.exchange === 'ctrader');
    
    // Get credentials using same pattern as initiator
    const { clientId, clientSecret, accessToken, refreshToken, accountId, environment } = getAccountCredentials(account || null);

    if (!clientId || !clientSecret) {
      logger.error('Missing cTrader credentials', {
        missing: !clientId ? 'CTRADER_CLIENT_ID' : 'CTRADER_CLIENT_SECRET'
      });
      console.error('❌ Missing required credentials: CTRADER_CLIENT_ID and CTRADER_CLIENT_SECRET');
      process.exit(1);
    }

    if (!accessToken || !accountId) {
      logger.warn('Missing access token or account ID - will only authenticate application', {
        hasAccessToken: !!accessToken,
        hasAccountId: !!accountId
      });
      console.warn('⚠️  Missing CTRADER_ACCESS_TOKEN or CTRADER_ACCOUNT_ID - will only test application authentication');
    }

    // Create client config (same pattern as initiator)
    const clientConfig: CTraderClientConfig = {
      clientId,
      clientSecret,
      accessToken,
      refreshToken,
      accountId,
      environment: environment || 'demo'
    };

    logger.info('Creating cTrader client', {
      environment: clientConfig.environment,
      hasAccessToken: !!accessToken,
      hasAccountId: !!accountId
    });

    const ctraderClient = new CTraderClient(clientConfig);

    // Connect and authenticate (same pattern as initiator)
    logger.info('Connecting to cTrader OpenAPI...');
    await ctraderClient.connect();
    logger.info('✅ Connected to cTrader OpenAPI');

    logger.info('Authenticating application...');
    try {
      await ctraderClient.authenticate();
      logger.info('✅ Application authenticated');
    } catch (error: any) {
      // Check if it's an environment mismatch error
      const errorCode = error?.errorCode || error?.payloadType;
      const description = error?.description || error?.message || String(error);
      
      if (errorCode === 'CANT_ROUTE_REQUEST' || description.includes('No environment connection')) {
        const currentEnv: 'demo' | 'live' = clientConfig.environment || 'demo';
        const otherEnv: 'demo' | 'live' = currentEnv === 'demo' ? 'live' : 'demo';
        
        console.error('\n❌ Account authentication failed: Environment mismatch');
        console.error(`   Error: ${description}`);
        console.error(`   Current environment: ${currentEnv.toUpperCase()}`);
        console.error(`   Account ID: ${accountId}`);
        console.error(`\n💡 Suggestion: This account might be in the ${otherEnv.toUpperCase()} environment.`);
        console.error(`   Try setting CTRADER_ENVIRONMENT=${otherEnv} in your .env file`);
        console.error(`   Or check your config.json - the account might need demo: ${otherEnv === 'demo' ? 'true' : 'false'}`);
        
        logger.error('Account authentication failed - environment mismatch', {
          errorCode,
          description,
          currentEnvironment: currentEnv,
          accountId,
          suggestedEnvironment: otherEnv
        });
      } else {
        // Re-throw other errors
        throw error;
      }
      throw error;
    }

    if (!ctraderClient.isConnected()) {
      throw new Error('Client is not connected after authentication');
    }

    // Get detailed account info (requires account authentication)
    if (accessToken && accountId) {
      logger.info('Getting account balance...');
      try {
        const accountInfo = await ctraderClient.getAccountInfo();
        
        logger.info('Account info received', {
          accountInfo: JSON.stringify(accountInfo, null, 2)
        });

        // Extract trader information from account info (same pattern as initiator)
        // ProtoOATraderRes contains a trader object with balance and other details
        const trader = accountInfo?.trader;
        if (trader) {
          const balanceRaw = trader.balance;
          const moneyDigits = trader.moneyDigits || 2;
          
          // Balance is stored as integer (e.g., 2500000 for 25000.00 with 2 digits)
          // Need to divide by 10^moneyDigits to get actual balance
          let balanceValue: number;
          if (balanceRaw !== undefined && balanceRaw !== null) {
            // Handle both number and object formats (protobufjs may return { low, high } for int64)
            if (typeof balanceRaw === 'object' && balanceRaw !== null && 'low' in balanceRaw) {
              // Protobuf int64 format
              balanceValue = (balanceRaw as any).low || 0;
            } else {
              balanceValue = typeof balanceRaw === 'number' ? balanceRaw : parseFloat(String(balanceRaw)) || 0;
            }
            
            const balance = balanceValue / Math.pow(10, moneyDigits);
            const currency = trader.depositAssetId === 15 || trader.depositAssetId === '15' ? 'USD' : 'Unknown';
            const leverage = trader.leverageInCents ? trader.leverageInCents / 100 : 'N/A';
            
            console.log('\n📊 Account Information:');
            console.log(`  Account ID: ${trader.ctidTraderAccountId || accountId}`);
            console.log(`  Trader Login: ${trader.traderLogin || 'N/A'}`);
            console.log(`  Broker: ${trader.brokerName || 'N/A'}`);
            console.log(`  Account Type: ${trader.accountType || 'N/A'}`);
            console.log(`  Access Rights: ${trader.accessRights || 'N/A'}`);
            console.log(`\n💰 Balance: ${balance.toFixed(moneyDigits)} ${currency}`);
            console.log(`  Leverage: ${leverage}:1`);
            console.log(`  Swap Free: ${trader.swapFree ? 'Yes' : 'No'}`);
            console.log(`  Limited Risk: ${trader.isLimitedRisk ? 'Yes' : 'No'}`);
            
            logger.info('Account balance retrieved successfully', {
              accountId: trader.ctidTraderAccountId,
              balance,
              currency,
              leverage
            });
          } else {
            logger.warn('Balance not found in trader object', {
              traderKeys: Object.keys(trader)
            });
            console.log('\n⚠️  Balance not found in trader object');
          }
        } else {
          console.log('\n⚠️  Trader information not found in account info');
          console.log('Account info response:');
          console.log(JSON.stringify(accountInfo, null, 2));
        }
      } catch (error) {
        logger.error('Failed to get account info', {
          error: error instanceof Error ? error.message : String(error)
        });
        console.error('\n❌ Failed to get account info:', error instanceof Error ? error.message : String(error));
        throw error;
      }
    } else {
      console.log('\n⚠️  Cannot get account balance - missing access token or account ID');
      console.log('Set CTRADER_ACCESS_TOKEN and CTRADER_ACCOUNT_ID environment variables');
      console.log('You can get these from https://connect.spotware.com/apps after setting up OAuth');
      console.log('\nCurrent credentials:');
      console.log(`  Client ID: ${clientId ? '✅ Set' : '❌ Missing'}`);
      console.log(`  Client Secret: ${clientSecret ? '✅ Set' : '❌ Missing'}`);
      console.log(`  Access Token: ${accessToken ? '✅ Set' : '❌ Missing'}`);
      console.log(`  Account ID: ${accountId ? '✅ Set' : '❌ Missing'}`);
    }

    // Clean up
    await ctraderClient.disconnect();
    logger.info('✅ Disconnected from cTrader');

    console.log('\n✅ Test completed successfully');
  } catch (error: any) {
    logger.error('Error testing cTrader balance', {
      error: error instanceof Error ? error.message : String(error),
      errorCode: error?.errorCode,
      description: error?.description,
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Show helpful error message
    const errorCode = error?.errorCode;
    const description = error?.description || error?.message || String(error);
    
    console.error('\n❌ Test failed');
    if (errorCode) {
      console.error(`   Error Code: ${errorCode}`);
    }
    console.error(`   Description: ${description}`);
    
    // If it's an error response object, show more details
    if (error && typeof error === 'object' && error.payloadType) {
      console.error(`   Payload Type: ${error.payloadType}`);
      if (error.ctidTraderAccountId) {
        console.error(`   Account ID in error: ${JSON.stringify(error.ctidTraderAccountId)}`);
      }
    }
    
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
};

// Run the test
testCTraderBalance().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
