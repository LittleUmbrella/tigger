import http from 'http';
import url from 'url';

const PORT = 8090;  // Change if you registered a different port
const PATH = '/callback';  // Must match the path in your redirect URI

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
  if (req.url?.startsWith(PATH)) {
    const query = url.parse(req.url, true).query;
    const authCode = query.code;
    const state = query.state;  // optional, if you sent one

    console.log('✅ Redirect received!');
    if (authCode) {
      console.log('Authorization code:', authCode);
      if (state) console.log('State:', state);

      // Optional: You could add token exchange here (see below)
    } else {
      console.log('No code found in query params.');
    }

    // Send a nice response so the browser doesn't show an ugly error
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>Success</title></head>
        <body>
          <h1>Authorization code received!</h1>
          <p>Check your terminal for the code.</p>
          <p>You can safely close this tab now.</p>
        </body>
      </html>
    `);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, 'localhost', () => {
  console.log(`🚀 OAuth redirect catcher running at http://localhost:${PORT}${PATH}`);
  console.log('Now open your authorization URL in a browser.');
  console.log('Example (replace YOUR_CLIENT_ID and scopes):');
  console.log(
    `https://id.ctrader.com/my/settings/openapi/grantingaccess/?` +
    `client_id=YOUR_CLIENT_ID&` +
    `redirect_uri=http://localhost:${PORT}${PATH}&` +
    `scope=accounts_read orders_write trades_read trades_write&` +
    `product=web`
  );
});