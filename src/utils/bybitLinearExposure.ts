/**
 * Linear position exposure helpers (USDT/USDC-margined contracts).
 * Uses getBybitField for camelCase/snake_case compatibility with API responses.
 */

import { getBybitField } from './bybitFieldHelper.js';

/** Base asset label from symbol, e.g. BTCUSDT → BTC, ETHUSDC → ETH */
export function baseAssetFromLinearSymbol(symbol: string): string {
  const s = (symbol || '').toUpperCase();
  if (s.endsWith('USDT')) return s.slice(0, -4);
  if (s.endsWith('USDC')) return s.slice(0, -4);
  return s;
}

export interface ParsedLinearPositionExposure {
  symbol: string;
  baseAsset: string;
  positionIdx: string;
  side: string;
  size: number;
  /** |position value| in the contract's quote/settle currency (USDT or USDC) */
  positionValueQuote: number;
  initialMarginQuote: number;
  maintenanceMarginQuote: number;
  leverage: number;
  markPrice: number;
  avgPrice: number;
  liqPrice: number | null;
  unrealisedPnlQuote: number;
  /** Quote/settle currency for this contract; position value is denominated in this */
  quoteCurrency: 'USDT' | 'USDC' | 'unknown';
}

function numFrom(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

export function parseLinearPositionExposure(raw: Record<string, unknown>): ParsedLinearPositionExposure {
  const symbol = String(getBybitField<string>(raw, 'symbol') ?? '');
  const side = String(getBybitField<string>(raw, 'side') ?? '');
  const positionIdx = String(getBybitField<string | number>(raw, 'positionIdx', 'position_idx') ?? '0');

  const positionValue = numFrom(getBybitField<string>(raw, 'positionValue', 'position_value'));
  const positionIM = numFrom(getBybitField<string>(raw, 'positionIM', 'position_im'));
  const positionMM = numFrom(getBybitField<string>(raw, 'positionMM', 'position_mm'));

  let quoteCurrency: ParsedLinearPositionExposure['quoteCurrency'] = 'unknown';
  if (symbol.endsWith('USDT')) quoteCurrency = 'USDT';
  else if (symbol.endsWith('USDC')) quoteCurrency = 'USDC';

  return {
    symbol,
    baseAsset: baseAssetFromLinearSymbol(symbol),
    positionIdx,
    side,
    size: numFrom(getBybitField<string>(raw, 'size')),
    positionValueQuote: Math.abs(positionValue),
    initialMarginQuote: positionIM,
    maintenanceMarginQuote: positionMM,
    leverage: numFrom(getBybitField<string>(raw, 'leverage')) || 1,
    markPrice: numFrom(getBybitField<string>(raw, 'markPrice', 'mark_price')),
    avgPrice: numFrom(getBybitField<string>(raw, 'avgPrice', 'avg_price')),
    liqPrice: (() => {
      const lp = getBybitField<string>(raw, 'liqPrice', 'liq_price');
      if (lp === undefined || lp === null || lp === '') return null;
      const n = numFrom(lp);
      return n > 0 ? n : null;
    })(),
    unrealisedPnlQuote: numFrom(getBybitField<string>(raw, 'unrealisedPnl', 'unrealised_pnl')),
    quoteCurrency,
  };
}

export function isOpenLinearPosition(raw: Record<string, unknown>): boolean {
  const size = numFrom(getBybitField<string>(raw, 'size'));
  return Number.isFinite(size) && size !== 0;
}

export interface AggregatedAssetExposure {
  baseAsset: string;
  /** Sum of |position value| in USDT-settled contracts */
  grossNotionalUsdt: number;
  /** Sum of |position value| in USDC-settled contracts */
  grossNotionalUsdc: number;
  sumInitialMarginUsdt: number;
  sumInitialMarginUsdc: number;
  sumMaintenanceMarginUsdt: number;
  sumMaintenanceMarginUsdc: number;
  symbols: string[];
  netUnrealisedPnlUsdt: number;
  netUnrealisedPnlUsdc: number;
}

/**
 * Gross notional per asset = sum of |position value| for each open row (handles hedge / multi-idx).
 */
export function aggregateLinearExposureByBaseAsset(
  parsed: ParsedLinearPositionExposure[]
): Map<string, AggregatedAssetExposure> {
  const map = new Map<string, AggregatedAssetExposure>();

  for (const p of parsed) {
    const key = p.baseAsset;
    const prev = map.get(key) || {
      baseAsset: key,
      grossNotionalUsdt: 0,
      grossNotionalUsdc: 0,
      sumInitialMarginUsdt: 0,
      sumInitialMarginUsdc: 0,
      sumMaintenanceMarginUsdt: 0,
      sumMaintenanceMarginUsdc: 0,
      symbols: [] as string[],
      netUnrealisedPnlUsdt: 0,
      netUnrealisedPnlUsdc: 0,
    };
    if (p.quoteCurrency === 'USDC') {
      prev.grossNotionalUsdc += p.positionValueQuote;
      prev.sumInitialMarginUsdc += p.initialMarginQuote;
      prev.sumMaintenanceMarginUsdc += p.maintenanceMarginQuote;
      prev.netUnrealisedPnlUsdc += p.unrealisedPnlQuote;
    } else {
      prev.grossNotionalUsdt += p.positionValueQuote;
      prev.sumInitialMarginUsdt += p.initialMarginQuote;
      prev.sumMaintenanceMarginUsdt += p.maintenanceMarginQuote;
      prev.netUnrealisedPnlUsdt += p.unrealisedPnlQuote;
    }
    if (!prev.symbols.includes(p.symbol)) prev.symbols.push(p.symbol);
    map.set(key, prev);
  }

  return map;
}

export function totalsFromAggregation(m: Map<string, AggregatedAssetExposure>): {
  grossNotionalUsdt: number;
  grossNotionalUsdc: number;
  sumInitialMarginUsdt: number;
  sumInitialMarginUsdc: number;
  sumMaintenanceMarginUsdt: number;
  sumMaintenanceMarginUsdc: number;
  netUnrealisedPnlUsdt: number;
  netUnrealisedPnlUsdc: number;
} {
  let grossNotionalUsdt = 0;
  let grossNotionalUsdc = 0;
  let sumInitialMarginUsdt = 0;
  let sumInitialMarginUsdc = 0;
  let sumMaintenanceMarginUsdt = 0;
  let sumMaintenanceMarginUsdc = 0;
  let netUnrealisedPnlUsdt = 0;
  let netUnrealisedPnlUsdc = 0;
  for (const v of m.values()) {
    grossNotionalUsdt += v.grossNotionalUsdt;
    grossNotionalUsdc += v.grossNotionalUsdc;
    sumInitialMarginUsdt += v.sumInitialMarginUsdt;
    sumInitialMarginUsdc += v.sumInitialMarginUsdc;
    sumMaintenanceMarginUsdt += v.sumMaintenanceMarginUsdt;
    sumMaintenanceMarginUsdc += v.sumMaintenanceMarginUsdc;
    netUnrealisedPnlUsdt += v.netUnrealisedPnlUsdt;
    netUnrealisedPnlUsdc += v.netUnrealisedPnlUsdc;
  }
  return {
    grossNotionalUsdt,
    grossNotionalUsdc,
    sumInitialMarginUsdt,
    sumInitialMarginUsdc,
    sumMaintenanceMarginUsdt,
    sumMaintenanceMarginUsdc,
    netUnrealisedPnlUsdt,
    netUnrealisedPnlUsdc,
  };
}
