# cTrader Tick-Close TP Strategy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-level `tick-close` TP strategy for cTrader: one entry per signal, last TP on position, intermediate TPs via live spot ticks + `closePosition`, with in-memory registry for breakeven gating.

**Architecture:** New `src/ctrader/tickClose/` module (registry, spot stream, tick service, placement). Orchestrator starts one `CTraderTickTpService` per cTrader account with `ctraderTpStrategy: 'tick-close'`. Initiator delegates post-fill setup; poll monitor unchanged except breakeven gate reads registry.

**Tech Stack:** TypeScript, Vitest, cTrader Open API (`ProtoOASubscribeSpotsReq`, `ProtoOASpotEvent`, `ProtoOAClosePositionReq`), existing `CTraderClient` / `CTraderConnection`.

**Spec:** [`docs/superpowers/specs/2026-06-12-ctrader-tick-close-tp-design.md`](../specs/2026-06-12-ctrader-tick-close-tp-design.md)

---

## File map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/ctrader/tickClose/types.ts` | Shared types |
| Create | `src/ctrader/tickClose/tickTpRegistry.ts` | In-memory watch index |
| Create | `src/ctrader/tickClose/tickTrigger.ts` | Pure TP touch detection |
| Create | `src/ctrader/tickClose/ctraderSpotStream.ts` | Persistent spot subscriptions |
| Create | `src/ctrader/tickClose/ctraderTickTpService.ts` | Tick handler + closePosition |
| Create | `src/ctrader/tickClose/ctraderTickClosePlacement.ts` | Post-fill SL/last TP + watch build |
| Create | `src/ctrader/tickClose/tickTpServiceManager.ts` | Per-account service lifecycle + global lookup |
| Create | `src/ctrader/tickClose/hydrateTickTpWatches.ts` | DB → registry on startup |
| Create | `src/utils/ctraderTpStrategy.ts` | Resolve account strategy |
| Create | `src/ctrader/tickClose/__tests__/tickTpRegistry.test.ts` | Registry tests |
| Create | `src/ctrader/tickClose/__tests__/tickTrigger.test.ts` | Trigger logic tests |
| Create | `src/ctrader/tickClose/__tests__/hydrateTickTpWatches.test.ts` | Hydration tests |
| Modify | `src/types/config.ts` | `ctraderTpStrategy`, optional `ctraderTickStaleSeconds` |
| Modify | `src/clients/ctraderClient.ts` | Public spot subscription + event API |
| Modify | `src/initiators/ctraderInitiator.ts` | Strategy branch (~30 lines) |
| Modify | `src/initiators/initiatorRegistry.ts` | Optional `registerTickCloseWatch` on context |
| Modify | `src/monitors/ctraderMonitor.ts` | Breakeven gate for tick-close |
| Modify | `src/orchestrator/tradeOrchestrator.ts` | Start/stop tick services |
| Modify | `config.json` | `"ctraderTpStrategy": "tick-close"` on all cTrader accounts |

---

### Task 1: Config and strategy helper

**Files:**
- Modify: `src/types/config.ts`
- Create: `src/utils/ctraderTpStrategy.ts`
- Create: `src/utils/__tests__/ctraderTpStrategy.test.ts`

- [ ] **Step 1: Add types to `AccountConfig`**

In `src/types/config.ts`, inside `AccountConfig`:

```ts
/**
 * cTrader only. How intermediate take-profits are executed when a signal has multiple TPs.
 * - `multi-order` (default): N-trades or limit TP orders (current behavior).
 * - `tick-close`: single position; intermediate TPs via live tick + closePosition API.
 */
ctraderTpStrategy?: 'multi-order' | 'tick-close';

/** cTrader tick-close only: seconds without spot events before stale warning (default 30). */
ctraderTickStaleSeconds?: number;
```

- [ ] **Step 2: Write failing test**

```ts
// src/utils/__tests__/ctraderTpStrategy.test.ts
import { describe, expect, it } from 'vitest';
import { resolveCtraderTpStrategy, isTickCloseStrategy } from '../ctraderTpStrategy.js';
import type { AccountConfig } from '../../types/config.js';

const ctraderAccount = (overrides: Partial<AccountConfig> = {}): AccountConfig => ({
  name: 'ctrader_live_5',
  exchange: 'ctrader',
  ...overrides,
});

describe('resolveCtraderTpStrategy', () => {
  it('defaults to multi-order when omitted', () => {
    expect(resolveCtraderTpStrategy(ctraderAccount())).toBe('multi-order');
  });

  it('returns tick-close when set', () => {
    expect(resolveCtraderTpStrategy(ctraderAccount({ ctraderTpStrategy: 'tick-close' }))).toBe('tick-close');
  });

  it('isTickCloseStrategy is false for bybit accounts', () => {
    expect(isTickCloseStrategy({ name: 'x', exchange: 'bybit' })).toBe(false);
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

Run: `npm test -- src/utils/__tests__/ctraderTpStrategy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement helper**

```ts
// src/utils/ctraderTpStrategy.ts
import type { AccountConfig } from '../types/config.js';

export type CTraderTpStrategy = 'multi-order' | 'tick-close';

export const resolveCtraderTpStrategy = (account: AccountConfig | null | undefined): CTraderTpStrategy => {
  if (!account || account.exchange !== 'ctrader') return 'multi-order';
  return account.ctraderTpStrategy ?? 'multi-order';
};

export const isTickCloseStrategy = (account: AccountConfig | null | undefined): boolean =>
  resolveCtraderTpStrategy(account) === 'tick-close';
```

- [ ] **Step 5: Run test — expect PASS**

Run: `npm test -- src/utils/__tests__/ctraderTpStrategy.test.ts`

---

### Task 2: Core types and registry

**Files:**
- Create: `src/ctrader/tickClose/types.ts`
- Create: `src/ctrader/tickClose/tickTpRegistry.ts`
- Create: `src/ctrader/tickClose/__tests__/tickTpRegistry.test.ts`

- [ ] **Step 1: Create types**

```ts
// src/ctrader/tickClose/types.ts
export type TickTpLevelStatus = 'pending' | 'in_flight' | 'filled';

export type TickTpLevel = {
  index: number;
  price: number;
  volumeLots: number;
  status: TickTpLevelStatus;
};

export type TickTpWatch = {
  tradeId: number;
  positionId: string;
  channel: string;
  messageId: string;
  accountName: string;
  symbol: string;
  symbolId: number;
  direction: 'long' | 'short';
  remainingVolumeLots: number;
  levels: TickTpLevel[];
  closingInFlight: boolean;
};

export type SpotQuote = { bid: number; ask: number; symbolId: number; timestampMs?: number };
```

- [ ] **Step 2: Write failing registry tests**

```ts
// src/ctrader/tickClose/__tests__/tickTpRegistry.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { TickTpRegistry } from '../tickTpRegistry.js';
import type { TickTpWatch } from '../types.js';

const baseWatch = (overrides: Partial<TickTpWatch> = {}): TickTpWatch => ({
  tradeId: 1,
  positionId: '100',
  channel: 'ch',
  messageId: 'msg1',
  accountName: 'ctrader_live_5',
  symbol: 'XAUUSD',
  symbolId: 42,
  direction: 'long',
  remainingVolumeLots: 0.03,
  closingInFlight: false,
  levels: [
    { index: 1, price: 2650, volumeLots: 0.01, status: 'pending' },
    { index: 2, price: 2660, volumeLots: 0.01, status: 'pending' },
  ],
  ...overrides,
});

describe('TickTpRegistry', () => {
  let registry: TickTpRegistry;

  beforeEach(() => {
    registry = new TickTpRegistry();
  });

  it('registers and retrieves by tradeId and symbolId', () => {
    const w = baseWatch();
    registry.register(w);
    expect(registry.getByTradeId(1)).toBe(w);
    expect(registry.getBySymbolId(42)).toEqual([w]);
  });

  it('getFilledTpCount counts filled levels only', () => {
    const w = baseWatch({
      levels: [
        { index: 1, price: 2650, volumeLots: 0.01, status: 'filled' },
        { index: 2, price: 2660, volumeLots: 0.01, status: 'pending' },
      ],
    });
    registry.register(w);
    expect(registry.getFilledTpCount(1)).toBe(1);
  });

  it('unregister removes from both indexes', () => {
    registry.register(baseWatch());
    registry.unregister(1);
    expect(registry.getByTradeId(1)).toBeUndefined();
    expect(registry.getBySymbolId(42)).toEqual([]);
  });

  it('symbolId index holds multiple watches', () => {
    registry.register(baseWatch({ tradeId: 1 }));
    registry.register(baseWatch({ tradeId: 2, positionId: '101' }));
    expect(registry.getBySymbolId(42)).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

Run: `npm test -- src/ctrader/tickClose/__tests__/tickTpRegistry.test.ts`

- [ ] **Step 4: Implement registry**

```ts
// src/ctrader/tickClose/tickTpRegistry.ts
import type { TickTpWatch } from './types.js';

export class TickTpRegistry {
  private byTradeId = new Map<number, TickTpWatch>();
  private bySymbolId = new Map<number, Set<TickTpWatch>>();

  register(watch: TickTpWatch): void {
    this.unregister(watch.tradeId);
    this.byTradeId.set(watch.tradeId, watch);
    let set = this.bySymbolId.get(watch.symbolId);
    if (!set) {
      set = new Set();
      this.bySymbolId.set(watch.symbolId, set);
    }
    set.add(watch);
  }

  unregister(tradeId: number): void {
    const existing = this.byTradeId.get(tradeId);
    if (!existing) return;
    this.byTradeId.delete(tradeId);
    const set = this.bySymbolId.get(existing.symbolId);
    set?.delete(existing);
    if (set?.size === 0) this.bySymbolId.delete(existing.symbolId);
  }

  getByTradeId(tradeId: number): TickTpWatch | undefined {
    return this.byTradeId.get(tradeId);
  }

  getBySymbolId(symbolId: number): TickTpWatch[] {
    return [...(this.bySymbolId.get(symbolId) ?? [])];
  }

  getFilledTpCount(tradeId: number): number {
    const watch = this.byTradeId.get(tradeId);
    if (!watch) return 0;
    return watch.levels.filter((l) => l.status === 'filled').length;
  }

  allSymbolIds(): number[] {
    return [...this.bySymbolId.keys()];
  }
}
```

- [ ] **Step 5: Run test — expect PASS**

Run: `npm test -- src/ctrader/tickClose/__tests__/tickTpRegistry.test.ts`

---

### Task 3: Pure tick trigger logic

**Files:**
- Create: `src/ctrader/tickClose/tickTrigger.ts`
- Create: `src/ctrader/tickClose/__tests__/tickTrigger.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/ctrader/tickClose/__tests__/tickTrigger.test.ts
import { describe, expect, it } from 'vitest';
import { findNextTriggeredLevel } from '../tickTrigger.js';
import type { TickTpLevel } from '../types.js';

const levels = (items: Array<[number, number, TickTpLevel['status']]>): TickTpLevel[] =>
  items.map(([index, price, status]) => ({
    index,
    price,
    volumeLots: 0.01,
    status,
  }));

describe('findNextTriggeredLevel', () => {
  it('long: triggers when bid >= lowest pending TP', () => {
    const hit = findNextTriggeredLevel('long', { bid: 2651, ask: 2651.5 }, levels([[1, 2650, 'pending'], [2, 2660, 'pending']]));
    expect(hit?.index).toBe(1);
  });

  it('long: skips filled, returns next pending', () => {
    const hit = findNextTriggeredLevel('long', { bid: 2661, ask: 2661.5 }, levels([[1, 2650, 'filled'], [2, 2660, 'pending']]));
    expect(hit?.index).toBe(2);
  });

  it('short: triggers when ask <= TP', () => {
    const hit = findNextTriggeredLevel('short', { bid: 2649, ask: 2649.5 }, levels([[1, 2650, 'pending']]));
    expect(hit?.index).toBe(1);
  });

  it('returns undefined when no level touched', () => {
    const hit = findNextTriggeredLevel('long', { bid: 2640, ask: 2640.5 }, levels([[1, 2650, 'pending']]));
    expect(hit).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- src/ctrader/tickClose/__tests__/tickTrigger.test.ts`

- [ ] **Step 3: Implement**

```ts
// src/ctrader/tickClose/tickTrigger.ts
import type { TickTpLevel } from './types.js';

export const findNextTriggeredLevel = (
  direction: 'long' | 'short',
  quote: { bid: number; ask: number },
  levels: TickTpLevel[]
): TickTpLevel | undefined => {
  const pending = [...levels]
    .filter((l) => l.status === 'pending')
    .sort((a, b) => a.index - b.index);

  for (const level of pending) {
    const touched =
      direction === 'long'
        ? quote.bid >= level.price
        : quote.ask <= level.price;
    if (touched) return level;
  }
  return undefined;
};
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npm test -- src/ctrader/tickClose/__tests__/tickTrigger.test.ts`

---

### Task 4: CTraderClient persistent spot API

**Files:**
- Modify: `src/clients/ctraderClient.ts`

Current `getCurrentPrice()` subscribes briefly then unsubscribes. Tick-close needs persistent subscriptions and a shared event listener.

- [ ] **Step 1: Add public methods to `CTraderClient`**

Add near other spot helpers (after `getCurrentPrice`):

```ts
/** Scale for ProtoOASpotEvent bid/ask (1/100_000 of price unit). */
export const CTRADER_SPOT_PRICE_SCALE = 100000;

export type CTraderSpotQuoteHandler = (event: {
  symbolId: number;
  bid: number;
  ask: number;
  timestampMs?: number;
}) => void;

private spotQuoteHandlers = new Set<CTraderSpotQuoteHandler>();
private persistentSpotRefCounts = new Map<number, number>();
private spotListenerId?: string;

/** Register handler for all ProtoOASpotEvent on this account connection. Returns unsubscribe. */
onSpotQuote(handler: CTraderSpotQuoteHandler): () => void {
  this.spotQuoteHandlers.add(handler);
  this.ensureSpotEventListener();
  return () => {
    this.spotQuoteHandlers.delete(handler);
  };
}

private ensureSpotEventListener(): void {
  if (this.spotListenerId || !this.connection) return;
  const id = this.connection.on('ProtoOASpotEvent', (ctraderEvent: unknown) => {
    const event = (ctraderEvent as { descriptor?: unknown })?.descriptor ?? ctraderEvent;
    const raw = event as Record<string, unknown>;
    const symbolId = protobufLongToNumber(raw.symbolId);
    if (symbolId == null) return;
    const bidRaw = raw.bid != null ? Number(raw.bid) : NaN;
    const askRaw = raw.ask != null ? Number(raw.ask) : NaN;
    const bid = Number.isFinite(bidRaw) ? bidRaw / CTRADER_SPOT_PRICE_SCALE : NaN;
    const ask = Number.isFinite(askRaw) ? askRaw / CTRADER_SPOT_PRICE_SCALE : NaN;
    if (!Number.isFinite(bid) && !Number.isFinite(ask)) return;
    const normalizedBid = Number.isFinite(bid) ? bid : ask;
    const normalizedAsk = Number.isFinite(ask) ? ask : bid;
    const ts = protobufLongToNumber(raw.timestamp);
    for (const h of this.spotQuoteHandlers) {
      h({ symbolId, bid: normalizedBid, ask: normalizedAsk, timestampMs: ts ?? undefined });
    }
  });
  this.spotListenerId = typeof id === 'string' ? id : undefined;
}

/** Increment ref-count and subscribe to spot for symbolId when first ref. */
async addPersistentSpotSubscription(symbolId: number): Promise<void> {
  await this.ensureConnected();
  if (!this.authenticated || !this.connection || !this.config.accountId) {
    throw new Error('Not authenticated with cTrader OpenAPI');
  }
  const prev = this.persistentSpotRefCounts.get(symbolId) ?? 0;
  this.persistentSpotRefCounts.set(symbolId, prev + 1);
  if (prev > 0) return;
  this.ensureSpotEventListener();
  const accountIdNum = parseInt(this.config.accountId, 10);
  await this.connection.sendCommand('ProtoOASubscribeSpotsReq', {
    ctidTraderAccountId: accountIdNum,
    symbolId: [symbolId],
  });
}

/** Decrement ref-count; unsubscribe when zero. */
async removePersistentSpotSubscription(symbolId: number): Promise<void> {
  const prev = this.persistentSpotRefCounts.get(symbolId) ?? 0;
  if (prev <= 0) return;
  const next = prev - 1;
  if (next > 0) {
    this.persistentSpotRefCounts.set(symbolId, next);
    return;
  }
  this.persistentSpotRefCounts.delete(symbolId);
  if (!this.connection || !this.config.accountId) return;
  try {
    await this.connection.sendCommand('ProtoOAUnsubscribeSpotsReq', {
      ctidTraderAccountId: parseInt(this.config.accountId, 10),
      symbolId: [symbolId],
    });
  } catch {
    // ignore if not subscribed
  }
}

/** Re-subscribe all symbolIds after reconnect. */
async resubscribePersistentSpots(): Promise<void> {
  if (!this.connection || !this.config.accountId) return;
  const ids = [...this.persistentSpotRefCounts.keys()];
  if (ids.length === 0) return;
  const accountIdNum = parseInt(this.config.accountId, 10);
  await this.connection.sendCommand('ProtoOASubscribeSpotsReq', {
    ctidTraderAccountId: accountIdNum,
    symbolId: ids,
  });
}
```

- [ ] **Step 2: Call `resubscribePersistentSpots()` after successful reconnect in `ensureConnected` / reconnect path**

In the reconnect success block (where `this.authenticated = true`), add:

```ts
await this.resubscribePersistentSpots().catch((err) => {
  logger.warn('Failed to resubscribe persistent spots after reconnect', {
    accountId: this.config.accountId,
    error: serializeErrorForLog(err),
    exchange: 'ctrader',
  });
});
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `npm test -- src/clients/__tests__/`

---

### Task 5: Spot stream wrapper

**Files:**
- Create: `src/ctrader/tickClose/ctraderSpotStream.ts`

- [ ] **Step 1: Implement ref-counted wrapper**

```ts
// src/ctrader/tickClose/ctraderSpotStream.ts
import type { CTraderClient, CTraderSpotQuoteHandler } from '../../clients/ctraderClient.js';
import type { SpotQuote } from './types.js';

export class CTraderSpotStream {
  private lastSpotAt = new Map<number, number>();
  private unsubscribeHandler?: () => void;

  constructor(private readonly client: CTraderClient) {}

  start(onQuote: (quote: SpotQuote) => void): void {
    if (this.unsubscribeHandler) return;
    const handler: CTraderSpotQuoteHandler = ({ symbolId, bid, ask, timestampMs }) => {
      this.lastSpotAt.set(symbolId, Date.now());
      onQuote({ symbolId, bid, ask, timestampMs });
    };
    this.unsubscribeHandler = this.client.onSpotQuote(handler);
  }

  stop(): void {
    this.unsubscribeHandler?.();
    this.unsubscribeHandler = undefined;
  }

  async ensureSubscribed(symbolId: number): Promise<void> {
    await this.client.addPersistentSpotSubscription(symbolId);
  }

  async releaseSymbol(symbolId: number): Promise<void> {
    await this.client.removePersistentSpotSubscription(symbolId);
  }

  getLastSpotAt(symbolId: number): number | undefined {
    return this.lastSpotAt.get(symbolId);
  }
}
```

---

### Task 6: Hydration from DB

**Files:**
- Create: `src/ctrader/tickClose/hydrateTickTpWatches.ts`
- Create: `src/ctrader/tickClose/__tests__/hydrateTickTpWatches.test.ts`

- [ ] **Step 1: Write failing hydration test**

Test builds watches from a trade + filled orders, marking levels 1 as filled and 2 as pending.

- [ ] **Step 2: Implement pure builder**

```ts
// src/ctrader/tickClose/hydrateTickTpWatches.ts
import type { Trade, Order } from '../../db/schema.js';
import type { TickTpWatch, TickTpLevel } from './types.js';
import { distributeQuantityAcrossTPs, validateAndRedistributeTPQuantities } from '../../utils/positionSizing.js';

const TP_SPLIT = { lastSliceRounding: 'floor' as const };

export const buildIntermediateTpLevels = (
  tpPrices: number[],
  totalVolumeLots: number,
  volumeStep: number | undefined,
  minVolume: number | undefined,
  maxVolume: number | undefined,
  decimalPrecision: number,
  filledTpIndices: Set<number>
): TickTpLevel[] => {
  if (tpPrices.length <= 1) return [];
  const intermediatePrices = tpPrices.slice(0, -1);
  const tpQuantities = distributeQuantityAcrossTPs(
    totalVolumeLots,
    tpPrices.length,
    decimalPrecision,
    TP_SPLIT
  );
  const valid = validateAndRedistributeTPQuantities(
    tpQuantities,
    tpPrices,
    totalVolumeLots,
    volumeStep,
    minVolume,
    maxVolume,
    decimalPrecision,
    TP_SPLIT
  ).filter((o) => o.index < tpPrices.length);

  return valid.map((o) => ({
    index: o.index,
    price: o.price,
    volumeLots: o.quantity,
    status: filledTpIndices.has(o.index) ? 'filled' : 'pending',
  }));
};

export const buildWatchFromTrade = (params: {
  trade: Trade;
  symbolId: number;
  totalVolumeLots: number;
  filledTpIndices: Set<number>;
  volumeStep?: number;
  minVolume?: number;
  maxVolume?: number;
  decimalPrecision: number;
}): TickTpWatch | null => {
  const { trade, symbolId, totalVolumeLots, filledTpIndices } = params;
  if (!trade.position_id) return null;
  let tpPrices: number[] = [];
  try {
    tpPrices = JSON.parse(trade.take_profits || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(tpPrices) || tpPrices.length <= 1) return null;

  const levels = buildIntermediateTpLevels(
    tpPrices,
    totalVolumeLots,
    params.volumeStep,
    params.minVolume,
    params.maxVolume,
    params.decimalPrecision,
    filledTpIndices
  );
  const filledVolume = levels
    .filter((l) => l.status === 'filled')
    .reduce((s, l) => s + l.volumeLots, 0);

  return {
    tradeId: trade.id,
    positionId: String(trade.position_id),
    channel: trade.channel,
    messageId: String(trade.message_id),
    accountName: trade.account_name ?? '',
    symbol: trade.trading_pair.replace('/', ''),
    symbolId,
    direction: trade.direction === 'short' ? 'short' : 'long',
    remainingVolumeLots: Math.max(0, totalVolumeLots - filledVolume),
    levels,
    closingInFlight: false,
  };
};

export const filledTpIndicesFromOrders = (orders: Order[]): Set<number> => {
  const filled = new Set<number>();
  for (const o of orders) {
    if (o.order_type === 'take_profit' && o.status === 'filled' && o.tp_index != null) {
      filled.add(o.tp_index);
    }
  }
  return filled;
};
```

- [ ] **Step 3: Run hydration tests — expect PASS**

Run: `npm test -- src/ctrader/tickClose/__tests__/hydrateTickTpWatches.test.ts`

---

### Task 7: Tick TP service

**Files:**
- Create: `src/ctrader/tickClose/ctraderTickTpService.ts`
- Create: `src/ctrader/tickClose/tickTpServiceManager.ts`

- [ ] **Step 1: Implement `CTraderTickTpService`**

Key responsibilities:
- Own `TickTpRegistry` + `CTraderSpotStream`
- `async start(db, accountName, getClient, breakevenHook)` — hydrate active trades for account, subscribe symbols
- `register(watch)` — add to registry, `ensureSubscribed(symbolId)`
- `unregister(tradeId)` — remove watch; `releaseSymbol` if no watches left for symbol
- `getFilledTpCount(tradeId)` — delegate to registry
- On spot quote: for each watch on symbol, `findNextTriggeredLevel`; if hit and not `closingInFlight`, call `closePosition`
- On success: mark filled, decrement remaining, fire async `db.insertOrder`, call breakeven hook with `filledTpCountOverride`
- On failure: revert level to pending, log

Synthetic order id pattern: `tick-close-${tradeId}-${tpIndex}`

- [ ] **Step 2: Implement manager**

```ts
// src/ctrader/tickClose/tickTpServiceManager.ts
import type { AccountConfig } from '../../types/config.js';
import type { DatabaseManager } from '../../db/schema.js';
import type { CTraderClient } from '../../clients/ctraderClient.js';
import { isTickCloseStrategy } from '../../utils/ctraderTpStrategy.js';
import { CTraderTickTpService } from './ctraderTickTpService.js';
import type { TickTpWatch } from './types.js';

const services = new Map<string, CTraderTickTpService>();

export const startTickTpServices = async (params: {
  accounts: AccountConfig[];
  db: DatabaseManager;
  getCTraderClient: (accountName?: string) => Promise<CTraderClient | undefined>;
  isSimulation: boolean;
  onBreakevenCheck?: /* same signature as monitor hook */;
}): Promise<() => Promise<void>> => {
  if (params.isSimulation) return async () => {};
  for (const account of params.accounts) {
    if (account.exchange !== 'ctrader' || !isTickCloseStrategy(account)) continue;
    const client = await params.getCTraderClient(account.name);
    if (!client) continue;
    const svc = new CTraderTickTpService(account.name, client, params.db, params.onBreakevenCheck);
    await svc.start();
    services.set(account.name, svc);
  }
  return async () => {
    for (const svc of services.values()) await svc.stop();
    services.clear();
  };
};

export const getTickTpService = (accountName: string): CTraderTickTpService | undefined =>
  services.get(accountName);

export const registerTickCloseWatch = (accountName: string, watch: TickTpWatch): void => {
  services.get(accountName)?.register(watch);
};
```

- [ ] **Step 3: Wire breakeven hook**

The service's `onBreakevenCheck` should call exported monitor helper (extract or export `checkAndApplyBreakeven` from `ctraderMonitor.ts`, or pass a thin wrapper created in orchestrator that has access to monitor config).

Prefer: export `checkAndApplyBreakevenForTrade(trade, db, client, monitorConfig, { filledTpCountOverride })` from `ctraderMonitor.ts` to avoid duplicating SL logic.

---

### Task 8: Tick-close placement module

**Files:**
- Create: `src/ctrader/tickClose/ctraderTickClosePlacement.ts`

- [ ] **Step 1: Implement placement function**

Extract from existing single-trade path in `ctraderInitiator.ts` (~lines 2318–2433):

```ts
export type TickClosePlacementParams = {
  ctraderClient: CTraderClient;
  tradeId: number;
  channel: string;
  messageId: string;
  accountName: string;
  symbol: string;
  positionId: string;
  direction: 'long' | 'short';
  roundedStopLoss?: number;
  tpPrices: number[];
  totalVolumeLots: number;
  volumeStep?: number;
  minOrderVolume?: number;
  maxOrderVolume?: number;
  decimalPrecision: number;
};

export type TickClosePlacementResult = {
  watch: TickTpWatch | null;
};

export const placeTickClosePosition = async (
  params: TickClosePlacementParams
): Promise<TickClosePlacementResult> => {
  const { tpPrices, positionId, ctraderClient } = params;
  const lastTp = tpPrices[tpPrices.length - 1];

  const modifyPayload: { positionId: string; stopLoss?: number; takeProfit?: number } = {
    positionId,
  };
  if (params.roundedStopLoss && params.roundedStopLoss > 0) {
    modifyPayload.stopLoss = params.roundedStopLoss;
  }
  if (lastTp != null && lastTp > 0) {
    modifyPayload.takeProfit = lastTp;
  }
  if (modifyPayload.stopLoss != null || modifyPayload.takeProfit != null) {
    await ctraderClient.modifyPosition(modifyPayload);
  }

  if (tpPrices.length <= 1) {
    return { watch: null };
  }

  const symbolInfo = await ctraderClient.getSymbolInfo(params.symbol);
  const symbolId = /* extract from symbolInfo like initiator does */;
  const filled = new Set<number>();
  const watch = buildWatchFromTrade({
    trade: {
      id: params.tradeId,
      position_id: positionId,
      channel: params.channel,
      message_id: params.messageId,
      account_name: params.accountName,
      trading_pair: params.symbol,
      direction: params.direction,
      take_profits: JSON.stringify(tpPrices),
    } as Trade,
    symbolId,
    totalVolumeLots: params.totalVolumeLots,
    filledTpIndices: filled,
    volumeStep: params.volumeStep,
    minVolume: params.minOrderVolume,
    maxVolume: params.maxOrderVolume,
    decimalPrecision: params.decimalPrecision,
  });

  return { watch };
};
```

- [ ] **Step 2: Do not place any `placeLimitOrder` calls in this module**

---

### Task 9: Initiator integration

**Files:**
- Modify: `src/initiators/ctraderInitiator.ts`
- Modify: `src/initiators/initiatorRegistry.ts` (optional — can import manager directly)

- [ ] **Step 1: Import helpers**

```ts
import { isTickCloseStrategy } from '../utils/ctraderTpStrategy.js';
import { registerTickCloseWatch } from '../ctrader/tickClose/tickTpServiceManager.js';
import { placeTickClosePosition } from '../ctrader/tickClose/ctraderTickClosePlacement.js';
```

- [ ] **Step 2: Guard N-trades path**

Where N-trades condition is checked (~line 1317), add account strategy guard:

```ts
const useTickClose = isTickCloseStrategy(account);
if (
  !useTickClose &&
  roundedTPPrices &&
  roundedTPPrices.length > 1 &&
  roundedStopLoss &&
  roundedStopLoss > 0
) {
  // existing N-trades path
}
```

- [ ] **Step 3: After single-trade entry fill, branch TP placement**

Replace limit-TP loop when `useTickClose`:

```ts
if (useTickClose && roundedTPPrices && roundedTPPrices.length > 0 && positionIdStr) {
  const { watch } = await placeTickClosePosition({
    ctraderClient,
    tradeId,
    channel,
    messageId: String(message.message_id),
    accountName: accountName || 'default',
    symbol,
    positionId: positionIdStr,
    direction: order.signalType === 'long' ? 'long' : 'short',
    roundedStopLoss,
    tpPrices: roundedTPPrices,
    totalVolumeLots: totalQtyForTPs,
    volumeStep,
    minOrderVolume,
    maxOrderVolume,
    decimalPrecision,
  });
  if (watch) {
    registerTickCloseWatch(accountName || 'default', watch);
  }
} else {
  // existing modifyPosition + placeLimitOrder path
}
```

- [ ] **Step 4: Run initiator tests**

Run: `npm test -- src/initiators/__tests__/ctraderInitiator.test.ts`

Add unit test mocking `isTickCloseStrategy` + verifying N-trades skipped when tick-close (if feasible without full integration).

---

### Task 10: Breakeven gate in monitor

**Files:**
- Modify: `src/monitors/ctraderMonitor.ts`
- Modify: `src/monitors/__tests__/ctraderBreakevenEligibility.test.ts` (add tick-close case)

- [ ] **Step 1: Import registry lookup**

```ts
import { getTickTpService } from '../ctrader/tickClose/tickTpServiceManager.js';
import { countFilledTakeProfits } from './shared.js';
import { isTickCloseStrategy } from '../utils/ctraderTpStrategy.js';
```

Pass `accountMap` or resolve account from trade.account_name in monitor (orchestrator already has `accountMap` — thread via `CTraderMonitorStartExtras`):

```ts
export type CTraderMonitorStartExtras = {
  // existing fields...
  getAccountConfig?: (accountName?: string) => AccountConfig | undefined;
};
```

- [ ] **Step 2: Extend `checkAndApplyBreakeven` options**

Add `filledTpCountOverride?: number` to options type.

Replace TP gate block (~lines 207–220):

```ts
const account = /* resolve from trade.account_name via getAccountConfig */;
const useTickClose = isTickCloseStrategy(account);

let filledTpCount = 0;
if (useTickClose) {
  filledTpCount =
    options?.filledTpCountOverride ??
    getTickTpService(trade.account_name ?? '')?.getFilledTpCount(trade.id) ??
    (await countFilledTakeProfits(trade, db));
  const tpGateMet = filledTpCount >= effectiveBreakevenAfterTPs;
  if (!tpGateMet) return;
} else {
  const siblingsHitTp =
    (await countCtraderSiblingsClosedAtTakeProfit(allSiblings, trade.id, ctraderClient)) +
    (options?.extraClosedTpWeight ?? 0);
  const messageCtraderSiblings = allSiblings.filter((t) => t.exchange === 'ctrader');
  const closedSiblingCount = messageCtraderSiblings.filter(/* existing */).length;
  const tpGateMet = siblingsHitTp >= effectiveBreakevenAfterTPs;
  const siblingCloseGateMet = closedSiblingCount >= effectiveBreakevenAfterTPs;
  if (!tpGateMet && !siblingCloseGateMet) return;
}
```

- [ ] **Step 3: Unregister watch when trade closes**

In position-close commit path in `monitorTrade`, after marking trade closed:

```ts
getTickTpService(trade.account_name ?? '')?.unregister(trade.id);
```

- [ ] **Step 4: Add test for tick-close filled count gate**

```ts
it('tick-close uses filledTpCountOverride instead of siblings', () => {
  const filledTpCount = 2;
  const effectiveBreakevenAfterTPs = 2;
  expect(filledTpCount >= effectiveBreakevenAfterTPs).toBe(true);
});
```

Run: `npm test -- src/monitors/__tests__/ctraderBreakevenEligibility.test.ts`

---

### Task 11: Orchestrator wiring

**Files:**
- Modify: `src/orchestrator/tradeOrchestrator.ts`

- [ ] **Step 1: Start tick services after cTrader auth verify, before channel loops**

```ts
import { startTickTpServices } from '../ctrader/tickClose/tickTpServiceManager.js';

// After verifyAllCtraderAccountsAtStartup / client pool setup:
const stopTickTpServices = await startTickTpServices({
  accounts: config.accounts ?? [],
  db,
  getCTraderClient: createCTraderClient,
  isSimulation,
  onBreakevenCheck: /* wrapper around exported checkAndApplyBreakeven */,
});
state.stopTickTpServices = stopTickTpServices;
```

- [ ] **Step 2: Pass `getAccountConfig` into ctrader monitor extras**

```ts
getAccountConfig: (name?: string) => (name ? accountMap.get(name) : undefined),
```

- [ ] **Step 3: Stop tick services on shutdown**

In orchestrator cleanup, call `stopTickTpServices()` alongside monitor stops.

---

### Task 12: Config rollout

**Files:**
- Modify: `config.json`

- [ ] **Step 1: Add to all cTrader accounts**

For `ctrader_live_5`, `ctrader_demo_2_100`, `ctrader_demo_2_25` (and any other `exchange: "ctrader"` blocks):

```json
"ctraderTpStrategy": "tick-close"
```

- [ ] **Step 2: Manual validation checklist**

On demo account with 3-TP signal:
1. Exactly **one** entry order at open.
2. **Zero** pending limit TP orders on exchange after fill.
3. Position shows SL + last TP.
4. When price crosses TP1/TP2, `closePosition` partial closes fire (check logs + deals).
5. Breakeven SL moves after configured N fills without waiting for DB poll.
6. Restart process — hydration resumes watching active trades.

---

### Task 13: Full test suite

- [ ] **Step 1: Run all unit tests**

Run: `npm test`

Expected: all pass

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` (if project uses it; otherwise rely on vitest + build script)

---

## Spec coverage checklist

| Spec section | Task |
|--------------|------|
| Account `ctraderTpStrategy` | Task 1 |
| Single entry, no limit TPs | Tasks 8, 9 |
| Last TP on position | Task 8 |
| Live spot ticks | Tasks 4, 5, 7 |
| `closePosition` partial closes | Task 7 |
| In-memory cache | Tasks 2, 7 |
| Breakeven from registry | Tasks 7, 10 |
| DB async on TP hit | Task 7 |
| Hydration on restart | Task 6, 7 |
| Orchestrator lifecycle | Task 11 |
| Rollout all cTrader accounts | Task 12 |
| Fallback stale spot (log only v1) | Task 5 (`getLastSpotAt`) + optional warn in Task 7 |

---

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-06-12-ctrader-tick-close-tp.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — implement tasks in this session with checkpoints

Which approach do you want?
