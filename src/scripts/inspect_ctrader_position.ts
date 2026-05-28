#!/usr/bin/env tsx
/**
 * Inspect a cTrader position: deals, entry order label (exchange truth), open SL/TP, DB legs.
 *
 * Usage:
 *   npx tsx src/scripts/inspect_ctrader_position.ts 3864237
 *   npx tsx src/scripts/inspect_ctrader_position.ts PID3864237 --account ctrader_demo_2_25
 *   npx tsx src/scripts/inspect_ctrader_position.ts 3864237 --account ctrader_demo_2_25 --message 15145 --channel 2845421508
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CTraderClient } from '../clients/ctraderClient.js';
import { DatabaseManager } from '../db/schema.js';
import {
  buildCtraderOpenPositionsSnapshot,
  parseCtraderPositionStopLoss,
} from '../monitors/ctraderBreakeven.js';
import type { AccountConfig, BotConfig } from '../types/config.js';
import {
  buildCtraderOrderLabel,
  parseCtraderOrderLabel,
  readLabelFromCtraderOrder,
  resolveCtraderPositionEntryLabel,
  tradeMatchesCtraderOrderLabel,
} from '../utils/ctraderOrderLabel.js';
import { resolveCtraderAccountCredentials } from '../utils/ctraderAccountCredentials.js';
import { protobufLongToNumber } from '../utils/protobufLong.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const envInv = path.join(projectRoot, '.env-investigation');
dotenv.config({ path: fs.existsSync(envInv) ? envInv : path.join(projectRoot, '.env') });

const toNum = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'object' && v !== null && 'low' in v) {
    const n = protobufLongToNumber(v as { low: number });
    return n != null && isFinite(n) ? n : null;
  }
  const n = Number(v);
  return isFinite(n) ? n : null;
};

const normalizePositionId = (raw: string): string => {
  const s = raw.trim().toUpperCase();
  if (s.startsWith('PID')) return s.slice(3);
  return s;
};

const parseArgs = (
  argv: string[]
): {
  positionId?: string;
  accountName?: string;
  configPath: string;
  messageId?: string;
  channelId?: string;
} => {
  let positionId: string | undefined;
  let accountName: string | undefined;
  let configPath = path.join(projectRoot, 'config.json');
  let messageId: string | undefined;
  let channelId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account' && argv[i + 1]) {
      accountName = argv[++i];
    } else if (a === '--config' && argv[i + 1]) {
      configPath = path.resolve(projectRoot, argv[++i]);
    } else if (a === '--message' && argv[i + 1]) {
      messageId = argv[++i];
    } else if (a === '--channel' && argv[i + 1]) {
      channelId = argv[++i];
    } else if (!a.startsWith('-')) {
      positionId = normalizePositionId(a);
    }
  }

  return { positionId, accountName, configPath, messageId, channelId };
};

const main = async () => {
  const { positionId, accountName, configPath, messageId, channelId } = parseArgs(process.argv.slice(2));
  if (!positionId) {
    console.error(
      'Usage: npx tsx src/scripts/inspect_ctrader_position.ts <positionId|PIDpositionId> [--account <name>] [--message <id>] [--channel <id>] [--config <path>]'
    );
    process.exit(1);
  }

  const config: BotConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const account: AccountConfig | null =
    accountName != null
      ? (config.accounts || []).find((a) => a.name === accountName) ?? null
      : (config.accounts || []).find((a) => a.exchange === 'ctrader') ?? null;

  if (accountName && !account) {
    console.error(`Account not found in config: ${accountName}`);
    process.exit(1);
  }

  const creds = resolveCtraderAccountCredentials(account);
  if (!creds.clientId || !creds.accountId) {
    console.error('Missing cTrader credentials (set account env vars or CTRADER_* in .env)');
    process.exit(1);
  }

  const client = new CTraderClient({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret!,
    accessToken: creds.accessToken!,
    refreshToken: creds.refreshToken,
    accountId: creds.accountId,
    environment: creds.environment,
  });

  await client.connect();
  await client.authenticate();

  const now = Date.now();
  const from = now - 365 * 24 * 60 * 60 * 1000;

  const deals = await client.getDealListByPositionId(positionId, from, now);
  const opening = deals.find((d: Record<string, unknown>) => {
    const cpd = d.closePositionDetail ?? d.close_position_detail;
    return cpd == null;
  });
  const entryOrderId = opening
    ? String(toNum((opening as Record<string, unknown>).orderId ?? (opening as Record<string, unknown>).order_id) ?? '')
    : '';

  let entryLabel: string | undefined;
  try {
    entryLabel = await resolveCtraderPositionEntryLabel(client, positionId);
  } catch {
    /* optional */
  }
  if (!entryLabel && entryOrderId) {
    const details = await client.getOrderDetails(entryOrderId);
    entryLabel = readLabelFromCtraderOrder(details?.order as Record<string, unknown> | undefined);
  }

  const parsedLabel = parseCtraderOrderLabel(entryLabel);
  const openPositions = await client.getOpenPositions();
  const openSnapshot = buildCtraderOpenPositionsSnapshot(openPositions);
  const openPos = openSnapshot.byPositionId.get(positionId);
  const exchangeSl = openPos ? parseCtraderPositionStopLoss(openPos) : undefined;
  const rawTp = openPos?.takeProfit ?? openPos?.take_profit;
  const exchangeTp =
    rawTp != null
      ? typeof rawTp === 'number'
        ? rawTp
        : parseFloat(String(rawTp))
      : undefined;

  console.log(
    JSON.stringify(
      {
        positionId,
        account: account?.name ?? accountName ?? '(default env)',
        exchangeOpen: !!openPos,
        entryOrderId: entryOrderId || undefined,
        entryLabel,
        parsedLabel: parsedLabel ?? undefined,
        exchangeStopLoss: exchangeSl,
        exchangeTakeProfit: isFinite(exchangeTp!) && exchangeTp! > 0 ? exchangeTp : undefined,
      },
      null,
      2
    )
  );

  const dbChannel = channelId ?? parsedLabel?.channel;
  const dbMessageId = messageId ?? parsedLabel?.messageId;

  if (dbChannel && dbMessageId) {
    const db = new DatabaseManager(config.database);
    await db.initialize();
    const legs = (await db.getTradesByMessageId(dbMessageId, dbChannel)).filter(
      (t) => t.exchange === 'ctrader' && (!account?.name || t.account_name === account.name)
    );
    console.log(`\nDB legs (${dbMessageId} / ${dbChannel}, ${legs.length} on account):\n`);
    for (const t of legs.sort((a, b) => a.id - b.id)) {
      const expectedLabel = buildCtraderOrderLabel(t.channel, String(t.message_id));
      const legOpen = t.position_id ? openSnapshot.byPositionId.get(String(t.position_id)) : undefined;
      const legExSl = legOpen ? parseCtraderPositionStopLoss(legOpen) : undefined;
      console.log(
        JSON.stringify({
          tradeId: t.id,
          status: t.status,
          positionId: t.position_id,
          orderId: t.order_id,
          dbStopLoss: t.stop_loss,
          stopLossBreakeven: t.stop_loss_breakeven,
          expectedLabel,
          labelMatchesMessage: tradeMatchesCtraderOrderLabel(t, entryLabel),
          positionIsInspected: String(t.position_id) === positionId,
          exchangeSlOnLeg: legExSl,
          slMismatch:
            legExSl != null && t.stop_loss > 0 ? Math.abs(legExSl - t.stop_loss) > 0.05 : undefined,
        })
      );
    }
    await db.close();
  } else if (entryLabel) {
    console.log('\n(No parsed label channel/message — pass --channel and --message for DB leg table)\n');
  }

  console.log(`\nDeals (${deals.length}) in last 365d:\n`);
  let sumGross = 0;
  for (const d of deals) {
    const dealId = toNum((d as Record<string, unknown>).dealId ?? (d as Record<string, unknown>).deal_id);
    const orderId = toNum((d as Record<string, unknown>).orderId ?? (d as Record<string, unknown>).order_id);
    const vol = toNum((d as Record<string, unknown>).volume ?? (d as Record<string, unknown>).filledVolume) ?? 0;
    const exec = toNum((d as Record<string, unknown>).executionPrice ?? (d as Record<string, unknown>).execution_price);
    const ts = toNum(
      (d as Record<string, unknown>).executionTimestamp ?? (d as Record<string, unknown>).execution_timestamp
    );
    const cpd =
      (d as Record<string, unknown>).closePositionDetail ??
      (d as Record<string, unknown>).close_position_detail;
    const gross = cpd != null ? toNum((cpd as Record<string, unknown>).grossProfit ?? (cpd as Record<string, unknown>).gross_profit) : null;
    if (gross != null) sumGross += gross;

    console.log(
      JSON.stringify(
        {
          dealId,
          orderId,
          executionTime: ts != null ? new Date(ts).toISOString() : undefined,
          volumeRaw: vol,
          executionPrice: exec,
          grossProfit: gross,
          isClose: cpd != null,
        },
        null,
        2
      )
    );
  }
  console.log(`\nSum of grossProfit on closing deals: ${sumGross.toFixed(2)}`);

  await client.disconnect();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
