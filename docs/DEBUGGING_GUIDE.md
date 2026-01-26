# Debugging Guide: Tracing Message Flow

## Quick Start

When investigating why orders weren't created, use this workflow:

```bash
# 1. Trace the message through the system
npm run trace-message <message_id> [channel]

# 2. If you have a trade ID, troubleshoot the trade
npm run troubleshoot-trade <trade_id>
```

## Workflow Overview

```
Message ID
    ↓
[1] Message Storage (Database)
    ↓
[2] Message Parsing (Extract Trade Signal)
    ↓
[3] Trade Creation (Database)
    ↓
[4] Entry Order Creation (Bybit API)
    ↓
[5] Entry Order Verification (Bybit Exchange)
    ↓
[6] TP/SL Order Creation (Bybit API)
    ↓
[7] TP/SL Order Verification (Bybit Exchange)
```

## Common Issues and Solutions

### Issue: Message Not Found
**Check**: Harvester logs, message ID correctness
**Solution**: Verify message was harvested from Telegram/Discord

### Issue: Message Parsing Failed
**Check**: Parser configuration, message format
**Solution**: 
- Verify parser is configured for the channel
- Check if message is a management command (not a trade signal)
- Review parser logs

### Issue: Trade Not Created
**Check**: Initiator logs, configuration
**Solution**:
- Check initiator logs for errors
- Verify initiator configuration
- Check account credentials
- Verify symbol exists on exchange

### Issue: Entry Order Not Created
**Check**: Loggly logs, Bybit API responses
**Solution**:
- Check Loggly for API errors
- Verify account balance
- Check order parameters (price, quantity)
- Verify API credentials and permissions
- Check for rate limiting

### Issue: Order Not Found on Bybit
**Check**: Order history, account credentials
**Solution**:
- Verify correct account credentials
- Check if order was created then immediately cancelled
- Verify order ID format
- Check order history for similar orders

## Using Loggly

1. **Get the Loggly URL** from trace-message output
2. **Search for specific errors**:
   - `Error initiating trade`
   - `Failed to create order`
   - `Bybit API error`
   - `Invalid symbol`
   - `Insufficient balance`

3. **Check Bybit API responses**:
   - Look for `retCode` and `retMsg` fields
   - Common error codes:
     - `10001`: Invalid parameter
     - `10003`: Invalid API key
     - `10004`: Invalid signature
     - `10006`: Rate limit exceeded
     - `110003`: Insufficient balance
     - `110004`: Order not found

## Database Queries

### Find Message
```sql
SELECT * FROM messages 
WHERE message_id = 12345 AND channel = '2394142145';
```

### Find Trades for Message
```sql
SELECT * FROM trades 
WHERE message_id = 12345 AND channel = '2394142145';
```

### Find Orders for Trade
```sql
SELECT * FROM orders 
WHERE trade_id = 123;
```

### Check Parsing Status
```sql
SELECT id, message_id, content, parsed, created_at 
FROM messages 
WHERE message_id = 12345 AND channel = '2394142145';
```

## Best Practices

1. **Always start with trace-message** - It gives you the full picture
2. **Check Loggly first** - Most detailed error information
3. **Verify timestamps** - Make sure you're looking at the right time
4. **Check account credentials** - Ensure correct account is used
5. **Verify symbol format** - Some symbols have different formats
6. **Check balance** - Insufficient balance prevents order creation
7. **Review API rate limits** - Too many requests cause failures

## Integration Points

- **Database**: SQLite/PostgreSQL stores messages, trades, orders
- **Loggly**: Centralized logging with detailed error information
- **Bybit API**: Exchange API for order creation and status
- **Config**: Account credentials and channel configuration

## Example Investigation

```bash
# 1. Trace message
npm run trace-message 12345 2394142145

# Output shows failure at "Entry Order Creation"
# Recommendation: Check initiator logs

# 2. Check Loggly (use URL from output)
# Search: messageId:12345 AND channel:2394142145
# Find: "Error initiating trade" log entry
# See: Bybit API error "110003: Insufficient balance"

# 3. Check account balance
# Verify: Account has sufficient USDT

# 4. Re-run trace to verify fix
npm run trace-message 12345 2394142145
```

## Troubleshooting Checklist

- [ ] Message exists in database
- [ ] Message was parsed successfully
- [ ] Trade was created in database
- [ ] Entry order ID exists in trade record
- [ ] Entry order exists on Bybit exchange
- [ ] TP/SL orders were created
- [ ] TP/SL orders exist on Bybit exchange
- [ ] Account credentials are correct
- [ ] Account has sufficient balance
- [ ] Symbol exists on exchange
- [ ] API rate limits not exceeded
- [ ] Network connectivity is stable

