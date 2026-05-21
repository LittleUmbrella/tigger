import { AccountConfig } from '../types/config.js';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { logger } from './logger.js';
import {
  getCtraderCredentialGap,
  resolveCtraderAccountCredentials,
} from './ctraderAccountCredentials.js';

export type CtraderStartupAuthResult = {
  accountName: string;
  ok: boolean;
  missing?: 'accessToken' | 'accountId';
  accountId?: string;
  environment?: 'demo' | 'live';
  error?: string;
};

const serializeAuthError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
};

/**
 * Connect and authenticate one cTrader account; disconnect when done.
 * Intended for startup verification before harvesters/monitors run.
 */
export const verifyCtraderAccountAtStartup = async (
  account: AccountConfig
): Promise<CtraderStartupAuthResult> => {
  const accountName = account.name;
  const creds = resolveCtraderAccountCredentials(account);
  const missing = getCtraderCredentialGap(creds);

  if (missing) {
    logger.error('cTrader startup auth failed — credentials not configured', {
      accountName,
      missing,
      envVarNames: account.envVarNames,
      exchange: 'ctrader',
    });
    return { accountName, ok: false, missing, environment: creds.environment };
  }

  const clientConfig: CTraderClientConfig = {
    clientId: creds.clientId || '',
    clientSecret: creds.clientSecret || '',
    accessToken: creds.accessToken!,
    refreshToken: creds.refreshToken,
    accountId: creds.accountId!,
    environment: creds.environment,
  };

  const client = new CTraderClient(clientConfig);
  try {
    await client.connect();
    await client.authenticate();
    logger.info('cTrader startup auth succeeded', {
      accountName,
      accountId: creds.accountId,
      environment: creds.environment,
      exchange: 'ctrader',
    });
    return {
      accountName,
      ok: true,
      accountId: creds.accountId,
      environment: creds.environment,
    };
  } catch (error) {
    const errorMessage = serializeAuthError(error);
    logger.error('cTrader startup auth failed — connect or authenticate error', {
      accountName,
      accountId: creds.accountId,
      environment: creds.environment,
      error: errorMessage,
      exchange: 'ctrader',
    });
    return {
      accountName,
      ok: false,
      accountId: creds.accountId,
      environment: creds.environment,
      error: errorMessage,
    };
  } finally {
    if (client.isConnected()) {
      await client.disconnect().catch((err: unknown) => {
        logger.warn('cTrader startup auth disconnect error', {
          accountName,
          error: serializeAuthError(err),
        });
      });
    }
  }
};

/**
 * Verify every configured cTrader account before trading activity begins.
 */
export const verifyAllCtraderAccountsAtStartup = async (
  accounts: AccountConfig[]
): Promise<CtraderStartupAuthResult[]> => {
  const ctraderAccounts = accounts.filter((a) => a.exchange === 'ctrader');
  if (ctraderAccounts.length === 0) {
    logger.info('cTrader startup auth skipped — no cTrader accounts in config');
    return [];
  }

  logger.info('cTrader startup auth — verifying accounts before trading', {
    accountCount: ctraderAccounts.length,
    accountNames: ctraderAccounts.map((a) => a.name),
  });

  const results = await Promise.all(
    ctraderAccounts.map((account) => verifyCtraderAccountAtStartup(account))
  );

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    logger.info('cTrader startup auth summary — all accounts OK', {
      total: results.length,
      accountNames: succeeded.map((r) => r.accountName),
    });
  } else {
    logger.error('cTrader startup auth summary — failures detected', {
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
      failedAccounts: failed.map((r) => ({
        accountName: r.accountName,
        missing: r.missing,
        error: r.error,
      })),
      succeededAccounts: succeeded.map((r) => r.accountName),
    });
  }

  return results;
};
