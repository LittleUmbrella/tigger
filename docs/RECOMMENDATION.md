# Recommendation: Hybrid Investigation Approach

## My Recommendation

**Use a hybrid approach: Script for data gathering + Custom Prompt for deep analysis**

The script alone isn't robust enough to dig into complex issues, but it's excellent for gathering structured data. Combine it with custom prompts to get the deep analysis you need.

## Why This Approach?

### Script Limitations
- ✅ Great at gathering structured data quickly
- ✅ Consistent data collection
- ✅ Can identify obvious failure points
- ❌ Can't deeply analyze code
- ❌ Can't understand complex failure mechanisms
- ❌ Can't suggest specific code fixes
- ❌ Limited reasoning about "why"

### Custom Prompt Advantages
- ✅ Deep code analysis and understanding
- ✅ Can trace complex failure chains
- ✅ Understands context and relationships
- ✅ Can suggest specific, actionable fixes
- ✅ Can prevent future issues
- ✅ Flexible and adaptable to your needs

### Hybrid Approach Benefits
- ✅ Best of both worlds
- ✅ Script gathers data efficiently
- ✅ Prompt provides deep analysis
- ✅ Can iterate and refine
- ✅ Builds knowledge over time

## Recommended Workflow

### Step 1: Quick Check (Script)
```bash
npm run trace-message <message_id> [channel]
```
Get a quick overview of where things failed.

### Step 2: Gather Structured Data (Script)
```bash
npm run trace-message <message_id> [channel] --json > trace.json
```
Get structured JSON output for analysis.

### Step 3: Deep Analysis (Custom Prompt)
Use the custom prompt template with:
- Trace JSON output
- Database queries (if needed)
- Loggly findings (if available)
- Any other context

See `docs/CUSTOM_PROMPT_TEMPLATE.md` for the full template.

### Step 4: Follow-up (Iterative)
- Ask clarifying questions
- Request code changes
- Verify fixes
- Refine understanding

## When to Use What

### Use Script For:
- ✅ Quick status checks
- ✅ Initial data gathering
- ✅ Routine investigations
- ✅ Automated monitoring
- ✅ Getting structured data for prompts

### Use Custom Prompt For:
- ✅ Deep root cause analysis
- ✅ Understanding failure mechanisms
- ✅ Getting specific code fixes
- ✅ Preventing recurrence
- ✅ Complex multi-factor issues
- ✅ "Why did this happen?" questions

## Example Investigation

```bash
# 1. Quick check
npm run trace-message 12345 2394142145
# Output: "Entry Order Creation Failed"

# 2. Get structured data
npm run trace-message 12345 2394142145 --json > trace.json

# 3. Use custom prompt with trace.json
# [Paste trace.json into custom prompt template]

# 4. Get deep analysis:
# - Root cause: "API error 110003: Insufficient balance"
# - Code path: "bybitInitiator.ts line 169-179"
# - Fix: "Add balance check before order creation"
# - Prevention: "Add balance validation and better error handling"
```

## The Custom Prompt Template

I've created a comprehensive prompt template in `docs/CUSTOM_PROMPT_TEMPLATE.md` that:

1. **Asks for root cause analysis** - Not just what failed, but why
2. **Requests code investigation** - Reads relevant code sections
3. **Provides actionable fixes** - Specific code changes with file paths
4. **Suggests prevention** - How to prevent recurrence
5. **Includes data verification** - What to check next

## Alternative Approaches Considered

### Script-Only Approach
❌ **Rejected**: Too limited for deep analysis
- Can't read code
- Can't understand complex failures
- Can't suggest fixes

### Prompt-Only Approach
⚠️ **Acceptable but inefficient**: 
- Requires manual data gathering
- Slower for routine checks
- More work for simple issues

### Hybrid Approach
✅ **Recommended**: 
- Script handles data gathering
- Prompt handles deep analysis
- Best balance of speed and depth

## Implementation

The script now supports:
- Human-readable output (default)
- JSON output (`--json` flag) for use with prompts

The custom prompt template includes:
- Base template for general investigations
- Enhanced template with additional context
- Specific templates for common failure points
- Tips for best results

## Next Steps

1. **Try the workflow**:
   - Run `npm run trace-message <message_id> [channel] --json`
   - Use the custom prompt template with the output
   - See how deep the analysis goes

2. **Refine based on experience**:
   - Adjust prompt template as needed
   - Add more context if helpful
   - Iterate on the workflow

3. **Consider enhancements**:
   - Script could generate prompts automatically
   - Could integrate Loggly API directly
   - Could add more database queries
   - But manual approach gives more control

## Summary

**Recommendation: Hybrid Approach**
- Script for fast data gathering
- Custom prompt for deep analysis
- Iterate and refine as needed

This gives you both speed (script) and depth (prompt analysis), which is what you need for robust investigation of complex issues.

