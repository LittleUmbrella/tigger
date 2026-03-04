import http from 'http';
import url from 'url';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 8090;  // Change if you registered a different port
const PATH = '/callback';  // Must match the path in your redirect URI

const CLIENT_ID = process.env.CTRADER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || '';

type AccountDetail = {
  ctidTraderAccountId: number;
  accountNumber?: number;
  brokerName?: string;
  brokerTitle?: string;
  depositCurrency?: string;
  balance?: number;
  moneyDigits?: number;
  live?: boolean;
  accountStatus?: string;
  traderRegistrationTimestamp?: number;
  traderAccountType?: string;
  leverage?: number;
};

/**
 * Fetch accounts for an access token (returns ctidTraderAccountId values).
 * These are the correct IDs for CTRADER_ACCOUNT_ID - NOT the broker account number.
 */
async function getAccessTokenAccounts(accessToken: string): Promise<AccountDetail[]> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.spotware.com',
        path: `/connect/tradingaccounts?access_token=${accessToken}`,
        method: 'GET',
        headers: { Accept: 'application/json' }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const raw = Array.isArray(parsed) ? parsed : parsed?.data ?? [];
            const accounts: AccountDetail[] = raw
              .filter((a: any) => (a.ctidTraderAccountId ?? a.accountId) != null)
              .map((a: any) => ({
                ctidTraderAccountId: a.ctidTraderAccountId ?? a.accountId,
                accountNumber: a.accountNumber,
                brokerName: a.brokerName ?? a.broker_name,
                brokerTitle: a.brokerTitle ?? a.broker_title,
                depositCurrency: a.depositCurrency ?? a.deposit_currency,
                balance: a.balance,
                moneyDigits: a.moneyDigits ?? a.money_digits ?? 2,
                live: a.live,
                accountStatus: a.accountStatus ?? a.account_status,
                traderRegistrationTimestamp: a.traderRegistrationTimestamp ?? a.trader_registration_timestamp,
                traderAccountType: a.traderAccountType ?? a.trader_account_type,
                leverage: a.leverage ?? a.leverageInCents / 100
              }));
            resolve(accounts);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function formatBalance(balance: number | undefined, moneyDigits: number = 2): string {
  if (balance == null) return '—';
  const divisor = Math.pow(10, moneyDigits);
  return (balance / divisor).toLocaleString(undefined, { minimumFractionDigits: moneyDigits });
}

function formatRegistrationDate(ts: number | undefined): string {
  if (ts == null) return '—';
  try {
    return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' });
  } catch {
    return String(ts);
  }
}

/**
 * Exchange authorization code for access token
 */
async function exchangeCodeForToken(code: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const redirectUri = `http://localhost:${PORT}${PATH}`;
    const postData = JSON.stringify({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    const options = {
      hostname: 'connect.spotware.com',
      port: 443,
      path: '/apps/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(response);
          } else {
            reject(new Error(`Token exchange failed: ${res.statusCode} - ${data}`));
          }
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url?.startsWith(PATH)) {
    const query = url.parse(req.url, true).query;
    const authCode = query.code as string;
    const error = query.error as string | undefined;
    const errorDescription = query.error_description as string | undefined;

    if (error) {
      console.error('❌ OAuth error:', error);
      if (errorDescription) {
        console.error('Error description:', decodeURIComponent(errorDescription));
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Error</title></head>
          <body>
            <h1>OAuth Error</h1>
            <p>Error: ${error}</p>
            ${errorDescription ? `<p>Description: ${decodeURIComponent(errorDescription)}</p>` : ''}
            <p>Make sure:</p>
            <ul>
              <li>The redirect URI is registered in your app settings at https://connect.spotware.com/apps</li>
              <li>The redirect URI exactly matches: http://localhost:${PORT}${PATH}</li>
              <li>Your client ID is correct</li>
            </ul>
          </body>
        </html>
      `);
      return;
    }

    console.log('✅ Redirect received!');
    if (authCode) {
      console.log('Authorization code:', authCode);
      
      if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error('❌ Missing CLIENT_ID or CLIENT_SECRET in environment variables');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Error</title></head>
            <body>
              <h1>Configuration Error</h1>
              <p>Missing CLIENT_ID or CLIENT_SECRET. Check your .env file.</p>
            </body>
          </html>
        `);
        return;
      }

      try {
        console.log('Exchanging authorization code for access token...');
        const tokenResponse = await exchangeCodeForToken(authCode);
        const accessToken = tokenResponse.access_token ?? tokenResponse.accessToken;

        console.log('\n✅ Token exchange successful!');
        console.log('\n📋 Add these to your .env file:');
        console.log(`CTRADER_ACCESS_TOKEN=${accessToken}`);
        if (tokenResponse.refresh_token ?? tokenResponse.refreshToken) {
          console.log(`CTRADER_REFRESH_TOKEN=${tokenResponse.refresh_token ?? tokenResponse.refreshToken}`);
        }

        // Fetch account list to show the correct CTRADER_ACCOUNT_ID (ctidTraderAccountId).
        // These are NOT the same as the broker account number in the Connect UI.
        const accounts = await getAccessTokenAccounts(accessToken);
        if (accounts.length > 0) {
          console.log('\n📋 Available accounts (use one of these for CTRADER_ACCOUNT_ID):\n');
          accounts.forEach((acc, i) => {
            const currency = acc.depositCurrency ?? 'USD';
            const balance = formatBalance(acc.balance, acc.moneyDigits);
            const env = acc.live ? 'LIVE' : 'DEMO';
            const broker = acc.brokerTitle ?? acc.brokerName ?? '—';
            const regDate = formatRegistrationDate(acc.traderRegistrationTimestamp);

            console.log(`   ${i + 1}. CTRADER_ACCOUNT_ID=${acc.ctidTraderAccountId}`);
            console.log(`      Broker #: ${acc.accountNumber ?? '—'}  |  ${broker}  |  ${env}`);
            console.log(`      Balance: ${currency} ${balance}  |  Created: ${regDate}  |  Status: ${acc.accountStatus ?? '—'}`);
            if (acc.leverage) console.log(`      Leverage: 1:${acc.leverage}  |  Type: ${acc.traderAccountType ?? '—'}`);
            console.log('');
          });
          console.log('   ⚠️  Use ctidTraderAccountId (above) — NOT the broker account number');
        } else if (tokenResponse.account_id) {
          console.log(`CTRADER_ACCOUNT_ID=${tokenResponse.account_id}`);
        }

        console.log('\nToken response:', JSON.stringify(tokenResponse, null, 2));

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Success</title></head>
            <body>
              <h1>✅ Authorization successful!</h1>
              <p>Check your terminal for the access token.</p>
              <p>Copy the values to your .env file.</p>
              <p>You can safely close this tab now.</p>
            </body>
          </html>
        `);
      } catch (error) {
        console.error('❌ Token exchange failed:', error);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Error</title></head>
            <body>
              <h1>Token Exchange Failed</h1>
              <p>${error instanceof Error ? error.message : String(error)}</p>
            </body>
          </html>
        `);
      }
    } else {
      console.log('No code found in query params.');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Error</title></head>
          <body>
            <h1>No Authorization Code</h1>
            <p>No authorization code was received.</p>
          </body>
        </html>
      `);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, 'localhost', () => {
  const redirectUri = `http://localhost:${PORT}${PATH}`;
  const encodedRedirectUri = encodeURIComponent(redirectUri);
  
  console.log(`🚀 OAuth redirect catcher running at ${redirectUri}`);
  console.log('\n⚠️  IMPORTANT: Make sure this redirect URI is registered in your app settings:');
  console.log(`   Go to https://connect.spotware.com/apps and add: ${redirectUri}`);
  console.log('\n📋 Now open this authorization URL in your browser:');
  
  if (CLIENT_ID) {
    const authUrl = `https://connect.spotware.com/apps/auth?` +
      `client_id=${CLIENT_ID}&` +
      `redirect_uri=${encodedRedirectUri}&` +
      `scope=trading`;
    console.log(`\n${authUrl}\n`);
  } else {
    console.log(`\nhttps://connect.spotware.com/apps/auth?` +
      `client_id=YOUR_CLIENT_ID&` +
      `redirect_uri=${encodedRedirectUri}&` +
      `scope=trading\n`);
    console.log('⚠️  Replace YOUR_CLIENT_ID with your actual client ID from .env');
  }
  
  console.log('\n💡 Scope options:');
  console.log('   - trading: Full access to user trading accounts (default)');
  console.log('   - accounts: Read-only access to user trading account data');
});