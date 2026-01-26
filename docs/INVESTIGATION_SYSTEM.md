# Investigation System: Slash Commands + Structured Workflows

## Overview

A Speckit-style slash command system for investigating message flow and order execution issues. Provides discoverable, guided workflows that automatically gather data, analyze findings, and provide recommendations.

## Architecture

```
User Input: /investigate message:12345
    ↓
Command Parser
    ↓
Command Registry
    ↓
Workflow Engine
    ├─→ Database Query
    ├─→ Loggly Query (via MCP)
    ├─→ Bybit Query
    └─→ AI Analysis
    ↓
Structured Output
    ├─→ Findings
    ├─→ Recommendations
    └─→ Next Steps
```

## Components

### 1. Command Registry (`src/investigation/commandRegistry.ts`)
- Registers and manages command handlers
- Provides command descriptions and examples
- Enables command discovery

### 2. Command Parser (`src/investigation/commandParser.ts`)
- Parses slash commands: `/trace message:12345`
- Supports natural language: "trace message 12345"
- Extracts arguments and validates

### 3. Workflow Engine (`src/investigation/workflowEngine.ts`)
- Executes structured workflows step-by-step
- Tracks progress and results
- Handles errors and skips

### 4. Commands (`src/investigation/commands/`)
- `/trace` - Trace message through system
- `/investigate` - Full guided investigation
- `/analyze` - Deep trade analysis
- `/check-logs` - Query Loggly logs

### 5. CLI Interface (`src/investigation/cli.ts`)
- Command-line interface for direct use
- Shows help and examples
- Formats output nicely

### 6. MCP Server (`src/mcp/investigationServer.ts`)
- Exposes commands as MCP tools
- Works with Claude Desktop, Cursor, etc.
- Enables AI assistant integration

## Usage

### CLI Usage

```bash
# List commands
npm run investigate

# Trace a message
npm run investigate -- /trace message:12345 channel:2394142145

# Full investigation
npm run investigate -- /investigate message:12345

# Analyze trade
npm run investigate -- /analyze trade:123

# Check logs
npm run investigate -- /check-logs message:12345 channel:2394142145 timeframe:10
```

### With AI Assistants (MCP)

When MCP is configured, AI assistants can use commands directly:

```
User: "Investigate message 12345"
AI: [Uses /investigate command automatically]
     → Traces message
     → Queries Loggly
     → Analyzes findings
     → Provides root cause and recommendations
```

### In Custom Prompts

You can reference commands in prompts:

```
I need to investigate message 12345. Please:
1. Use /trace to trace the message
2. Use /check-logs to find related errors
3. Analyze the results and provide root cause
```

## Command Details

### `/trace message:<id> [channel:<channel>]`

**Purpose:** Trace a message through the entire flow

**Workflow:**
1. Find message in database
2. Check if parsed
3. Find associated trades
4. Check order creation
5. Verify orders on Bybit

**Output:**
- Step-by-step results
- Failure point identification
- Recommendations
- Next steps

### `/investigate message:<id> [channel:<channel>]`

**Purpose:** Full guided investigation

**Workflow:**
1. Trace message (automatic)
2. Query Loggly for related logs (automatic)
3. Analyze findings (automatic)
4. Identify root cause (automatic)
5. Provide recommendations (automatic)

**Output:**
- Complete trace
- Loggly analysis
- Root cause
- Actionable recommendations
- Suggested next steps

### `/analyze trade:<trade_id>`

**Purpose:** Deep analysis of specific trade

**Workflow:**
1. Get trade from database
2. Check order status on Bybit
3. Review TP/SL orders
4. Analyze execution

**Output:**
- Trade details
- Order status
- Findings
- Recommendations

### `/check-logs message:<id> channel:<channel> [timeframe:<minutes>]`

**Purpose:** Query Loggly for logs

**Workflow:**
1. Query by message ID
2. Find related errors
3. Search Bybit errors
4. Return formatted results

**Output:**
- Message logs
- Error logs
- Bybit errors
- Recommendations

## Benefits

### Over Scripts
- ✅ Discoverable (`/help` shows all commands)
- ✅ Guided (step-by-step workflows)
- ✅ Consistent (same process every time)
- ✅ Automatic (gathers data automatically)
- ✅ Interactive (can ask questions)

### Over Custom Prompts
- ✅ Structured (defined workflows)
- ✅ Repeatable (same results)
- ✅ Faster (no manual data gathering)
- ✅ Complete (all data sources integrated)

## Integration

### With Loggly MCP
- Commands automatically query Loggly
- No manual log searching needed
- Correlates logs with trace data

### With Database
- Queries messages, trades, orders
- Validates data consistency
- Finds related records

### With Bybit API
- Verifies orders on exchange
- Checks order status
- Validates execution

### With AI Assistants
- Commands exposed as MCP tools
- AI can use commands directly
- Natural language support

## Example Workflow

```bash
# 1. Start investigation
npm run investigate -- /investigate message:12345

# Output:
# ✅ Step 1/3: Trace message... Found failure at "Entry Order Creation"
# ✅ Step 2/3: Query Loggly... Found 3 Bybit API errors
# ✅ Step 3/3: Analyze... Root cause: "110003: Insufficient balance"
# 
# Recommendations:
# 1. Check account balance
# 2. Verify API credentials
# 
# Next Steps:
# 1. /check-balance
# 2. /check-logs message:12345 timeframe:5

# 2. Follow up with specific check
npm run investigate -- /check-logs message:12345 channel:2394142145 timeframe:5

# Output shows exact API error and timestamp
```

## Next Steps

1. **Try it:** `npm run investigate -- /trace message:12345`
2. **See help:** `npm run investigate`
3. **Configure MCP:** See `docs/LOGGLY_SETUP.md`
4. **Use with AI:** Commands work automatically with MCP

This provides a much better investigation experience than scripts + custom prompts!

