/**
 * Resolve Bybit REST credentials and RestClientV5 the same way CLI scripts do
 * (config account, direct keys, env var names, or default BYBIT_* env).
 */

import fs from 'fs-extra';
import { RestClientV5 } from 'bybit-api';
import type { BotConfig, AccountConfig } from '../types/config.js';

export interface ResolveBybitRestClientInput {
  configPath?: string;
  /** Load API keys from this named account in config.json */
  account?: string;
  apiKey?: string;
  apiSecret?: string;
  envKey?: string;
  envSecret?: string;
  /** CLI / explicit testnet (non-config flows) */
  testnet?: boolean;
  /** Overrides account.demo when true */
  demo?: boolean;
}

export interface ResolvedBybitRestSession {
  client: RestClientV5;
  accountName: string;
  /** Raw testnet flag from config or CLI (before demo override) */
  testnet: boolean;
  demo: boolean;
  /** false when demo is on (demo endpoint replaces testnet) */
  effectiveTestnet: boolean;
  baseUrl: string | undefined;
}

function isBybitEligibleAccount(acc: AccountConfig): boolean {
  return acc.exchange === 'bybit' || !acc.exchange || acc.exchange !== 'ctrader';
}

function pickBybitAccount(config: BotConfig, name: string): AccountConfig | undefined {
  return config.accounts?.find((acc) => acc.name === name && isBybitEligibleAccount(acc));
}

function bybitAccountNamesForHelp(config: BotConfig): string {
  const names =
    config.accounts?.filter(isBybitEligibleAccount).map((a) => a.name) ?? [];
  return names.length ? names.join(', ') : 'none';
}

/**
 * Resolve API key/secret and client options. Throws with a short message if credentials are missing.
 */
export async function resolveBybitRestClient(
  input: ResolveBybitRestClientInput
): Promise<ResolvedBybitRestSession> {
  const configPath = input.configPath || 'config.json';

  let apiKey: string | undefined;
  let apiSecret: string | undefined;
  let accountName = 'custom';
  let testnet = input.testnet ?? false;
  let demo = input.demo ?? false;

  if (input.account) {
    if (!(await fs.pathExists(configPath))) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const config: BotConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const account = pickBybitAccount(config, input.account);
    if (!account) {
      const bybitNames = bybitAccountNamesForHelp(config);
      const wrongExchange = config.accounts?.find((a) => a.name === input.account && !isBybitEligibleAccount(a));
      const hint = wrongExchange
        ? ` Account "${input.account}" exists but is not a Bybit account (exchange: ${String(wrongExchange.exchange)}).`
        : '';
      throw new Error(
        `Bybit account "${input.account}" not found.${hint} Use --account with one of: ${bybitNames}`
      );
    }
    accountName = account.name;
    testnet = account.testnet || false;
    demo = input.demo || account.demo || false;

    const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
    const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
    apiKey = envVarNameForKey ? process.env[envVarNameForKey] : (account.apiKey || process.env.BYBIT_API_KEY);
    apiSecret = envVarNameForSecret
      ? process.env[envVarNameForSecret]
      : (account.apiSecret || process.env.BYBIT_API_SECRET);
  } else if (input.envKey && input.envSecret) {
    accountName = 'env-vars';
    apiKey = process.env[input.envKey];
    apiSecret = process.env[input.envSecret];
    testnet = input.testnet ?? false;
    demo = input.demo ?? false;
  } else if (input.apiKey && input.apiSecret) {
    accountName = 'direct';
    apiKey = input.apiKey;
    apiSecret = input.apiSecret;
    testnet = input.testnet ?? false;
    demo = input.demo ?? false;
  } else {
    accountName = 'default-env';
    apiKey = process.env.BYBIT_API_KEY;
    apiSecret = process.env.BYBIT_API_SECRET;
    testnet = input.testnet ?? process.env.BYBIT_TESTNET === 'true';
    demo = input.demo ?? false;
  }

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Bybit API credentials missing. Use --account <name>, --api-key/--api-secret, --env-key/--env-secret, or set BYBIT_API_KEY and BYBIT_API_SECRET.'
    );
  }

  const baseUrl = demo ? 'https://api-demo.bybit.com' : undefined;
  const effectiveTestnet = testnet && !demo;

  const client = new RestClientV5({
    key: apiKey,
    secret: apiSecret,
    testnet: effectiveTestnet,
    ...(baseUrl && { baseUrl }),
  });

  return {
    client,
    accountName,
    testnet,
    demo,
    effectiveTestnet,
    baseUrl,
  };
}
