# Slash Command Approach (Like Speckit)

## Why I Should Have Recommended This

A slash command + structured workflow approach would be **significantly better** than scripts + custom prompts because:

### Advantages Over Script Approach

1. **Discoverability**
   - Users see available commands: `/trace`, `/analyze`, `/check-logs`
   - No need to remember script names or parameters
   - Built-in help: `/help` or `/trace --help`

2. **Guided Workflows**
   - Step-by-step investigation process
   - Prompts for missing information
   - Validates inputs before proceeding
   - Shows progress through investigation steps

3. **Better UX**
   - Interactive, conversational interface
   - Natural language: "Trace message 12345"
   - Can ask clarifying questions mid-workflow
   - Shows results incrementally

4. **Consistency**
   - Everyone follows the same investigation process
   - Standardized output format
   - Repeatable workflows

5. **Integration**
   - Works naturally with AI assistants (Claude, ChatGPT)
   - Can be embedded in chat interfaces
   - Context-aware (remembers previous steps)

6. **Error Handling**
   - Validates inputs before execution
   - Provides helpful error messages
   - Suggests fixes or alternatives

## Speckit-Style Approach

Instead of:
```bash
npm run trace-message 12345 2394142145 --json > trace.json
# Then manually use custom prompt...
```

You'd have:
```
/trace message:12345 channel:2394142145
→ Automatically gathers data
→ Queries Loggly via MCP
→ Analyzes with AI
→ Shows structured results
→ Provides recommendations
```

## Proposed Slash Commands

### Core Investigation Commands

```
/trace message:<id> [channel:<channel>]
  - Traces message through entire flow
  - Automatically queries Loggly
  - Analyzes with AI
  - Shows failure points
  - Provides recommendations

/analyze trade:<trade_id>
  - Deep analysis of specific trade
  - Checks Bybit status
  - Reviews logs
  - Identifies issues

/check-logs message:<id> [timeframe:<minutes>]
  - Queries Loggly for message
  - Shows related errors
  - Finds patterns

/investigate message:<id>
  - Full investigation workflow
  - Combines trace + analyze + logs
  - Provides comprehensive report
```

### Query Commands

```
/query-loggly "<query>" [from:<time>] [until:<time>]
  - Direct Loggly search
  - Shows results formatted

/query-db "SELECT ..."
  - Database queries
  - Safe, validated queries only

/query-bybit order:<order_id>
  - Check order on Bybit
  - Get position status
```

### Workflow Commands

```
/investigate-start message:<id>
  - Starts guided investigation
  - Asks questions step by step
  - Gathers all needed data
  - Provides final analysis

/compare message1:<id> message2:<id>
  - Compare two messages
  - Find differences
  - Identify patterns

/pattern-search error:"Failed to create order"
  - Find all similar failures
  - Analyze patterns
  - Identify root causes
```

## Structured Workflow Example

```
User: /investigate message:12345

Bot: Starting investigation for message 12345...
     Step 1/5: Checking message in database... ✅
     Step 2/5: Parsing message... ✅
     Step 3/5: Finding trades... Found 1 trade
     Step 4/5: Checking order creation...
              ⚠️  Entry order not found on Bybit
     Step 5/5: Querying Loggly for errors...
              Found 3 related errors around that time

     🔴 FAILURE POINT: Entry Order Creation
     
     Analysis:
     - Order ID was saved in database but order doesn't exist on Bybit
     - Loggly shows API error: "110003: Insufficient balance"
     - This occurred at 2025-01-15 10:30:15
     
     Recommendations:
     1. Check account balance for account 'demo'
     2. Verify API credentials have sufficient permissions
     3. Review balance before order creation
     
     Would you like me to:
     - [Check account balance] /check-balance account:demo
     - [View full logs] /view-logs message:12345
     - [Compare with successful order] /compare message:12345 message:12340
```

## Implementation Approach

### Option 1: MCP Tools (Best for Claude/Cursor)

Expose slash commands as MCP tools:
- `/trace` → `trace_message` tool
- `/analyze` → `analyze_trade` tool
- `/check-logs` → `query_loggly` tool

### Option 2: Command Handler System

Create a command handler that:
- Parses slash commands
- Routes to appropriate handlers
- Executes structured workflows
- Provides interactive feedback

### Option 3: Hybrid (Recommended)

- MCP tools for AI assistant integration
- CLI commands for direct use
- Both use same underlying logic

## Why This Is Better

**Current Approach (Scripts):**
- ❌ Requires knowing script names
- ❌ Manual data gathering
- ❌ No guidance
- ❌ Inconsistent usage

**Slash Command Approach:**
- ✅ Discoverable commands
- ✅ Guided workflows
- ✅ Automatic data gathering
- ✅ Consistent process
- ✅ Better UX
- ✅ AI-friendly

## Recommendation

**Redesign the investigation workflow using slash commands:**

1. **Create command handler system**
   - Parse slash commands
   - Route to handlers
   - Execute workflows

2. **Structured workflows**
   - Step-by-step investigation
   - Automatic data gathering
   - AI analysis at each step

3. **MCP integration**
   - Expose commands as MCP tools
   - Works with Claude/Cursor
   - Automatic Loggly queries

4. **Interactive experience**
   - Progress indicators
   - Incremental results
   - Follow-up suggestions

This would be **much better** than the script + custom prompt approach I initially recommended.

