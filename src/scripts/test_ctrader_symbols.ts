#!/usr/bin/env node
/**
 * List available cTrader symbols and check for perpetual-like instruments
 * 
 * Usage:
 *   tsx src/scripts/test_ctrader_symbols.ts [SEARCH_TERM]
 * 
 * Example:
 *   tsx src/scripts/test_ctrader_symbols.ts BTC
 *   tsx src/scripts/test_ctrader_symbols.ts XAU
 */

import 'dotenv/config';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { logger } from '../utils/logger.js';
import { AccountConfig } from '../types/config.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Get account credentials from account config or environment variables
 */
const getAccountCredentials = (account: AccountConfig | null): { 
  clientId: string | undefined; 
  clientSecret: string | undefined; 
  accessToken: string | undefined;
  refreshToken: string | undefined;
  accountId: string | undefined;
  environment: 'demo' | 'live';
} => {
  const envEnvironment = process.env.CTRADER_ENVIRONMENT as 'demo' | 'live' | undefined;
  const environmentFromConfig = account ? (account.demo ? 'demo' : 'live') : 'demo';
  const environment: 'demo' | 'live' = envEnvironment || environmentFromConfig;
  
  if (account) {
    const envVarNameForClientId = account.envVarNames?.apiKey;
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
  }
  
  return {
    clientId: process.env.CTRADER_CLIENT_ID,
    clientSecret: process.env.CTRADER_CLIENT_SECRET,
    accessToken: process.env.CTRADER_ACCESS_TOKEN,
    refreshToken: process.env.CTRADER_REFRESH_TOKEN,
    accountId: process.env.CTRADER_ACCOUNT_ID,
    environment
  };
};

const testCTraderSymbols = async (searchTerm?: string) => {
  try {
    logger.info('Starting cTrader symbols list', {
      service: 'tigger-bot',
      searchTerm: searchTerm || 'all'
    });

    // Load config
    const configPath = join(process.cwd(), 'config.json');
    const configData = JSON.parse(readFileSync(configPath, 'utf-8'));
    const account = configData.accounts.find((a: AccountConfig) => a.exchange === 'ctrader') || null;
    
    const credentials = getAccountCredentials(account);
    
    if (!credentials.clientId || !credentials.clientSecret || !credentials.accessToken || !credentials.accountId) {
      throw new Error('Missing cTrader credentials. Please set environment variables or configure account in config.json');
    }

    const clientConfig: CTraderClientConfig = {
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      accessToken: credentials.accessToken,
      accountId: credentials.accountId,
      environment: credentials.environment
    };

    logger.info('Creating cTrader client', {
      service: 'tigger-bot',
      environment: clientConfig.environment
    });

    const ctraderClient = new CTraderClient(clientConfig);

    // Connect and authenticate
    logger.info('Connecting to cTrader OpenAPI...', { service: 'tigger-bot' });
    await ctraderClient.connect();
    logger.info('✅ Connected to cTrader OpenAPI', { service: 'tigger-bot' });

    logger.info('Authenticating application...', { service: 'tigger-bot' });
    await ctraderClient.authenticate();
    logger.info('✅ Application authenticated', { service: 'tigger-bot' });

    // Get account info to see leverage
    const accountInfo = await ctraderClient.getAccountInfo();
    const leverage = accountInfo?.leverageInCents ? accountInfo.leverageInCents / 100 : 'N/A';
    console.log(`\n📊 Account Leverage: ${leverage}:1`);
    console.log(`   Note: cTrader uses leveraged CFDs/spot, not perpetual futures\n`);

    // Get all symbols
    const connection = (ctraderClient as any).connection;
    if (!connection) {
      throw new Error('Connection not available');
    }

    const response = await connection.sendCommand('ProtoOASymbolsListReq', {
      ctidTraderAccountId: parseInt(credentials.accountId!, 10)
    });

    const symbols = response?.symbol || [];
    console.log(`\n📋 Found ${symbols.length} total symbols\n`);

    // Filter by search term if provided
    let filteredSymbols = symbols;
    if (searchTerm) {
      const searchUpper = searchTerm.toUpperCase();
      filteredSymbols = symbols.filter((s: any) => 
        s.symbolName?.toUpperCase().includes(searchUpper) ||
        s.description?.toUpperCase().includes(searchUpper)
      );
      console.log(`🔍 Filtered to ${filteredSymbols.length} symbols matching "${searchTerm}"\n`);
    }

    // Display symbols
    if (filteredSymbols.length === 0) {
      console.log('❌ No symbols found');
    } else {
      console.log('Available Symbols:');
      console.log('─'.repeat(80));
      
      filteredSymbols.slice(0, 50).forEach((symbol: any) => {
        const symbolId = typeof symbol.symbolId === 'object' && symbol.symbolId.low !== undefined
          ? symbol.symbolId.low
          : symbol.symbolId;
        
        console.log(`  ${symbol.symbolName?.padEnd(15)} | ID: ${String(symbolId).padEnd(8)} | ${symbol.description || 'N/A'}`);
      });

      if (filteredSymbols.length > 50) {
        console.log(`\n  ... and ${filteredSymbols.length - 50} more symbols`);
      }

      // Try to get price for first symbol if search term provided
      if (searchTerm && filteredSymbols.length > 0) {
        const firstSymbol = filteredSymbols[0];
        const symbolName = firstSymbol.symbolName;
        
        console.log(`\n💰 Getting price for ${symbolName}...`);
        try {
          const price = await ctraderClient.getCurrentPrice(symbolName);
          if (price !== null) {
            console.log(`   Current Price: ${price.toFixed(2)}`);
            console.log(`   Note: This is a leveraged CFD/spot price, not a perpetual futures price`);
          } else {
            console.log(`   ⚠️  Could not retrieve price`);
          }
        } catch (error) {
          console.log(`   ❌ Error getting price: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Disconnect
    await ctraderClient.disconnect();
    logger.info('✅ Disconnected from cTrader', { service: 'tigger-bot' });

    console.log('\n✅ Test completed successfully');
  } catch (error) {
    logger.error('Error testing cTrader symbols', {
      service: 'tigger-bot',
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

// Get search term from command line
const searchTerm = process.argv[2];
testCTraderSymbols(searchTerm);
