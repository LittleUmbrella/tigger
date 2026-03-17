# Investigation: Message 1693, Channel 2427485240

## Summary

**Failure point**: Trade Creation — no trade was created in the database.

## Root Cause

Loggly logs show **"Error initiating trade"** at 2026-03-17 04:21:11. The error payload was serialized as `[object Object]`, so the actual cause was not visible in logs.

## Timeline

| Step | Time (UTC) | Status |
|------|------------|--------|
| Message received | 04:21:03 | — |
| Message parsed | 04:21:07 | ✅ vip_crypto_signals |
| Trade initiation started | 04:21:11 | demo, hyrotrader_challenge1 |
| Error initiating trade | 04:21:11 | ❌ non-retryable |
| Message marked as parsed | 04:21:11 | — |

Message staleness was **not** the cause (processed ~8 seconds after message date; `maxMessageStalenessMinutes` = 5).

## Message Content

```
⚡ #HUMA/USDT 📤 Long 💹 Buy: 0.01779 - 0.01715 🧿 Target: 0.01796 - 0.01814 - 0.01832 - 0.01850 - 0.01868 - 0.01886 🧨 StopLoss: 0.01664 🔘 Leverage: 20x
```

- **Symbol**: HUMAUSDT (valid on Bybit)
- **Channel config**: Bybit initiator, propFirms: hyrotrader

## Possible Causes (unknown due to poor error serialization)

1. **Prop firm validation** — hyrotrader rules: maxRiskPerTrade 3%, dailyDrawdown 5%, maxDrawdown 10%
2. **Bybit API rejection** — insufficient balance, invalid params, symbol restrictions
3. **Account-specific failure** — demo or hyrotrader_challenge1 account issue

## Fix Applied

`signalInitiator.ts` now uses `serializeErrorForLog()` when logging initiator errors. Future failures will show the actual error message (e.g. `retCode=... retMsg=...` or prop firm violation text) instead of `[object Object]`.

## Recommendations

1. Re-run investigation on the next similar failure — logs will now include the real error
2. Check hyrotrader_challenge1 account balance and status
3. If prop firm rules are blocking: verify account equity and daily drawdown state
