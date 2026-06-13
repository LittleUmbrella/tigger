# cTrader Tick-Close TP Strategy — Design Spec

**Date:** 2026-06-12  
**Status:** Approved  
**Scope:** cTrader live accounts only (v1)

## Problem

Some prop firms prohibit multiple trades or orders placed near-simultaneously. The current cTrader initiator supports two TP strategies that violate or risk violating this:

1. **N-trades** — one entry order per TP level (each with its own SL+TP), opened in quick succession.
2. **Single position + multi-order TPs** — one entry, then `placeLimitOrder` for TPs 1…n−1, last TP on the position via `modifyPosition`.

Both create multiple exchange orders at or near entry time.

## Goal

Add an account-level strategy **`tick-close`** that:

- Opens **one** position per signal.
- Sets **SL** and **last TP** on the position (last TP needs no tick monitoring).
- Uses **live spot ticks** (`ProtoOASubscribeSpotsReq` → `ProtoOASpotEvent`) to detect intermediate TP levels.
- Partially closes via **`ProtoOAClosePositionReq`** (market close, no trigger price).
- Keeps TP state in an **in-memory cache** on the hot path (minimal DB round-trips).
- Uses the cache (not DB polling) for **breakeven-after-N-TPs** eligibility during live trading.

Default behavior (`multi-order`) is unchanged for backward compatibility.

## Non-goals (v1)

- Bybit tick-close strategy.
- Simulation / channel-eval tick replay (may use poll fallback later).
- Channel-level strategy override (account-only for now).
- Replacing the existing poll-based `ctraderMonitor` for SL, entry timeout, or final close detection.

---

## Configuration

### Account field

Add to `AccountConfig` in `src/types/config.ts`:

```ts
/**
 * cTrader only. How intermediate take-profits are executed when a signal has multiple TPs.
 * - `multi-order` (default): N-trades or limit TP orders (current behavior).
 * - `tick-close`: single position; intermediate TPs via live tick + closePosition API.
 */
ctraderTpStrategy?: 'multi-order' | 'tick-close';
```

- **Default:** `'multi-order'` when omitted.
- **Selection:** per account (each account is tied to one prop firm / exchange).
- **Example:** set `"ctraderTpStrategy": "tick-close"` on prop-firm cTrader accounts in `config.json`.

### Optional monitor fields (future / v1 if needed)

```ts
/** Seconds without spot events before tick-close falls back to poll monitor (default 30). */
ctraderTickStaleSeconds?: number;
```

---

## Architecture Overview

```
tradeOrchestrator
  ├─ startCTraderMonitor (existing poll loop)
  └─ per cTrader account where ctraderTpStrategy === 'tick-close':
       CTraderTickTpService
         ├─ CTraderSpotStream      (persistent ProtoOASpotEvent)
         ├─ TickTpRegistry         (in-memory watches + filled TP counts)
         └─ closePosition executor (serialized per trade)

ctraderInitiator
  └─ if account.ctraderTpStrategy === 'tick-close':
       ctraderTickClosePlacement.placeTickClosePosition(...)
       tickTpService.register(watch)   // in-process, no DB on register
```

### Module layout

| File | Responsibility |
|------|----------------|
| `src/ctrader/tickClose/types.ts` | `TickTpWatch`, level status, registry interface |
| `src/ctrader/tickClose/tickTpRegistry.ts` | In-memory index; `getFilledTpCount(tradeId)` |
| `src/ctrader/tickClose/ctraderSpotStream.ts` | Ref-counted persistent spot subscriptions per `symbolId` |
| `src/ctrader/tickClose/ctraderTickTpService.ts` | Tick handler, `closePosition`, cache updates, optional immediate breakeven trigger |
| `src/ctrader/tickClose/ctraderTickClosePlacement.ts` | Post-fill: SL + last TP, volume slices, build watch |
| `src/initiators/ctraderInitiator.ts` | Strategy branch (~20–40 lines); delegate to placement module |
| `src/monitors/ctraderMonitor.ts` | Breakeven gate reads registry when available |
| `src/orchestrator/tradeOrchestrator.ts` | Start/stop tick service per tick-close account |

---

## Initiator behavior (`tick-close`)

When `account.ctraderTpStrategy === 'tick-close'` and the signal has **multiple** TPs:

1. **Do not** enter the N-trades path.
2. Place **one** entry order (same as existing single-trade path).
3. After fill, resolve `positionId` and actual volume (lots).
4. Precompute intermediate slice volumes using existing helpers:
   - `distributeQuantityAcrossTPs` with `CTRADER_TP_SPLIT_OPTIONS` (`lastSliceRounding: 'floor'`).
   - `validateAndRedistributeTPQuantities`.
   - **Exclude the last TP** from tick monitoring; its volume remains on the position.
5. Call `modifyPosition` with **SL** and **last TP price** only.
6. **Do not** call `placeLimitOrder` for intermediate TPs.
7. Build a `TickTpWatch` and call `tickTpService.register(watch)` in-process.
8. Persist one trade row and TP prices on the trade as today (no pending TP order rows at entry).

When the signal has **one** TP: same as today (position TP only; nothing to register).

When strategy is `multi-order`: all existing paths unchanged.

---

## In-memory watch model

```ts
type TickTpLevelStatus = 'pending' | 'in_flight' | 'filled';

type TickTpLevel = {
  index: number;        // 1-based; excludes last TP (on position)
  price: number;
  volumeLots: number;
  status: TickTpLevelStatus;
};

type TickTpWatch = {
  tradeId: number;
  positionId: string;
  channel: string;
  messageId: string;
  accountName: string;
  symbol: string;       // normalized (e.g. XAUUSD)
  symbolId: number;
  direction: 'long' | 'short';
  remainingVolumeLots: number;
  levels: TickTpLevel[];
  closingInFlight: boolean;
};
```

### Indexes (`TickTpRegistry`)

- `bySymbolId: Map<number, TickTpWatch[]>` — dispatch on each `ProtoOASpotEvent`.
- `byTradeId: Map<number, TickTpWatch>` — register, unregister, breakeven lookup.
- `getFilledTpCount(tradeId): number` — count levels with `status === 'filled'`.

### Hydration (DB reads only at boundaries)

| Event | Action |
|-------|--------|
| Service start | Query active cTrader trades for this account with `tick-close`; rebuild watches from `take_profits` JSON + filled `take_profit` orders |
| Entry fill + register | Initiator passes watch directly (no DB read) |
| Partial close success | Update memory synchronously; async DB `insertOrder` |
| Trade closed / terminal | `unregister(tradeId)` |
| Process restart | Hydrate from DB (orders + trade row) |

---

## Spot stream (`CTraderSpotStream`)

cTrader Open API delivers live quotes via `ProtoOASubscribeSpotsReq` → `ProtoOASpotEvent` (bid/ask in 1/100_000 units).

**Difference from today:** `CTraderClient.getCurrentPrice()` subscribes briefly, reads one event, then unsubscribes. Tick-close needs **persistent** subscriptions.

Rules:

- One event listener per account connection.
- Ref-count subscriptions per `symbolId`: subscribe when first watch added; unsubscribe when last watch removed.
- Do **not** unsubscribe after each tick (unlike `getCurrentPrice`).
- On reconnect: re-subscribe all `symbolId`s present in the registry.

---

## Tick handler logic

On each `ProtoOASpotEvent` for `symbolId`:

1. Load `watches = registry.getBySymbolId(symbolId)` (typically 0–few).
2. For each watch, if `closingInFlight`, skip.
3. Find the **lowest-index** level with `status === 'pending'` whose price is touched:
   - **Long** (sell to close): `bid >= level.price`
   - **Short** (buy to close): `ask <= level.price`
4. Set `closingInFlight = true`, level `in_flight`.
5. Call `ctraderClient.closePosition(positionId, volumeLots, symbol)`.
6. On success:
   - Level → `filled`; decrement `remainingVolumeLots`.
   - `registry` updates `getFilledTpCount` immediately.
   - Async: `db.insertOrder({ order_type: 'take_profit', tp_index, status: 'filled', quantity, price, order_id: synthetic or deal-derived })`.
   - Optionally invoke breakeven check in-process (see below).
7. On failure: revert level to `pending`; log; retry on next tick (optional short backoff).
8. Clear `closingInFlight`.

**One level per trade per tick event** — if price gaps through multiple TPs, process sequentially across subsequent ticks or loop with `closingInFlight` guard.

**Last TP:** not in `levels[]`; left on position via `modifyPosition`. Existing poll monitor detects full close via deals / reconcile.

---

## Breakeven after N TPs

### Problem with DB-only gate

`ctraderMonitor.checkAndApplyBreakeven` today counts **closed sibling trades** (`countCtraderSiblingsClosedAtTakeProfit`), which suits N-trades. Tick-close has **one trade** and partial closes — siblings do not close at TP.

Bybit uses `countFilledTakeProfits` (DB orders). For tick-close, a DB-only gate risks a race: `closePosition` succeeds but the async `insertOrder` has not committed before the poll monitor runs breakeven.

### Design: in-memory primary, DB for durability

1. **Live gate:** `filledTpCount = tickTpRegistry.getFilledTpCount(trade.id)`.
2. **Fallback:** if watch not in registry (e.g. service not running), `countFilledTakeProfits(trade, db)`.
3. Extend `checkAndApplyBreakeven` options:

```ts
options?: {
  extraClosedTpWeight?: number;  // existing (N-trades siblings)
  filledTpCountOverride?: number; // tick-close from registry
}
```

4. **Immediate path:** after successful partial close, tick service may call `checkAndApplyBreakeven` directly with `filledTpCountOverride` (same process, no poll wait).
5. **Poll monitor** remains fallback for anything the tick path missed.

For tick-close accounts, replace sibling-based TP gate with:

```ts
const filledTpCount =
  options?.filledTpCountOverride ??
  tickTpRegistry?.getFilledTpCount(trade.id) ??
  await countFilledTakeProfits(trade, db);

const tpGateMet = filledTpCount >= effectiveBreakevenAfterTPs;
```

N-trades / `multi-order` sibling logic stays unchanged when strategy is not `tick-close`.

---

## Division of responsibility

| Concern | Owner |
|---------|--------|
| Intermediate TP partial closes | `CTraderTickTpService` |
| Last TP / SL / stop-out on position | cTrader position protection + poll monitor |
| Breakeven SL move | Registry-informed gate (+ optional immediate trigger from tick service) |
| Entry timeout / cancel | Poll monitor |
| Position fully closed | Poll monitor (deals / reconcile) |
| Orphan / relink sweeps | Poll monitor (unchanged) |

---

## Fallback when spot stream is stale

- Track `lastSpotAt` per `symbolId`.
- If no event for `ctraderTickStaleSeconds` (default 30): log warning.
- Poll monitor may detect missed TPs via `getCurrentPrice()` or M1 and issue `closePosition` (slower, safe).
- v1: log + rely on poll monitor; explicit poll-based TP catch-up can be a follow-up task.

---

## Edge cases

| Case | Handling |
|------|----------|
| Multiple TPs crossed in one tick | Process lowest pending index first; one `closePosition` per trade per event |
| Volume below min lot after slice | Prevent at entry via `validateAndRedistributeTPQuantities`; log if exchange rejects |
| Position closed externally (SL, manual, stop-out) | Poll monitor marks trade closed → tick service `unregister` on next reconcile or shared callback |
| `closePosition` fails (POSITION_LOCKED, etc.) | Revert level to `pending`; retry on next tick |
| Single TP signal | Position TP only; no watch registered |
| Account reconnect | Spot stream re-subscribes; registry unchanged in memory |
| Process restart | Hydrate registry from DB before processing ticks |

---

## Data model / DB

No schema migration required for v1.

- **Trade row:** unchanged (`take_profits` JSON, `position_id`, etc.).
- **Orders:** on each intermediate TP hit, async `insertOrder` with `order_type: 'take_profit'`, `status: 'filled'`, `tp_index`, `quantity`, `price`. `order_id` may be synthetic (e.g. `tick-close-{tradeId}-{tpIndex}`) or derived from deal if available.
- **No pending TP orders** at entry for `tick-close`.

---

## Testing strategy

### Unit tests

- `tickTpRegistry`: register/unregister, `getFilledTpCount`, symbol index.
- Tick trigger logic (pure function): long/short, bid/ask selection, lowest-index-first.
- Breakeven gate integration: `filledTpCountOverride` vs sibling path.

### Integration / manual

- Demo account with `tick-close`: 3-TP signal, verify one entry, no limit TP orders, partial closes at levels 1–2, position TP handles level 3.
- Breakeven fires after N fills without waiting for DB poll.
- Restart: service hydrates and continues watching.

---

## Rollout

1. Enable `"ctraderTpStrategy": "tick-close"` on all ctrader accounts.
2. Validate order count at entry (exactly one entry + position SL/TP).

---

## Open questions (resolved)

| Question | Decision |
|----------|----------|
| Config scope | Per account (`AccountConfig`) |
| Breakeven TP count source | In-memory registry primary; DB async + fallback |
| Code organization | `src/ctrader/tickClose/` module; thin initiator branch |
| Last TP monitoring | None — on position via `modifyPosition` |

---

## Implementation plan

After this spec is approved, create an implementation plan at:

`docs/superpowers/plans/2026-06-12-ctrader-tick-close-tp.md`
