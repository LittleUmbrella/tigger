# Slash Command Investigation System

## Overview

A structured, guided investigation system using slash commands (like Speckit). Provides discoverable, consistent workflows for debugging message flow and order execution issues.

## Quick Start

```bash
# List available commands
npm run investigate

# Trace a message
npm run investigate -- /trace message:12345 channel:2394142145

# Full investigation
npm run investigate -- /investigate message:12345

# Analyze a trade
npm run investigate -- /analyze trade:123

# Check logs
npm run investigate -- /check-logs message:12345 channel:2394142145
```

## Available Commands

### `/trace message:<id> [channel:<channel>]`

Traces a message through the entire flow:
1. Message storage in database
2. Message parsing
3. Trade creation
4. Order creation
5. Order execution on Bybit

**Example:**
```bash
npm run investigate -- /trace message:12345 channel:2394142145
```

**Output:**
- Step-by-step trace results
- Failure point identification
- Recommendations
- Next steps

### `/investigate message:<id> [channel:<channel>]`

Full guided investigation workflow:
1. Traces message through system
2. Automatically queries Loggly for related logs
3. Analyzes findings
4. Identifies root cause
5. Provides comprehensive recommendations

**Example:**
```bash
npm run investigate -- /investigate message:12345
```

**Output:**
- Complete trace
- Loggly log analysis
- Root cause analysis
- Actionable recommendations
- Suggested next steps

### `/analyze trade:<trade_id>`

Deep analysis of a specific trade:
1. Gets trade details from database
2. Checks order status on Bybit
3. Reviews related logs
4. Analyzes execution

**Example:**
```bash
npm run investigate -- /analyze trade:123
```

**Output:**
- Trade details
- Order status on Bybit
- TP/SL order status
- Findings and recommendations

### `/check-logs message:<id> channel:<channel> [timeframe:<minutes>]`

Query Loggly for logs related to a message.

**Example:**
```bash
npm run investigate -- /check-logs message:12345 channel:2394142145 timeframe:10
```

**Output:**
- Message-specific logs
- Related errors
- Bybit API errors
- Log entries

## Usage with AI Assistants

### MCP Integration

The investigation commands are exposed as MCP tools, allowing AI assistants to use them directly:

```
User: "Investigate why message 12345 didn't create orders"
AI: [Automatically uses /investigate command]
     → Traces message
     → Queries Loggly
     → Analyzes findings
     → Provides root cause
```

### Custom Prompts

You can also use commands in custom prompts:

```
I need to investigate message 12345. Please:
1. Use /trace to trace the message
2. Use /check-logs to find related errors
3. Analyze the results
```

## Command Structure

All commands follow this structure:

```
/<command> <arg1>:<value1> <arg2>:<value2> ...
```

**Arguments:**
- `message:<id>` - Message ID (number)
- `channel:<channel>` - Channel ID (string)
- `trade:<id>` - Trade ID (number)
- `timeframe:<minutes>` - Time window in minutes (number)
- `query:"<loggly_query>"` - Loggly search query (string)

## Natural Language Support

Commands also support natural language:

```
"trace message 12345" → /trace message:12345
"investigate message 12345" → /investigate message:12345
"analyze trade 123" → /analyze trade:123
```

## Workflow Example

```bash
# 1. Start investigation
npm run investigate -- /investigate message:12345

# Output shows failure at "Entry Order Creation"

# 2. Check logs for that time period
npm run investigate -- /check-logs message:12345 channel:2394142145 timeframe:5

# Output shows Bybit API error: "110003: Insufficient balance"

# 3. Analyze the trade
npm run investigate -- /analyze trade:123

# Output confirms order doesn't exist on Bybit
```

## Integration Points

- **Database**: Queries messages, trades, orders
- **Loggly MCP**: Automatically queries logs
- **Bybit API**: Verifies orders on exchange
- **AI Analysis**: Provides root cause analysis

## Benefits Over Scripts

| Feature | Scripts | Slash Commands |
|---------|---------|----------------|
| Discoverability | ❌ Need to know names | ✅ `/help` shows all |
| Guidance | ❌ Manual | ✅ Guided workflows |
| Consistency | ❌ Varies | ✅ Standardized |
| Automation | ⚠️ Partial | ✅ Full |
| AI Integration | ⚠️ Custom prompts | ✅ Native MCP tools |
| UX | ❌ Command line | ✅ Interactive |

## MCP Server Setup

To use with Claude Desktop or Cursor:

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure MCP client** (see `docs/LOGGLY_SETUP.md` for details)

3. **Commands are automatically available** as MCP tools

## Next Steps

1. Try a command: `npm run investigate -- /trace message:12345`
2. See all commands: `npm run investigate`
3. Use in custom prompts with AI assistants
4. Configure MCP for automatic command execution

This provides a much better investigation experience than scripts + custom prompts!

