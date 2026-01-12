# Trade 31 Investigation - Position Sizing Issue

## Problem

The quantity for trade 31 seems incorrect given:
- **Leverage**: 50x
- **Risk Percentage**: 1%

## Root Cause

The position sizing formula in `src/utils/positionSizing.ts` is **incorrect**. It incorrectly applies leverage to the risk calculation.

### Current (Incorrect) Formula

```typescript
const riskPerUnit = (priceDiff / entryPrice) * leverage;
const positionSize = riskAmount / riskPerUnit;
```

This formula treats leverage as if it multiplies the price difference, which doesn't make sense. Leverage affects margin requirements, not the loss per unit.

### Correct Formula

The actual loss when stop loss is hit is:
```
Loss = Quantity × Price Difference
```

To risk a specific amount:
```
Risk Amount = Quantity × Price Difference
Quantity = Risk Amount / Price Difference
Position Size = Quantity × Entry Price
```

**Leverage only affects margin**: `Margin = Position Size / Leverage`

## Investigation Script

Use the investigation script to analyze any trade:

```bash
tsx src/scripts/investigate_trade.ts <trade_id> [account_balance]
```

### Example

```bash
# Investigate trade 31 with account balance of 10,000 USD
tsx src/scripts/investigate_trade.ts 31 10000
```

The script will:
1. Query the trade from the database
2. Show current formula calculation (incorrect)
3. Show correct formula calculation
4. Compare both with the actual quantity in the database
5. Show margin requirements for both calculations

## Config Settings

From `config.json`:
- **Risk Percentage**: 1% (from initiators.bybit.riskPercentage)
- **Base Leverage**: 20 (from channels[].baseLeverage, used for risk adjustment)

## Expected Behavior

With 1% risk and 50x leverage:
- If account balance = 10,000 USD
- Risk amount = 100 USD
- If entry = 0.07309, SL = 0.065
- Price diff = 0.00809
- **Correct quantity** = 100 / 0.00809 = **12,360 tokens**
- **Correct position size** = 12,360 × 0.07309 = **903.6 USD**
- **Margin required** = 903.6 / 50 = **18.07 USD**

## Fix Required

Update `src/utils/positionSizing.ts` to use the correct formula:

```typescript
export const calculatePositionSize = (
  balance: number,
  riskPercentage: number,
  entryPrice: number,
  stopLoss: number,
  leverage: number,
  baseLeverage?: number
): number => {
  // Calculate risk amount
  const riskAmount = balance * (riskPercentage / 100);
  
  // Calculate price difference
  const priceDiff = Math.abs(entryPrice - stopLoss);
  
  // Calculate quantity: loss = quantity × priceDiff, we want loss = riskAmount
  const quantity = riskAmount / priceDiff;
  
  // Position size = quantity × entry price
  const positionSize = quantity * entryPrice;
  
  return positionSize;
};
```

Note: Leverage is not needed for position size calculation - it only affects margin requirements.

