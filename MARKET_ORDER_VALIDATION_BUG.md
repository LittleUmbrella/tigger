# Market Order TP Validation Bug

## Problem

Trade 31 had TP1 (0.073) below the entry price (0.07309) for a long position. This is invalid and the trade should not have been placed.

## Root Cause

For **market orders**, the validation logic had a critical flaw:

1. **Initial Validation Skipped**: When a market order is placed, strict validation is skipped because the actual fill price isn't known yet (lines 266-275 in `bybitInitiator.ts`)

2. **Comment Promised Future Validation**: The code commented "will validate after fill" but **never actually performed this validation**

3. **TP Orders Placed Without Validation**: TP orders were placed immediately after market order fill without validating that TP prices were valid relative to the **actual fill price**

## The Issue

- **Parsed Entry Price**: May be from signal message (e.g., 0.073)
- **Actual Fill Price**: Market order fills at current market price (e.g., 0.07309)
- **TP Prices**: Parsed relative to parsed entry (e.g., TP1 = 0.073)
- **Result**: TP1 (0.073) < Actual Entry (0.07309) = **INVALID!**

## Fix

Added validation **before placing TP orders** that:

1. **Gets actual entry fill price** from position (`avgPrice` field)
2. **Validates TP prices** against the actual fill price using `validateTradePrices()`
3. **Throws error** if validation fails, preventing invalid TP orders from being placed

### Code Location

`src/initiators/bybitInitiator.ts` lines ~639-680

### Validation Logic

```typescript
// Get actual entry fill price from position
const actualEntryPrice = position.avgPrice;

// Validate TP prices against actual entry fill price
if (!validateTradePrices(
  order.signalType,
  actualEntryPrice,
  order.stopLoss,
  order.takeProfits,
  { channel, symbol, messageId }
)) {
  throw new Error('TP prices invalid relative to entry fill price');
}
```

## Impact

- **Before Fix**: Invalid trades could be placed with TP prices below/above entry
- **After Fix**: Invalid trades are rejected before TP orders are placed
- **Trade 31**: Would have been rejected with error message explaining the issue

## Investigation Script

The investigation script (`src/scripts/investigate_trade.ts`) now also detects and reports invalid TP prices:

```bash
tsx src/scripts/investigate_trade.ts 31 49800
```

This will show:
- Invalid TP prices detected
- Warning that trade should not have been placed
- Explanation about market order validation issue

## Prevention

Going forward, all market orders will:
1. Get actual fill price from position
2. Validate TP/SL prices against actual fill price
3. Reject trade if validation fails (before placing TP orders)

This ensures no invalid trades are placed, even when market price moves between signal parsing and order execution.

