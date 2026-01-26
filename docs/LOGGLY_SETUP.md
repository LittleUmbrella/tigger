# Loggly MCP Integration Setup

This guide explains how to set up Loggly MCP integration for automated log querying during investigations.

## Prerequisites

1. Loggly account with API access
2. Loggly API token (different from the logging token)
3. Loggly subdomain

## Environment Variables

Add these to your `.env` file:

```bash
# Existing Loggly logging config (for winston)
LOGGLY_SUBDOMAIN=your-subdomain
LOGGLY_TOKEN=your-logging-token
LOGGLY_ENABLED=true
LOGGLY_SOURCE_TAG=production

# New: Loggly API token for search queries (get from Loggly dashboard)
LOGGLY_API_TOKEN=your-api-token
```

**Note:** The `LOGGLY_TOKEN` is for sending logs (winston), while `LOGGLY_API_TOKEN` is for querying/searching logs. They may be the same or different depending on your Loggly setup.

## Getting Loggly API Token

1. Log into Loggly dashboard
2. Go to **Settings** → **Source Setup** → **Customer Tokens**
3. Create a new token or use existing one
4. Copy the token to `LOGGLY_API_TOKEN` in your `.env`

Alternatively, if your Loggly account uses API keys:
1. Go to **Settings** → **Account** → **API Keys**
2. Create or use existing API key
3. Use this as `LOGGLY_API_TOKEN`

## Installation

Install dependencies:

```bash
npm install
```

## Usage Options

### Option 1: Direct Client Usage (Simplest)

Use the Loggly client directly in scripts or custom prompts:

```typescript
import { createLogglyClient } from './src/utils/logglyClient.js';

const client = createLogglyClient();
if (client) {
  const results = await client.searchByMessageId(12345, '2394142145');
  console.log(results);
}
```

### Option 2: MCP Server (For Claude Desktop/Cursor)

Run the MCP server as a standalone process:

```bash
# Run MCP server
npm run mcp:loggly
```

Then configure it in your MCP client (Claude Desktop, Cursor, etc.).

### Option 3: Use in Custom Prompts

When using custom prompts with me, I can query Loggly automatically if:
1. The Loggly client is available
2. Environment variables are set
3. You mention "query Loggly" in your prompt

## MCP Server Configuration

### For Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "loggly": {
      "command": "node",
      "args": [
        "/path/to/tigger/dist/mcp/logglyServer.js"
      ],
      "env": {
        "LOGGLY_SUBDOMAIN": "your-subdomain",
        "LOGGLY_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### For Cursor

Add to Cursor's MCP settings (check Cursor documentation for exact location):

```json
{
  "mcpServers": {
    "loggly": {
      "command": "tsx",
      "args": [
        "src/mcp/logglyServer.ts"
      ],
      "env": {
        "LOGGLY_SUBDOMAIN": "your-subdomain",
        "LOGGLY_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

## Testing the Integration

### Test Loggly Client

```bash
# Create a test script
cat > test_loggly.js << 'EOF'
import { createLogglyClient } from './src/utils/logglyClient.js';
import dotenv from 'dotenv';

dotenv.config();

const client = createLogglyClient();
if (!client) {
  console.error('Loggly client not configured');
  process.exit(1);
}

// Test search
const results = await client.search({
  query: 'level:error',
  size: 10
});

console.log('Found', results.total_events, 'events');
console.log('Sample events:', results.events.slice(0, 3));
EOF

node test_loggly.js
```

### Test MCP Server

```bash
# Run MCP server (should start and wait for connections)
npm run mcp:loggly
```

## Available Tools

When MCP is configured, I can use these tools:

1. **loggly_search** - General search with query string
2. **loggly_search_by_message** - Search by message ID and channel
3. **loggly_search_errors_around_time** - Find errors around a timestamp
4. **loggly_search_bybit_errors** - Search for Bybit API errors
5. **loggly_search_order_failures** - Search for order creation failures

## Example Usage in Custom Prompt

```
I need to investigate message ID 12345. Please:
1. Query Loggly for logs related to this message
2. Find errors around the failure time
3. Search for related Bybit API errors
4. Analyze the logs to find root cause
```

I'll automatically use the Loggly MCP tools to gather this information.

## Troubleshooting

### "Loggly client not configured"
- Check that `LOGGLY_SUBDOMAIN` and `LOGGLY_API_TOKEN` are set
- Verify environment variables are loaded (use `dotenv`)

### "Loggly API error: 401"
- Check that `LOGGLY_API_TOKEN` is correct
- Verify token has search permissions
- Check if token has expired

### "Loggly API error: 403"
- Token may not have search permissions
- Check Loggly account permissions
- Verify subdomain is correct

### MCP Server Not Connecting
- Check that server is running
- Verify MCP client configuration
- Check logs for connection errors
- Ensure environment variables are set in MCP config

## Security Notes

- Never commit `.env` file with tokens
- Use environment variables, not hardcoded tokens
- Rotate tokens regularly
- Use least-privilege tokens (search-only if possible)

## Next Steps

1. Set up environment variables
2. Test Loggly client
3. Configure MCP server (if using)
4. Try a custom prompt with "query Loggly"
5. See `docs/CUSTOM_PROMPT_TEMPLATE.md` for prompt examples

