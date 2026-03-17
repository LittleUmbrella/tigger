#!/usr/bin/env node
/**
 * Debug cTrader trade closures - query exchange for specific orders/positions
 * to verify our closure detection logic.
 *
 * Usage:
 *   tsx src/scripts/debug_ctrader_trade_closures.ts
 *   tsx src/scripts/debug_ctrader_trade_closures.ts --trade-ids 273,274,275
 *   tsx src/scripts/debug_ctrader_trade_closures.ts --order-ids 4541858,4541860,4541862
 *   tsx src/scripts/debug_ctrader_trade_closures.ts --deal-ids 3706090,3702120,3702495   # DID prefix stripped
 *   tsx src/scripts/debug_ctrader_trade_closures.ts --trade-ids 273,274,275 --raw        # dump full deal JSON
 */

import dotenv from 'dotenv';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { DatabaseManager } from '../db/schema.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

if (fs.existsSync(path.join(projectRoot, '.env-investigation'))) {
  dotenv.config({ path: path.join(projectRoot, '.env-investigation') });
} else {
  dotenv.config({ path: path.join(projectRoot, '.env') });
}

const toNum = (v: any) => (typeof v === 'object' && v?.low != null ? protobufLongToNumber(v) : v);

async function main() {
  const args = process.argv.slice(2);
  const tradeIdsArg = args.find((a) => a.startsWith('--trade-ids='))?.split('=')[1];
  const orderIdsArg = args.find((a) => a.startsWith('--order-ids='))?.split('=')[1];
  const dealIdsArg = args.find((a) => a.startsWith('--deal-ids='))?.split('=')[1];
  const raw = args.includes('--raw');

  const clientId = process.env.CTRADER_CLIENT_ID;
  const clientSecret = process.env.CTRADER_CLIENT_SECRET;
  const accessToken = process.env.CTRADER_ACCESS_TOKEN;
  const accountId = process.env.CTRADER_ACCOUNT_ID;
  const environment = (process.env.CTRADER_ENVIRONMENT as 'demo' | 'live') || 'live';

  if (!clientId || !clientSecret || !accessToken || !accountId) {
    console.error('❌ Missing CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_ACCESS_TOKEN, or CTRADER_ACCOUNT_ID');
    process.exit(1);
  }

  const db = new DatabaseManager();
  await db.initialize();

  let orderIds: string[];
  let fromTs: number;
  let toTs: number;

  if (tradeIdsArg) {
    const ids = tradeIdsArg.split(',').map((s) => parseInt(s.trim(), 10));
    const results = await Promise.all(ids.map((id) => db.getTradeWithMessage(id)));
    const valid = results.filter((r): r is NonNullable<typeof r> => r != null);
    if (valid.length === 0) {
      console.error('❌ No trades found for ids:', ids);
      process.exit(1);
    }
    orderIds = valid.map((t) => t.order_id).filter((id): id is string => !!id).map(String);
    const starts = valid.map((t) =>
      t.entry_filled_at ? new Date(t.entry_filled_at).getTime() : new Date(t.created_at).getTime()
    );
    fromTs = Math.min(...starts);
    toTs = Date.now();
    console.log('\n=== Debug cTrader Trade Closures ===\n');
    console.log('From DB trades:', ids);
    for (const t of valid) {
      console.log(`  Trade ${t.id}: order_id=${t.order_id}, position_id=${t.position_id}, status=${t.status}`);
      console.log(`    created_at=${t.created_at}, entry_filled_at=${t.entry_filled_at || '(none)'}`);
    }
  } else if (orderIdsArg) {
    orderIds = orderIdsArg.split(',').map((s) => s.trim());
    toTs = Date.now();
    fromTs = toTs - 7 * 24 * 60 * 60 * 1000;
    console.log('\n=== Debug cTrader Trade Closures ===\n');
    console.log('Order IDs (from args):', orderIds);
    console.log('Time window: last 7 days');
  } else if (dealIdsArg) {
    orderIds = [];
    toTs = Date.now();
    fromTs = toTs - 7 * 24 * 60 * 60 * 1000;
    console.log('\n=== Debug cTrader Trade Closures (by deal IDs) ===\n');
    console.log(
      'Deal IDs:',
      dealIdsArg.split(',').map((s) => s.trim().replace(/^DID/i, ''))
    );
    console.log('Time window: last 7 days');
  } else {
    const trades = (await db.getActiveTrades()).filter((t) => t.exchange === 'ctrader' && t.order_id && !t.position_id);
    if (trades.length === 0) {
      console.log('No active cTrader trades with order_id but no position_id. Use --trade-ids or --order-ids.');
      process.exit(0);
    }
    orderIds = trades.map((t) => String(t.order_id!));
    const starts = trades.map((t) =>
      t.entry_filled_at ? new Date(t.entry_filled_at).getTime() : new Date(t.created_at).getTime()
    );
    fromTs = Math.min(...starts);
    toTs = Date.now();
    console.log('\n=== Debug cTrader Trade Closures ===\n');
    console.log('From DB (active cTrader trades with order_id, no position_id):');
    for (const t of trades) {
      console.log(`  Trade ${t.id}: order_id=${t.order_id}, status=${t.status}`);
    }
  }

  const maxWindow = 604800000;
  if (toTs - fromTs > maxWindow) fromTs = toTs - maxWindow;
  // Use at least 24h window to ensure we capture deals (narrow windows can miss due to timezone/timing)
  const minWindow = 24 * 60 * 60 * 1000;
  if (toTs - fromTs < minWindow) fromTs = toTs - minWindow;
  console.log(`\nDeal list window: ${new Date(fromTs).toISOString()} → ${new Date(toTs).toISOString()}`);
  console.log(`  (fromTs=${fromTs}, toTs=${toTs} - milliseconds)`);
  if (raw) console.log('  --raw: will dump full deal JSON');
  console.log('');

  const client = new CTraderClient({
    clientId,
    clientSecret,
    accessToken,
    accountId,
    environment
  } as CTraderClientConfig);
  await client.connect();
  await client.authenticate();

  // Build set of position IDs to analyze (from orders or from deal IDs)
  const positionIdsToCheck = new Map<string, { orderId?: string; deal?: any }>();

  if (orderIds.length > 0) {
    console.log('--- getOrderDetails (by order ID) ---');
    for (const orderId of orderIds) {
      const details = await client.getOrderDetails(orderId);
      if (details) {
        const posId = details.deals[0]?.positionId;
        console.log(`✓ Order ${orderId}: positionId=${posId ?? '(none)'}, deals=${details.deals.length}`);
      } else {
        console.log(`✗ Order ${orderId}: not found`);
      }
    }
  }

  console.log('\n--- getDealList ---');
  const deals = await client.getDealList(fromTs, toTs, 5000);
  console.log(`Total deals in window: ${deals.length}\n`);

  if (dealIdsArg) {
    const targetIds = new Set(dealIdsArg.split(',').map((s) => s.trim().replace(/^DID/i, '')));
    for (const d of deals) {
      const id = String(toNum(d.dealId ?? d.deal_id) ?? d.dealId ?? d.deal_id ?? '');
      if (targetIds.has(id)) {
        const posId = d.positionId ?? d.position_id;
        const posIdStr = posId != null ? String(toNum(posId) ?? posId) : '';
        if (posIdStr) positionIdsToCheck.set(posIdStr, { deal: d });
        console.log(`✓ Deal DID${id} FOUND: positionId=${posIdStr}, orderId=${toNum(d.orderId ?? d.order_id)}`);
      }
    }
    const foundIds = Array.from(positionIdsToCheck.keys());
    const missing = [...targetIds].filter((id) => !deals.some((d: any) => String(toNum(d.dealId ?? d.deal_id)) === id));
    if (missing.length > 0) console.log(`✗ Deals NOT in window: ${missing.join(', ')}`);
    console.log(`  Positions to analyze: ${foundIds.length ? foundIds.join(', ') : '(none)'}\n`);
  } else {
    for (const orderId of orderIds) {
      const deal = deals.find((d: any) => String(d.orderId) === orderId);
      if (deal) {
        const posId = deal.positionId ?? deal.position_id;
        const posIdStr = posId != null ? String(posId) : '';
        if (posIdStr) positionIdsToCheck.set(posIdStr, { orderId, deal });
        console.log(`✓ Order ${orderId} FOUND in deal list`);
        console.log(`  positionId: ${posIdStr}`);
        console.log(`  volume: ${toNum(deal.volume)}, executionTimestamp: ${toNum(deal.executionTimestamp)}`);
        console.log(`  closePositionDetail: ${deal.closePositionDetail ?? deal.close_position_detail ? 'present' : 'absent'}`);
      } else {
        console.log(`✗ Order ${orderId} NOT FOUND in deal list`);
      }
    }
  }

  for (const [positionId] of positionIdsToCheck) {
    if (!positionId) continue;
    console.log(`\n--- getDealListByPositionId(${positionId}) ---`);
    const posDeals = await client.getDealListByPositionId(positionId, fromTs, toTs);
    console.log(`Deals for position ${positionId}: ${posDeals.length}`);

    const closing = posDeals.filter((d: any) => (d.closePositionDetail ?? d.close_position_detail) != null);
    const opening = posDeals.filter((d: any) => {
      if ((d.closePositionDetail ?? d.close_position_detail) != null) return false;
      const status = d.dealStatus ?? d.deal_status;
      return status === 2 || status === 'FILLED';
    });

    console.log(`  Opening deals: ${opening.length}, Closing deals: ${closing.length}`);

    if (raw) {
      console.log('  [--raw] Full deal JSON:');
      for (const d of posDeals) {
        const sanitized = JSON.stringify(
          {
            dealId: toNum(d.dealId ?? d.deal_id),
            orderId: toNum(d.orderId ?? d.order_id),
            volume: toNum(d.volume),
            filledVolume: toNum(d.filledVolume ?? d.filled_volume),
            dealStatus: d.dealStatus ?? d.deal_status,
            executionTimestamp: toNum(d.executionTimestamp ?? d.execution_timestamp),
            closePositionDetail: d.closePositionDetail ?? d.close_position_detail
              ? {
                  closedVolume: toNum((d.closePositionDetail ?? d.close_position_detail)?.closedVolume ?? (d.closePositionDetail ?? d.close_position_detail)?.closed_volume),
                  grossProfit: toNum((d.closePositionDetail ?? d.close_position_detail)?.grossProfit ?? (d.closePositionDetail ?? d.close_position_detail)?.gross_profit),
                  moneyDigits: (d.closePositionDetail ?? d.close_position_detail)?.moneyDigits ?? (d.closePositionDetail ?? d.close_position_detail)?.money_digits
                }
              : null
          },
          null,
          2
        );
        console.log(sanitized);
      }
    }

    let openingVol = 0;
    let closingVol = 0;
    for (const d of opening) {
      const v = d.filledVolume ?? d.filled_volume ?? d.volume ?? 0;
      openingVol += Number(toNum(v)) || 0;
    }
    for (const d of closing) {
      const detail = d.closePositionDetail ?? d.close_position_detail;
      const v =
        detail?.closedVolume ?? detail?.closed_volume ?? d.filledVolume ?? d.filled_volume ?? d.volume ?? 0;
      closingVol += Number(toNum(v)) || 0;
      const used =
        detail?.closedVolume != null || detail?.closed_volume != null
          ? 'closedVolume'
          : d.volume != null
            ? 'd.volume'
            : 'd.filledVolume';
      console.log(`    Closing deal DID${toNum(d.dealId ?? d.deal_id)}: volume=${toNum(d.volume)}, filledVolume=${toNum(d.filledVolume ?? d.filled_volume)}, closedVolume=${toNum(detail?.closedVolume ?? detail?.closed_volume)} (using ${used})`);
    }
    console.log(`  Opening volume: ${openingVol}, Closing volume: ${closingVol}`);

    if (closing.length > 0) {
      const d = closing[0];
      const detail = d.closePositionDetail ?? d.close_position_detail;
      console.log(`  First closing deal - grossProfit: ${toNum(detail?.grossProfit ?? detail?.gross_profit)}, moneyDigits: ${detail?.moneyDigits ?? detail?.money_digits}`);
    }

    const closed = closing.length > 0 && openingVol > 0 && closingVol >= openingVol - Math.max(1, Math.floor(openingVol * 0.001));
    console.log(`  → Would our logic mark as closed: ${closed ? 'YES' : 'NO'}`);
  }

  await client.disconnect();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
