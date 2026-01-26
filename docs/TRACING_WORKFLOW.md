# Message Tracing Workflow

This document describes the workflow for tracing a message ID through the entire trading bot system to identify where orders failed to be created.

## Overview

The tracing workflow helps debug issues by following a message from initial receipt through:
1. Message storage in database
2. Message parsing (extracting trade signal)
3. Trade creation in database
4. Order creation on Bybit exchange
5. Order execution status

## Usage

### Basic Usage

```bash
npm run trace-message <message_id> [channel]
```

**Examples:**
```bash
# Trace message ID 12345 (will search all channels)
npm run trace-message 12345

# Trace message ID 12345 in specific channel
npm run trace-message 12345 2394142145
```

### What It Does

1. **Finds the message** in the database
2. **Checks if it was parsed** into a trade signal
3. **Finds associated trades** created from the message
4. **Checks order creation** for each trade:
   - Entry orders
   - Take-profit orders
   - Stop-loss orders
5. **Verifies orders on Bybit** by querying the exchange API
6. **Identifies failure points** where orders were not created
7. **Provides recommendations** for fixing issues

## Output Format

The script outputs a step-by-step trace with:

- ✅ **Success**: Step completed successfully
- ❌ **Failure**: Step failed (this is the failure point)
- ⏭️ **Skipped**: Step was skipped (not applicable)
- ❓ **Unknown**: Step status could not be determined

Each step includes:
- Timestamp (when available)
- Details (relevant data)
- Error messages (if failed)

## Common Failure Points

### 1. Message Not Found
**Symptom**: Message not in database
**Possible causes**:
- Message was never harvested from Telegram/Discord
- Message ID is incorrect
- Channel name is incorrect

**Solution**: Check harvester logs and verify message ID/channel

### 2. Message Parsing Failed
**Symptom**: Message exists but couldn't be parsed
**Possible causes**:
- Message is not a trade signal (could be management command)
- Parser configuration is incorrect
- Message format changed

**Solution**: 
- Check parser configuration for the channel
- Verify message content matches expected format
- Check if message is a management command instead

### 3. Trade Creation Failed
**Symptom**: Message parsed but no trade created
**Possible causes**:
- Initiator encountered an error
- Message was marked as parsed before trade creation
- Initiator configuration is incorrect
- Symbol validation failed
- Account credentials missing

**Solution**:
- Check initiator logs around message timestamp
- Verify initiator configuration
- Check account credentials
- Verify symbol exists on exchange

### 4. Entry Order Not Created
**Symptom**: Trade exists but no entry order ID
**Possible causes**:
- Bybit API error when creating order
- Invalid order parameters (price, quantity, etc.)
- Insufficient balance
- API rate limiting
- Network timeout

**Solution**:
- Check Loggly logs for Bybit API errors
- Verify account balance
- Check order parameters (price, quantity)
- Verify API credentials and permissions

### 5. Order Not Found on Bybit
**Symptom**: Order ID exists in database but not on exchange
**Possible causes**:
- Order was never actually created (API call failed silently)
- Order was created but immediately cancelled/rejected
- Wrong account credentials used
- Order ID mismatch

**Solution**:
- Check Loggly logs for API responses
- Verify correct account credentials
- Check order history on Bybit for similar orders
- Verify order ID format

## Using Loggly for Detailed Investigation

The script provides Loggly search queries. To investigate further:

1. **Copy the Loggly URL** from the script output
2. **Open it in your browser** (requires Loggly access)
3. **Search for**:
   - `Error initiating trade`
   - `Failed to create order`
   - `Bybit API error`
   - `Invalid symbol`
   - `Insufficient balance`

4. **Check Bybit API responses**:
   - Look for `retCode` and `retMsg` fields
   - Common error codes:
     - `10001`: Invalid parameter
     - `10003`: Invalid API key
     - `10004`: Invalid signature
     - `10006`: Rate limit exceeded
     - `110003`: Insufficient balance
     - `110004`: Order not found

## Database Queries

You can also manually query the database:

```sql
-- Find message
SELECT * FROM messages WHERE message_id = 12345 AND channel = '2394142145';

-- Find trades for message
SELECT * FROM trades WHERE message_id = 12345 AND channel = '2394142145';

-- Find orders for trade
SELECT * FROM orders WHERE trade_id = 123;

-- Check message parsing status
SELECT id, message_id, content, parsed, created_at 
FROM messages 
WHERE message_id = 12345 AND channel = '2394142145';
```

## Integration with Existing Tools

This script complements the existing `troubleshoot-trade` script:

- **`trace-message`**: Traces from message ID (start of flow)
- **`troubleshoot-trade`**: Troubleshoots from trade ID (middle of flow)

Use `trace-message` when you know the message ID but want to see the full flow.
Use `troubleshoot-trade` when you know the trade ID and want to check exchange status.

## Example Output

```
================================================================================
TRACE RESULTS FOR MESSAGE ID: 12345
Channel: 2394142145
================================================================================

✅ 1. Message Storage
   Timestamp: 2025-01-15 10:30:00
   Details: {
     "content": "⚡ #BTC/USDT 📤 Long 💹 Buy: 50000...",
     "sender": "",
     "date": "2025-01-15T10:30:00.000Z",
     "parsed": true
   }

✅ 2. Message Parsing
   Timestamp: 2025-01-15 10:30:00
   Details: {
     "tradingPair": "BTC/USDT",
     "signalType": "long",
     "entryPrice": 50000,
     "stopLoss": 49000,
     "takeProfits": [51000, 52000, 53000],
     "leverage": 20
   }

✅ 3. Trade Creation
   Details: {
     "tradeCount": 1,
     "trades": [{
       "id": 123,
       "status": "pending",
       "tradingPair": "BTC/USDT",
       "accountName": "demo",
       "orderId": "abc123",
       "createdAt": "2025-01-15 10:30:05"
     }]
   }

❌ 4. Trade 1 - Entry Order Creation
   Timestamp: 2025-01-15 10:30:05
   Error: No entry order ID stored in database
   Details: {
     "tradeId": 123,
     "status": "pending"
   }

🔴 FAILURE POINT: 4. Trade 1 - Entry Order Creation

💡 RECOMMENDATIONS:
   1. Trade 1: Entry order was never created or order ID was not saved
   2. Check initiator logs around 2025-01-15 10:30:05 for errors

================================================================================

📋 LOGGLY SEARCH:
  Query: messageId:12345 AND channel:2394142145
  URL: https://your-subdomain.loggly.com/search?q=...
  Time range: 2025-01-15T10:30:00.000Z to 2025-01-15T12:00:00.000Z

💡 TIPS:
  - Check Loggly for detailed error logs around the failure point
  - Look for Bybit API responses in logs
  - Search for "Error initiating trade" or "Failed to create order"
  - Check account credentials and API permissions
```

## Troubleshooting Tips

1. **Always check Loggly first** - It has the most detailed error information
2. **Verify timestamps** - Make sure you're looking at logs from the right time
3. **Check account credentials** - Ensure the correct account is being used
4. **Verify symbol format** - Some symbols have different formats (e.g., 1000SHIB vs SHIB1000)
5. **Check balance** - Insufficient balance will prevent order creation
6. **Review API rate limits** - Too many requests can cause failures

## Future Enhancements

Potential improvements:
- Direct Loggly API integration (requires API credentials)
- Automatic error pattern detection
- Historical comparison (compare with successful orders)
- Export trace results to JSON/CSV
- Integration with monitoring/alerting systems

