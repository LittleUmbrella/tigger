# Custom Prompt Template for Deep Investigation

Use this template when investigating why orders weren't created. The script provides structured data, and this prompt helps me analyze it deeply.

**Note:** If you have Loggly MCP configured, I can automatically query logs for you. Otherwise, you'll need to manually search Loggly and include relevant logs.

## Quick Start

1. Run trace script: `npm run trace-message <message_id> [channel] --json > trace.json`
2. Copy the prompt template below
3. Paste trace output into the prompt
4. Add any additional context you have

## Base Prompt Template

```
I need to investigate why orders weren't created for message ID <MESSAGE_ID> in channel <CHANNEL>.

I've run the trace-message script and here's the structured output:

<PASTE JSON OUTPUT FROM: npm run trace-message <message_id> [channel] --json>

**If Loggly MCP is available:** Please automatically query Loggly for logs related to this message ID and analyze them as part of the investigation.

Please analyze this trace and provide a deep investigation:

1. **Root Cause Analysis**
   - What specifically prevented orders from being created?
   - What was the exact error, condition, or failure point?
   - Read the relevant code sections to understand the failure mechanism
   - Explain WHY this happened, not just WHAT happened

2. **Failure Chain Analysis**
   - Trace the sequence of events that led to failure
   - Show me the code path that was taken
   - What should have happened vs what actually happened?
   - What downstream effects did this failure have?

3. **Code Investigation**
   - Read the relevant code files for the failure point
   - Understand the error handling and validation logic
   - Check if there are edge cases or conditions that weren't handled
   - Look for similar patterns in the codebase that might have the same issue

4. **Data Verification Queries**
   - What database queries should I run to gather more context?
   - What Loggly search queries will help find related errors?
   - What Bybit API calls should I make to verify the state?
   - What configuration should I check?

5. **Actionable Fix**
   - What specific code changes are needed?
   - What configuration changes are required?
   - Are there any data corrections needed?
   - Provide specific file paths and line numbers where changes are needed

6. **Prevention Strategy**
   - How can we prevent this from happening again?
   - What additional validation or error handling is needed?
   - Should we add monitoring/alerting for this failure mode?
   - Are there related issues we should fix proactively?

Please be thorough and dig deep into the codebase to understand the exact failure mechanism.
```

## Enhanced Prompt with Additional Context

If you have additional data, use this enhanced version:

```
I'm investigating a failed order creation. Here's what I have:

**1. Trace Output (from trace-message script):**
<PASTE JSON OUTPUT>

**2. Database Queries I've Run:**
<PASTE SQL QUERIES AND RESULTS>
- Message details: ...
- Trade details: ...
- Order details: ...
- Related trades: ...

**3. Loggly Findings:**
<PASTE RELEVANT LOG ENTRIES OR DESCRIBE WHAT YOU FOUND>
- Error messages: ...
- API responses: ...
- Timestamps: ...

**4. Bybit API Status:**
<PASTE OUTPUT FROM troubleshoot-trade OR DESCRIBE>
- Order status: ...
- Position status: ...
- Account balance: ...

**5. Configuration Context:**
- Channel config: ...
- Initiator config: ...
- Account config: ...

Please provide a comprehensive analysis:

1. **Root Cause** - What exactly went wrong and why?
   - Read the code to understand the failure mechanism
   - Explain the error flow and conditions
   - Identify the root cause (not just symptoms)

2. **Pattern Analysis** - Is this isolated or systemic?
   - Search codebase for similar error patterns
   - Check if this affects other messages/trades
   - Identify if there are related issues

3. **Fix Implementation** - What needs to change?
   - Specific code changes with file paths
   - Configuration updates needed
   - Data fixes if required
   - Testing approach

4. **Resilience Improvements** - How to prevent this?
   - Better error handling
   - Additional validation
   - Retry logic improvements
   - Monitoring/alerting additions

Be thorough and provide specific, actionable recommendations.
```

## Prompt for Specific Failure Points

### If Failure is "Message Parsing Failed"

```
The trace shows message parsing failed for message ID <ID>. The message content is:

<PASTE MESSAGE CONTENT>

Please:
1. Analyze why the parser failed to extract a trade signal
2. Check if this is a known message format issue
3. Review the parser code for this channel
4. Suggest parser improvements or fixes
5. Check if this message type should be handled differently
```

### If Failure is "Entry Order Not Created"

```
The trace shows entry order creation failed. The trade details are:

<PASTE TRADE DETAILS FROM TRACE>

Please:
1. Read the bybitInitiator code to understand order creation flow
2. Check what conditions prevent order creation
3. Analyze the error handling and retry logic
4. Check account balance, symbol validation, and API error handling
5. Provide specific fixes for the failure point
```

### If Failure is "Order Not Found on Bybit"

```
The trace shows order ID <ORDER_ID> exists in database but not on Bybit. Trade details:

<PASTE TRADE DETAILS>

Please:
1. Investigate why order ID was saved but order wasn't created
2. Check error handling in order creation code
3. Analyze API response handling
4. Check if order was created then immediately cancelled
5. Verify order ID format and storage logic
```

## Tips for Best Results

1. **Provide Complete Context**
   - Include all trace output
   - Add relevant database queries
   - Include Loggly findings
   - Mention any configuration details

2. **Be Specific**
   - Include exact message IDs, trade IDs, order IDs
   - Provide timestamps
   - Include error messages verbatim

3. **Ask Follow-up Questions**
   - "Can you check the code for X?"
   - "What would happen if Y occurred?"
   - "How does Z handle this case?"

4. **Iterate**
   - Start with base prompt
   - Add findings from initial analysis
   - Refine based on what you learn

## Example Workflow

```bash
# 1. Run trace script
npm run trace-message 12345 2394142145 --json > trace.json

# 2. Query database for additional context
sqlite3 data/trades.db "SELECT * FROM trades WHERE message_id = 12345;" > db_query.txt

# 3. Copy trace output and use custom prompt
# [Paste trace.json and db_query.txt into prompt]

# 4. Follow up with specific questions based on analysis
```

## Integration with Script

The script can be enhanced to generate prompts automatically:

```bash
# Generate investigation prompt
npm run trace-message 12345 2394142145 --prompt > investigation_prompt.txt

# Then paste investigation_prompt.txt into your AI assistant
```

This would combine:
- Trace output
- Database queries
- Loggly search queries
- Formatted prompt template

But for now, the manual approach gives you more control and better results.

