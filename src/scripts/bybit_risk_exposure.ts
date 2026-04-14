#!/usr/bin/env node
/**
 * Bybit linear risk: worst-case loss if everything hits stop-loss (open positions + pending
 * same-side non-reduce orders blended into avg entry), plus notional/margin context.
 *
 * Worst-case math matches `calculateWorstCaseLossForOpenPositions` / prop firm
 * `additionalWorstCaseLoss` (downside move to SL × qty). Pending adds: blended entry, same
 * position SL as Bybit `setTradingStop` (Full).
 *
 * Uses the same credential resolution as other Bybit scripts (see resolveBybitRestClient).
 *
 * Usage:
 *   tsx src/scripts/bybit_risk_exposure.ts --account demo
 *   tsx src/scripts/bybit_risk_exposure.ts --api-key <k> --api-secret <s> [--testnet] [--demo]
 *   tsx src/scripts/bybit_risk_exposure.ts --json
 */

import 'dotenv/config';
import { Command } from 'commander';
import { RestClientV5 } from 'bybit-api';
import {
  fetchMergedLinearActiveOrders,
  fetchMergedOpenLinearPositions,
} from '../utils/bybitMergedLinearApi.js';
import {
  aggregateLinearExposureByBaseAsset,
  parseLinearPositionExposure,
  totalsFromAggregation,
  type AggregatedAssetExposure,
  type ParsedLinearPositionExposure,
} from '../utils/bybitLinearExposure.js';
import { analyzeWorstCaseLossWithPendingOrders } from '../utils/bybitWorstCaseLoss.js';
import { resolveBybitRestClient } from '../utils/resolveBybitRestClient.js';
import { withBybitRateLimitRetry } from '../utils/bybitRateLimitRetry.js';

const program = new Command();

program
  .name('bybit-risk-exposure')
  .description('Show Bybit linear position risk exposure by base asset and totals')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--account <name>', 'Account name from config')
  .option('--api-key <key>', 'API key (direct)')
  .option('--api-secret <secret>', 'API secret (direct)')
  .option('--env-key <name>', 'Environment variable name for API key')
  .option('--env-secret <name>', 'Environment variable name for API secret')
  .option('--testnet', 'Use testnet (ignored when --demo)', false)
  .option('--demo', 'Use demo trading endpoint (api-demo.bybit.com)', false)
  .option('--json', 'Print JSON instead of a text table', false)
  .option('--skip-wallet', 'Skip unified wallet balance (USDT) fetch', false)
  .action(async (options) => {
    try {
      const session = await resolveBybitRestClient({
        configPath: options.config,
        account: options.account,
        apiKey: options.apiKey,
        apiSecret: options.apiSecret,
        envKey: options.envKey,
        envSecret: options.envSecret,
        testnet: options.testnet,
        demo: options.demo,
      });

      const positions = await fetchMergedOpenLinearPositions(session.client);
      const activeOrders = await fetchMergedLinearActiveOrders(session.client);
      const worstCase = analyzeWorstCaseLossWithPendingOrders(positions, activeOrders);

      const parsed: ParsedLinearPositionExposure[] = positions.map((p) =>
        parseLinearPositionExposure(p as Record<string, unknown>)
      );
      const byAsset = aggregateLinearExposureByBaseAsset(parsed);
      const totals = totalsFromAggregation(byAsset);

      let wallet: { usdtWallet?: number; usdtEquity?: number } | undefined;
      if (!options.skipWallet) {
        wallet = await fetchUsdtWalletSnapshot(session.client);
      }

      const payload = {
        meta: {
          accountName: session.accountName,
          testnet: session.testnet,
          demo: session.demo,
          effectiveTestnet: session.effectiveTestnet,
          baseUrl:
            session.baseUrl ||
            (session.effectiveTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com'),
        },
        wallet,
        worstCase,
        positions: parsed,
        activeOrderCount: activeOrders.length,
        byAsset: Object.fromEntries(
          [...byAsset.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        ),
        totals: {
          ...totals,
          note: 'Gross notional and margin are in each contract quote (USDT vs USDC); do not add USDT+USDC into one USD figure without FX.',
        },
      };

      if (options.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      printHumanReadable(payload.byAsset, totals, parsed, session, wallet, worstCase);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  });

program.parse();

async function fetchUsdtWalletSnapshot(client: RestClientV5): Promise<
  { usdtWallet?: number; usdtEquity?: number } | undefined
> {
  try {
    const res = await withBybitRateLimitRetry(
      () => client.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' }),
      { label: 'getWalletBalance USDT' }
    );
    if (res.retCode !== 0) return undefined;
    const row = res.result?.list?.[0] as { coin?: { coin?: string; walletBalance?: string; equity?: string }[] } | undefined;
    const usdt = row?.coin?.find((c) => c.coin === 'USDT');
    if (!usdt) return undefined;
    return {
      usdtWallet: parseFloat(usdt.walletBalance || '0') || undefined,
      usdtEquity: parseFloat(usdt.equity || usdt.walletBalance || '0') || undefined,
    };
  } catch {
    return undefined;
  }
}

function fmtQuote(n: number): string {
  if (!Number.isFinite(n)) return '∞ (unbounded)';
  return n.toFixed(2);
}

function printHumanReadable(
  byAsset: Record<string, AggregatedAssetExposure>,
  totals: ReturnType<typeof totalsFromAggregation>,
  positions: ParsedLinearPositionExposure[],
  session: Awaited<ReturnType<typeof resolveBybitRestClient>>,
  wallet: { usdtWallet?: number; usdtEquity?: number } | undefined,
  worstCase: ReturnType<typeof analyzeWorstCaseLossWithPendingOrders>
): void {
  console.log('\nBybit linear risk exposure');
  console.log('='.repeat(72));
  console.log(`Account: ${session.accountName}`);
  console.log(
    `Environment: ${session.demo ? 'demo (api-demo.bybit.com)' : session.effectiveTestnet ? 'testnet' : 'production'}`
  );
  if (wallet?.usdtEquity !== undefined || wallet?.usdtWallet !== undefined) {
    console.log(
      `USDT wallet / equity: ${wallet.usdtWallet ?? '—'} / ${wallet.usdtEquity ?? '—'} (context only)`
    );
  }
  console.log('='.repeat(72));

  console.log('\nWorst-case loss (quote) if price reaches stop-loss');
  console.log(
    '  Same idea as prop firm `additionalWorstCaseLoss`: Σ (adverse move to SL)×qty per leg; pending same-side non-reduce orders blend into avg entry.'
  );
  console.log(`  Positions only (all open legs):     ${fmtQuote(worstCase.positionsOnlyWorstCaseQuote)}`);
  console.log(`  Including pending adds + orphans:   ${fmtQuote(worstCase.withPendingAddsWorstCaseQuote)}`);
  if (worstCase.unboundedReasons.length > 0) {
    console.log('  Unbounded / incomplete:');
    for (const r of worstCase.unboundedReasons) console.log(`    - ${r}`);
  }
  if (worstCase.missingStopLossSymbols.length > 0) {
    console.log(`  Missing position SL (symbols): ${worstCase.missingStopLossSymbols.join(', ')}`);
  }

  if (worstCase.perPosition.length > 0) {
    console.log('\n  Per position (with pending same-side adds blended)');
    for (const row of worstCase.perPosition.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
      const pend =
        row.additiveLeavesQty > 0
          ? ` +${row.additiveLeavesQty.toFixed(4)} pending @ blended ${row.blendedAvgPrice.toFixed(4)}`
          : '';
      console.log(
        `    ${row.symbol} (${row.side})  SL ${row.stopLoss}  loss ${fmtQuote(row.lossPositionsOnlyQuote)} → ${fmtQuote(row.lossWithPendingAddsQuote)}${pend} [${row.quoteCurrency}]`
      );
    }
  }
  if (worstCase.orphanOpeningOrders.length > 0) {
    console.log('\n  Opening orders (no position yet; SL from order row if present)');
    for (const o of worstCase.orphanOpeningOrders) {
      console.log(
        `    ${o.symbol} ${o.side} leaves ${o.leavesQty}  entry~${o.assumedEntryPrice}  SL ${o.stopLossOnOrder || '—'}  loss ${fmtQuote(o.lossIfSlHitsQuote)}`
      );
    }
  }

  if (positions.length === 0 && worstCase.orphanOpeningOrders.length === 0) {
    console.log('\nNo open linear positions and no unmatched opening orders.');
    console.log('Notional / margin: n/a.\n');
    return;
  }

  if (positions.length === 0) {
    console.log('\n(No open positions — notional table skipped.)\n');
    return;
  }

  console.log('\nOpen positions (per contract)\n');
  console.log(
    [
      'Symbol'.padEnd(14),
      'Q'.padEnd(4),
      'Side'.padEnd(6),
      'Size'.padEnd(10),
      'Lev'.padEnd(4),
      'Notional'.padStart(12),
      'IM'.padStart(10),
      'uPnL'.padStart(10),
      'Mark'.padStart(12),
      'Liq',
    ].join(' ')
  );
  for (const p of positions.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    const liq = p.liqPrice !== null ? p.liqPrice.toFixed(4) : '—';
    const q = p.quoteCurrency === 'unknown' ? '?' : p.quoteCurrency === 'USDC' ? 'U' : 'T';
    console.log(
      [
        p.symbol.padEnd(14),
        q.padEnd(4),
        p.side.padEnd(6),
        String(p.size).padEnd(10),
        String(p.leverage).padEnd(4),
        p.positionValueQuote.toFixed(2).padStart(12),
        p.initialMarginQuote.toFixed(2).padStart(10),
        p.unrealisedPnlQuote.toFixed(2).padStart(10),
        p.markPrice.toFixed(6).padStart(12),
        liq,
      ].join(' ')
    );
  }
  console.log('  Q: T=USDT quote, U=USDC quote, ?=unknown (treated as USDT in aggregates)');

  console.log('\nBy base asset (aggregated)\n');
  const keys = Object.keys(byAsset).sort();
  for (const k of keys) {
    const a = byAsset[k];
    console.log(`  ${k}`);
    console.log(`    Gross notional USDT: ${a.grossNotionalUsdt.toFixed(2)}  |  USDC: ${a.grossNotionalUsdc.toFixed(2)}`);
    console.log(`    Initial margin USDT: ${a.sumInitialMarginUsdt.toFixed(2)}  |  USDC: ${a.sumInitialMarginUsdc.toFixed(2)}`);
    console.log(`    Maintenance USDT:    ${a.sumMaintenanceMarginUsdt.toFixed(2)}  |  USDC: ${a.sumMaintenanceMarginUsdc.toFixed(2)}`);
    console.log(`    Unrealised PnL USDT: ${a.netUnrealisedPnlUsdt.toFixed(2)}  |  USDC: ${a.netUnrealisedPnlUsdc.toFixed(2)}`);
    console.log(`    Symbols: ${a.symbols.join(', ')}`);
  }

  console.log('\nTotals (all assets)');
  console.log(`  Gross notional USDT: ${totals.grossNotionalUsdt.toFixed(2)}`);
  console.log(`  Gross notional USDC: ${totals.grossNotionalUsdc.toFixed(2)}`);
  console.log(`  Initial margin USDT: ${totals.sumInitialMarginUsdt.toFixed(2)}  |  USDC: ${totals.sumInitialMarginUsdc.toFixed(2)}`);
  console.log(`  Maintenance USDT:  ${totals.sumMaintenanceMarginUsdt.toFixed(2)}  |  USDC: ${totals.sumMaintenanceMarginUsdc.toFixed(2)}`);
  console.log(`  Unrealised PnL USDT: ${totals.netUnrealisedPnlUsdt.toFixed(2)}  |  USDC: ${totals.netUnrealisedPnlUsdc.toFixed(2)}`);
  if (wallet?.usdtEquity && wallet.usdtEquity > 0) {
    const ratio = (totals.grossNotionalUsdt / wallet.usdtEquity) * 100;
    console.log(`  USDT notional / USDT equity: ${ratio.toFixed(1)}%`);
  }
  console.log('');
}
