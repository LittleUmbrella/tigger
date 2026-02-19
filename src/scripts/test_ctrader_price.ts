#!/usr/bin/env node
/**
 * Test cTrader symbol price retrieval
 * Uses the same code pattern as ctraderInitiator
 * 
 * Usage:
 *   tsx src/scripts/test_ctrader_price.ts [SYMBOL]
 * 
 * Example:
 *   tsx src/scripts/test_ctrader_price.ts XAUUSD
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
 * Test getting symbol price from cTrader
 * Uses the same pattern as ctraderInitiator for consistency
 */
const testCTraderPrice = async (symbol: string = 'XAUUSD'): Promise<void> => {
  try {
    logger.info('Starting cTrader price test', { symbol });

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
      logger.error('Missing access token or account ID', {
        hasAccessToken: !!accessToken,
        hasAccountId: !!accountId
      });
      console.error('❌ Missing CTRADER_ACCESS_TOKEN or CTRADER_ACCOUNT_ID');
      console.error('These are required to get symbol prices. Set them in your .env file.');
      process.exit(1);
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
      symbol
    });

    const ctraderClient = new CTraderClient(clientConfig);

    // Connect and authenticate (same pattern as initiator)
    logger.info('Connecting to cTrader OpenAPI...');
    await ctraderClient.connect();
    logger.info('✅ Connected to cTrader OpenAPI');

    logger.info('Authenticating application...');
    await ctraderClient.authenticate();
    logger.info('✅ Application authenticated');

    if (!ctraderClient.isConnected()) {
      throw new Error('Client is not connected after authentication');
    }

    // Get symbol info first (same pattern as initiator)
    logger.info('Getting symbol info...', { symbol });
    try {
      const symbolInfo = await ctraderClient.getSymbolInfo(symbol);
      
      logger.info('Symbol info received', {
        symbol,
        symbolInfo: JSON.stringify(symbolInfo, null, 2)
      });

      console.log('\n📊 Symbol Information:');
      console.log(`  Symbol: ${symbolInfo.symbolName || symbol}`);
      console.log(`  Symbol ID: ${symbolInfo.symbolId || 'N/A'}`);
      console.log(`  Description: ${symbolInfo.description || 'N/A'}`);
      console.log(`  Digits: ${symbolInfo.digits || 'N/A'}`);
      console.log(`  Pip Size: ${symbolInfo.pipSize || 'N/A'}`);
      console.log(`  Volume Precision: ${symbolInfo.volumePrecision || 'N/A'}`);
      console.log(`  Min Volume: ${symbolInfo.minVolume || 'N/A'}`);
      console.log(`  Max Volume: ${symbolInfo.maxVolume || 'N/A'}`);
      console.log(`  Volume Step: ${symbolInfo.volumeStep || 'N/A'}`);

      // Get current price (same pattern as initiator)
      logger.info('Getting current price...', { symbol });
      const currentPrice = await ctraderClient.getCurrentPrice(symbol);
      
      if (currentPrice !== null) {
        const digits = symbolInfo.digits || 2;
        console.log(`\n💰 Current Price: ${currentPrice.toFixed(digits)}`);
        
        // If we have bid/ask info, show spread
        if (symbolInfo.bid && symbolInfo.ask) {
          const bid = symbolInfo.bid;
          const ask = symbolInfo.ask;
          const spread = ask - bid;
          const spreadPips = spread / (symbolInfo.pipSize || 1);
          
          console.log(`  Bid: ${bid.toFixed(digits)}`);
          console.log(`  Ask: ${ask.toFixed(digits)}`);
          console.log(`  Spread: ${spread.toFixed(digits)} (${spreadPips.toFixed(1)} pips)`);
        }
        
        logger.info('Symbol price retrieved successfully', {
          symbol,
          price: currentPrice,
          digits
        });
      } else {
        console.log('\n⚠️  Could not retrieve current price');
        logger.warn('Price retrieval returned null', { symbol });
      }
    } catch (error) {
      logger.error('Failed to get symbol price', {
        symbol,
        error: error instanceof Error ? error.message : String(error)
      });
      console.error('\n❌ Failed to get symbol price:', error instanceof Error ? error.message : String(error));
      throw error;
    }

    // Clean up
    await ctraderClient.disconnect();
    logger.info('✅ Disconnected from cTrader');

    console.log('\n✅ Test completed successfully');
  } catch (error) {
    logger.error('Error testing cTrader price', {
      symbol,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    console.error('\n❌ Test failed:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
};

// Get symbol from command line args or use default
const symbol = process.argv[2] || 'XAUUSD';

// Run the test
testCTraderPrice(symbol).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
