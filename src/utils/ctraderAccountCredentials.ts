import { AccountConfig } from '../types/config.js';

export type CTraderResolvedCredentials = {
  clientId: string | undefined;
  clientSecret: string | undefined;
  accessToken: string | undefined;
  refreshToken: string | undefined;
  accountId: string | undefined;
  environment: 'demo' | 'live';
};

/**
 * Resolve cTrader API credentials from account config or environment fallbacks.
 */
export const resolveCtraderAccountCredentials = (
  account: AccountConfig | null
): CTraderResolvedCredentials => {
  if (account) {
    const envVarNameForClientId = account.envVarNames?.apiKey;
    const envVarNameForSecret = account.envVarNames?.apiSecret;
    const envVarNameForAccessToken = account.envVarNames?.accessToken;
    const envVarNameForRefreshToken = account.envVarNames?.refreshToken;
    const envVarNameForAccountId = account.envVarNames?.accountId;

    return {
      clientId: envVarNameForClientId
        ? process.env[envVarNameForClientId]
        : process.env.CTRADER_CLIENT_ID,
      clientSecret: envVarNameForSecret
        ? process.env[envVarNameForSecret]
        : process.env.CTRADER_CLIENT_SECRET,
      accessToken: envVarNameForAccessToken
        ? process.env[envVarNameForAccessToken]
        : process.env.CTRADER_ACCESS_TOKEN,
      refreshToken: envVarNameForRefreshToken
        ? process.env[envVarNameForRefreshToken]
        : process.env.CTRADER_REFRESH_TOKEN,
      accountId: envVarNameForAccountId
        ? process.env[envVarNameForAccountId]
        : process.env.CTRADER_ACCOUNT_ID,
      environment: account.demo ? 'demo' : 'live',
    };
  }

  return {
    clientId: process.env.CTRADER_CLIENT_ID,
    clientSecret: process.env.CTRADER_CLIENT_SECRET,
    accessToken: process.env.CTRADER_ACCESS_TOKEN,
    refreshToken: process.env.CTRADER_REFRESH_TOKEN,
    accountId: process.env.CTRADER_ACCOUNT_ID,
    environment: 'demo',
  };
};

export const getCtraderCredentialGap = (
  creds: CTraderResolvedCredentials
): 'accessToken' | 'accountId' | undefined => {
  if (!creds.accessToken) return 'accessToken';
  if (!creds.accountId) return 'accountId';
  return undefined;
};
