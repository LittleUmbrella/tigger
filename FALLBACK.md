# Signal Ambiguity Problem

Since signal messages come from Telegram, and those posting may vary their messages on occasion, the strict parsers may miss intent.

To solve for this, use ollama to interpret messages that no other parser handles.

The key to making this work reliably is using a **clear, strict prompt** that forces the LLM to output a specific JSON structure, and then pairing that with a **robust validation layer** in your code.

## Parser Execution Order

The LLM fallback parser should be executed **last** in the parser chain:

1. **Channel-specific parsers** (if configured)
2. **Default parser** (handles common formats)
3. **LLM fallback parser** (handles ambiguous/unparseable messages)

This ensures we only use the LLM (which has latency and cost) when absolutely necessary.

---

## 📝 LLM Prompt Design (System Instructions)

Your prompt needs to achieve two things: tell the LLM **what its job is** (System Prompt) and define the **required output format** (JSON Schema).

### 1. The System Prompt (Role and Rule)

This sets the context and provides non-negotiable instructions.

> **System Prompt Example:**
> "You are a specialized trading signal processor. Your sole task is to analyze the user's message and convert it into a valid JSON object for executing a trade via the Bybit API.
>
> **CRITICAL RULES:**
> 1.  You must ONLY output valid JSON. Do not include any text, commentary, or explanation outside of the JSON object.
> 2.  If the message contains a valid trade or management instruction, populate the JSON object according to the schema provided below.
> 3.  If the message is *not* a clear trade signal or management instruction (e.g., general chat, thanks, market news), you must return the following specific JSON object: `{"action": "NONE", "reason": "Non-Signal Message"}`.
> 4.  **Action** must be one of: `OPEN`, `CLOSE_ALL`, `SET_TP`, `SET_SL`, or `ADJUST_ENTRY`."

### 2. The JSON Schema (Expected Data Structure)

You must explicitly define the keys and expected data types. This structured output is what your typescript code will parse.

| Key | Data Type | Description | Example Value |
| :--- | :--- | :--- | :--- |
| `action` | String | **MANDATORY.** The high-level action. Must match one of the defined enums in the System Prompt. | `"OPEN"`, `"CLOSE_ALL"` |
| `symbol` | String | The trading pair. Always convert to uppercase. | `"BTCUSDT"` |
| `side` | String | **MANDATORY** for `OPEN`. Must be `LONG` or `SHORT`. | `"LONG"`, `"SHORT"` |
| `price` | Number/String | The price to execute at (Limit/Entry) or to take action on (SL/TP). Can be `MARKET` or a decimal number. | `35000.50`, `"MARKET"` |
| `quantity_type` | String | Type of quantity: `PERCENT_BALANCE` or `FIXED_AMOUNT`. | `"PERCENT_BALANCE"` |
| `tps` | Array (Number) | List of take-profit price points (only valid for action `"OPEN"`). Must be a JSON array. | `[100, 110, 120]` |
| `sl` | Number | Stop-loss price point. **Required** for `OPEN` action, optional for others. | `90` |
| `leverage` | Number | Leverage multiplier (e.g., 5, 10, 20). Optional, defaults to 1. | `20` |
| `order_type` | String | Order type: `"MARKET"` or `"LIMIT"`. Optional, defaults to `"MARKET"`. | `"LIMIT"` |
| `quantity` | Number | The value of the quantity (e.g., `100` if FIXED, `20` if PERCENT). | `0.15`, `50` |
| `reason` | String | **MANDATORY** for `NONE` action. A brief explanation of the LLM's decision. Optional for other actions. | `"Non-Signal Message"` |
| `confidence` | Number | Optional confidence score (0.0 to 1.0) indicating how certain the LLM is about the interpretation. | `0.85` |

### 3. Example Prompt + Expected Output

You can use the **few-shot learning** technique by providing an example in your prompt to increase consistency.

| Input Message | Expected LLM Output (JSON) |
| :--- | :--- |
| **Input:** "New trade setup: short ETHUSDT at 1850 with 10x leverage. Risk 2%." | ```json {"action": "OPEN", "symbol": "ETHUSDT", "side": "SHORT", "price": 1850, "quantity_type": "PERCENT_BALANCE", "quantity": 2.0, "leverage": 10, "order_type": "LIMIT", "sl": 1900, "tps": [1800, 1750, 1700]} ``` |
| **Input:** "Close all longs on Bitcoin. Profit secured!" | ```json {"action": "CLOSE_ALL", "symbol": "BTCUSDT", "side": "LONG", "price": "MARKET"} ``` |
| **Input:** "just saw a new article on the Fed, looks bearish" | ```json {"action": "NONE", "reason": "Non-Signal Message"} ``` |

---

## 🛡️ The Crucial Validation Layer

In your TypeScript/Node code, you **must not** execute a trade solely on the LLM's JSON output. You need multiple safety checks:

### 1. JSON Extraction and Parsing

LLMs often wrap JSON in markdown code blocks. You must extract the JSON first:

```typescript
// Extract JSON from markdown code fences or plain text
function extractJSON(llmOutput: string): string | null {
  // Try to extract from markdown code block
  const codeBlockMatch = llmOutput.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  
  // Try to find JSON object in plain text
  const jsonMatch = llmOutput.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0];
  }
  
  return null;
}
```

Then use a `try...catch` block to ensure the extracted text is valid JSON.

### 2. Schema Validation

Use **Zod** (TypeScript) to validate the parsed JSON against your expected schema. This checks:
- Are all required fields present?
- Are data types correct (e.g., `quantity` is a number, not a string)?
- Does the `action` field match one of the allowed enums?
- Are arrays properly formatted (e.g., `tps` is an array, not a comma-separated string)?

See the implementation section for the complete Zod schema.

### 3. Logical Validation (Trading Logic)

This is the most critical step before execution:
- If `action` is `OPEN`:
  - Is the `symbol` valid for Bybit? (format: `BTCUSDT`, `ETHUSDT`, etc.)
  - Is `side` either `LONG` or `SHORT`?
  - Is `quantity` non-zero and within reasonable bounds?
  - Are `tps` and `sl` prices logically consistent with entry price and side?
  - Is `leverage` within acceptable range (1-100x typically)?
- If `action` is `CLOSE_ALL`:
  - Does your bot currently have an open position for that `symbol` and `side`?
- If `action` is `SET_TP` or `SET_SL`:
  - Does the referenced position exist?
  - Is the new price level valid?

If any validation fails, **log the error** with full context and save to the database for analysis.

## Execution

The LLM parser can return two types of results:

1. **ParsedOrder** (for `OPEN` actions) - Routes to **initiators** to open new trades
2. **ParsedManagementCommand** (for `CLOSE_ALL`, `SET_TP`, `SET_SL`, `ADJUST_ENTRY` actions) - Routes to **managers** to manage existing positions

The parser automatically routes the result to the appropriate system:
- `OPEN` actions → Initiators (create new trades)
- `CLOSE_ALL` actions → Managers (close positions)
- Other management actions → Managers (adjust positions)

This allows the LLM fallback to handle both new trade signals and position management commands that strict parsers might miss.

## Error Handling and Fallback Behavior

### LLM Service Unavailability

If the ollama service is unavailable:
1. **Log the error** with full context (message ID, channel, timestamp)
2. **Mark message as unparseable** in the database (don't mark as parsed)
3. **Continue processing** other messages (don't block the entire system)
4. **Retry logic**: Optionally retry failed messages after a delay (e.g., 5 minutes)

### Timeout Handling

LLM calls can be slow. Implement:
- **Request timeout**: 30 seconds default (configurable)
- **Graceful degradation**: If timeout occurs, log and mark message for retry
- **Circuit breaker**: If multiple consecutive failures, temporarily disable LLM fallback

### Rate Limiting

To prevent abuse and manage costs:
- **Per-channel rate limit**: Max N LLM calls per minute per channel
- **Global rate limit**: Max M LLM calls per minute across all channels
- **Queue system**: Queue messages that exceed rate limits for later processing

## Security Considerations

### Input Sanitization

- **Message length limit**: Reject messages over 2000 characters (prevent token bloat)
- **Prompt injection protection**: Sanitize user input before sending to LLM
- **Content filtering**: Reject messages with suspicious patterns (e.g., excessive special characters)

### Prompt Injection Mitigation

Malicious Telegram messages could manipulate the LLM. Mitigations:
- Use a **system prompt** that's separate from user input
- **Escape special characters** in user messages
- **Validate output** strictly - reject any output that doesn't match expected schema
- **Log all LLM interactions** for security auditing

## Cost and Performance Considerations

### Latency

- LLM calls add **500ms - 5s** latency typically
- Only use LLM fallback when strict parsers fail
- Consider **caching** similar messages (hash-based) to avoid redundant calls

### Token Usage

- Monitor token usage per message
- Set **budget limits** per day/hour
- Use **smaller models** (e.g., `llama3.2:1b`) for faster, cheaper inference
- Consider **batch processing** multiple messages in one LLM call (if supported)

### Monitoring

Track the following metrics:
- LLM fallback usage rate (% of messages)
- Success rate (valid JSON returned)
- Average response time
- Token usage per message
- Common failure reasons
- Most frequently parsed symbols/actions

## Configuration

Add the `ollama` configuration to your existing parser config. The LLM fallback will automatically be used as a last resort when the main parser fails:

```json
{
  "parsers": [
    {
      "name": "main_parser",
      "channel": "your_telegram_channel",
      "ollama": {
        "baseUrl": "http://localhost:11434",
        "model": "llama3.2:1b",
        "timeout": 30000,
        "maxRetries": 2,
        "rateLimit": {
          "perChannel": 10,
          "perMinute": 30
        }
      }
    }
  ]
}
```

**Note:** The LLM fallback is automatically triggered when:
1. The configured parser (or default parser) fails to parse a message
2. The `ollama` configuration is present in the parser config
3. The Ollama service is available and healthy

You don't need to create a separate parser entry - just add the `ollama` config to enable fallback for that parser.

## Testing Strategy

### Unit Tests

- Test JSON extraction from various markdown formats
- Test schema validation with valid/invalid inputs
- Test error handling (timeouts, network errors, invalid JSON)

### Integration Tests

- Test with real Telegram messages that failed strict parsers
- Test retry logic with simulated failures
- Test rate limiting behavior

### Edge Cases

- Very long messages (>2000 chars)
- Messages with special characters/emojis
- Messages in different languages
- Malformed JSON from LLM
- LLM returning text instead of JSON
- LLM service completely down

## Implementation Files

The implementation consists of:
- `src/parsers/llmFallbackParser.ts` - Main parser implementation
- `src/parsers/llmSchemas.ts` - Zod validation schemas
- `src/utils/jsonExtractor.ts` - JSON extraction utilities
- `src/utils/llmClient.ts` - Ollama client wrapper with retry/timeout logic  