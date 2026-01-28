# Loggly Integration Complete

## What's Been Set Up

1. **Loggly Client** (`src/utils/logglyClient.ts`)
   - Programmatic access to Loggly search API
   - Helper methods for common queries
   - Can be used directly in scripts or custom prompts

2. **MCP Server** (`src/mcp/logglyServer.ts`)
   - Model Context Protocol server for AI assistants
   - Exposes Loggly queries as MCP tools
   - Can be used with Claude Desktop, Cursor, etc.

3. **Query Script** (`src/scripts/query_loggly.ts`)
   - Standalone CLI tool for manual Loggly queries
   - Useful for testing and quick investigations

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

This installs `@modelcontextprotocol/sdk` for MCP support.

### 2. Configure Environment Variables

Add to your `.env`:

```bash
LOGGLY_SUBDOMAIN=your-subdomain
LOGGLY_API_TOKEN=your-api-token  # For search queries
# OR use existing LOGGLY_TOKEN if same token works for both
```

### 3. Test the Integration

```bash
# Test direct query
npm run query-loggly -- search "level:error"

# Test message search
npm run query-loggly -- message 12345 2394142145

# Test error search
npm run query-loggly -- errors "2025-01-15T10:30:00Z" 5
```

### 4. Use in Custom Prompts

Now when you use custom prompts, I can automatically query Loggly:

```
I need to investigate message ID 12345. Please:
1. Query Loggly for logs related to this message
2. Find errors around the failure time  
3. Search for related Bybit API errors
4. Analyze the logs to find root cause
```

I'll automatically use the Loggly client to gather this information.

### 5. Configure MCP Server (Optional)

If you want to use MCP with Claude Desktop or Cursor:

1. **Install MCP SDK** (already in package.json)
2. **Configure MCP client** (see `docs/LOGGLY_SETUP.md`)
3. **Run MCP server**: `npm run mcp:loggly`

## Usage Examples

### Direct Client Usage

```typescript
import { createLogglyApiClient } from './src/utils/logglyClient.js';

const client = createLogglyApiClient();
if (client) {
  // Search by message ID
  const results = await client.searchByMessageId(12345, '2394142145');
  
  // Search for errors
  const errors = await client.searchErrorsAroundTime('2025-01-15T10:30:00Z', 5);
  
  // Search for Bybit errors
  const bybitErrors = await client.searchBybitErrors();
}
```

### CLI Usage

```bash
# General search
npm run query-loggly -- search "messageId:12345 AND channel:2394142145"

# Message-specific search
npm run query-loggly -- message 12345 2394142145

# Error search around timestamp
npm run query-loggly -- errors "2025-01-15T10:30:00Z" 5

# Bybit errors
npm run query-loggly -- bybit

# Order failures
npm run query-loggly -- orders demo
```

### Custom Prompt Usage

```
I need to investigate why orders weren't created for message ID 12345.

[I'll automatically query Loggly for:]
- messageId:12345 AND channel:2394142145
- Errors around the failure timestamp
- Related Bybit API errors
- Order creation failures

[Then provide analysis with actual log evidence]
```

## Integration with Trace Script

The trace script can now optionally include Loggly data:

```bash
# Get trace + Loggly data
npm run trace-message 12345 2394142145 --json > trace.json
# Then use custom prompt with trace.json
```

Or I can query Loggly directly when you use a custom prompt with the trace output.

## Next Steps

1. ✅ Install dependencies: `npm install`
2. ✅ Set environment variables
3. ✅ Test with `npm run query-loggly`
4. ✅ Try a custom prompt with "query Loggly"
5. ✅ (Optional) Configure MCP server for Claude Desktop/Cursor

## Files Created

- `src/utils/logglyClient.ts` - Loggly API client
- `src/mcp/logglyServer.ts` - MCP server
- `src/scripts/query_loggly.ts` - CLI query tool
- `docs/LOGGLY_SETUP.md` - Setup instructions
- `docs/LOGGLY_INTEGRATION_COMPLETE.md` - This file

## Troubleshooting

See `docs/LOGGLY_SETUP.md` for troubleshooting tips.

Common issues:
- **"Loggly client not configured"** → Set environment variables
- **"401 Unauthorized"** → Check API token
- **"403 Forbidden"** → Check token permissions
- **MCP not connecting** → Check MCP client configuration

## Benefits

Now you have:
- ✅ Automatic log querying in custom prompts
- ✅ Direct programmatic access to Loggly
- ✅ CLI tool for manual queries
- ✅ MCP integration for AI assistants
- ✅ Deep analysis with actual log data

This transforms investigations from "manual log gathering" to "automatic comprehensive analysis"!

