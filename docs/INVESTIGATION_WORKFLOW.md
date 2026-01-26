# Recommended Investigation Workflow

## Overview

The recommended approach combines **automated data gathering** (script) with **intelligent analysis** (custom prompt). This gives you both speed and depth.

## Recommended Workflow

### Step 1: Gather Data (Script)
Run the trace script to collect structured data:

```bash
npm run trace-message <message_id> [channel] > trace_output.json
```

Or use it interactively to see the summary, then provide the output to the AI.

### Step 2: Deep Analysis (Custom Prompt)
Use a custom prompt with the script output + additional context to get deep insights.

## Custom Prompt Template

Here's a recommended custom prompt you can use with me:

```
I need to investigate why orders weren't created for message ID <message_id> in channel <channel>.

I've run the trace-message script and here's the output:
[PASTE TRACE OUTPUT HERE]

Please analyze this trace and:

1. **Identify the root cause** - What specifically prevented orders from being created?
   - Was it an API error? Configuration issue? Data validation failure?
   - What was the exact error message or condition?

2. **Trace the failure chain** - Show me the sequence of events that led to failure:
   - What happened at each step?
   - Where did it first go wrong?
   - What downstream effects did this have?

3. **Check related data** - Based on the failure point, what should I check?
   - Database queries to run
   - Loggly search queries
   - Bybit API calls to verify
   - Configuration to review

4. **Provide actionable fix** - What exactly needs to be fixed?
   - Code changes needed
   - Configuration changes
   - Data corrections
   - Process improvements

5. **Prevent recurrence** - How can we prevent this from happening again?
   - Better error handling?
   - Additional validation?
   - Monitoring/alerting?

Please be thorough and dig into the codebase to understand the exact failure mechanism.
```

## Enhanced Workflow with Multiple Data Sources

For complex issues, gather multiple data sources:

### 1. Script Output
```bash
npm run trace-message <message_id> [channel]
```

### 2. Database Queries
```sql
-- Get full message details
SELECT * FROM messages WHERE message_id = ? AND channel = ?;

-- Get all trades for this message
SELECT * FROM trades WHERE message_id = ? AND channel = ?;

-- Get all orders for trades
SELECT o.* FROM orders o
JOIN trades t ON o.trade_id = t.id
WHERE t.message_id = ? AND t.channel = ?;

-- Check for similar successful trades around same time
SELECT * FROM trades 
WHERE channel = ? 
  AND created_at BETWEEN datetime('now', '-1 hour') AND datetime('now')
  AND status = 'filled'
ORDER BY created_at DESC;
```

### 3. Loggly Search
Use the Loggly URL from script output, or search for:
- `messageId:<message_id> AND channel:<channel>`
- `Error initiating trade`
- `Failed to create order`
- `Bybit API error`

### 4. Bybit API Verification
If you have order IDs, verify them directly:
```bash
# Use troubleshoot-trade script
npm run troubleshoot-trade <trade_id>
```

## Custom Prompt for Deep Analysis

```
I'm investigating a failed order creation. Here's what I have:

**Trace Output:**
[PASTE trace-message output]

**Database Data:**
[PASTE relevant database queries]

**Loggly Findings:**
[PASTE relevant log entries or describe what you found]

**Bybit API Status:**
[PASTE troubleshoot-trade output if available]

Please:

1. **Analyze the failure** - What exactly went wrong and why?
   - Read the relevant code sections
   - Understand the error flow
   - Identify the root cause

2. **Explain the mechanism** - How does this failure occur?
   - What code path was taken?
   - What conditions led to failure?
   - What should have happened vs what did happen?

3. **Check for patterns** - Is this a one-off or systemic issue?
   - Search codebase for similar error patterns
   - Check if there are related issues
   - Identify if this affects other messages/trades

4. **Provide fix** - What needs to be changed?
   - Specific code changes
   - Configuration updates
   - Data fixes if needed

5. **Improve resilience** - How can we prevent or handle this better?
   - Better error handling
   - Additional validation
   - Retry logic
   - Monitoring improvements
```

## Why This Hybrid Approach?

### Script Advantages:
- ✅ Fast data gathering
- ✅ Consistent data collection
- ✅ Can be automated/scripted
- ✅ Good for quick checks

### Script Limitations:
- ❌ Can't deeply analyze code
- ❌ Can't correlate complex patterns
- ❌ Limited reasoning about "why"
- ❌ Can't suggest code fixes

### Custom Prompt Advantages:
- ✅ Deep code analysis
- ✅ Understands context and relationships
- ✅ Can suggest specific fixes
- ✅ Can prevent future issues
- ✅ Flexible and adaptable

### Custom Prompt Limitations:
- ❌ Requires manual work
- ❌ Needs good data input
- ❌ Can't automate easily

### Hybrid Approach Benefits:
- ✅ Best of both worlds
- ✅ Script gathers data efficiently
- ✅ Prompt provides deep analysis
- ✅ Can iterate and refine
- ✅ Builds knowledge over time

## Example Investigation Session

1. **Initial Check** (Script):
   ```bash
   npm run trace-message 12345 2394142145
   ```
   Output shows: "Entry Order Creation Failed - No order ID"

2. **Gather Context** (Database + Logs):
   - Query database for trade details
   - Search Loggly for errors around that time
   - Check Bybit API status

3. **Deep Analysis** (Custom Prompt):
   ```
   [Use the custom prompt template above with all gathered data]
   ```

4. **Follow-up** (Iterative):
   - Ask clarifying questions
   - Request code changes
   - Verify fixes

## Alternative: Enhanced Script with AI Integration

You could also enhance the script to:
- Export structured JSON
- Include code references
- Generate analysis-ready prompts
- Call AI API directly (if you want full automation)

But the manual prompt approach gives you more control and better results for complex issues.

## Recommendation Summary

**Use the script for:**
- Quick status checks
- Initial data gathering
- Routine investigations
- Automated monitoring

**Use custom prompts for:**
- Deep root cause analysis
- Understanding failure mechanisms
- Getting specific fixes
- Preventing recurrence
- Complex multi-factor issues

**Best practice:**
1. Run script first to get overview
2. Gather additional data (DB, Loggly, Bybit)
3. Use custom prompt with all data for deep analysis
4. Implement fixes
5. Re-run script to verify

This gives you both speed (script) and depth (prompt analysis).

