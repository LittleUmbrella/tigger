import http from 'http';
import url from 'url';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const PORT = 8090;  // Change if you registered a different port
const PATH = '/callback';  // Must match the path in your redirect URI

const CLIENT_ID = process.env.CTRADER_CLIENT_ID || '';
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || '';

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
        
        console.log('\n✅ Token exchange successful!');
        console.log('\n📋 Add these to your .env file:');
        console.log(`CTRADER_ACCESS_TOKEN=${tokenResponse.access_token}`);
        if (tokenResponse.refresh_token) {
          console.log(`CTRADER_REFRESH_TOKEN=${tokenResponse.refresh_token}`);
        }
        if (tokenResponse.account_id) {
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