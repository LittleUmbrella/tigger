#!/usr/bin/env tsx
/**
 * Update take profits for all trades tied to a message and channel.
 *
 * Parses the current message content (or accepts explicit --tps), updates the DB,
 * and syncs exchange TP orders for active Bybit/cTrader positions.
 *
 * Usage:
 *   tsx src/scripts/update_message_tps.ts --message-id <id> --channel <channel>
 *   tsx src/scripts/update_message_tps.ts --message-id <id> --channel <channel> --tps 1.1,1.2,1.3
 *   tsx src/scripts/update_message_tps.ts --message-id <id> --channel <channel> --dry-run
 *   tsx src/scripts/update_message_tps.ts --message-id <id> --channel <channel> --db-only
 *   tsx src/scripts/update_message_tps.ts --message-id <id> --channel <channel> --accounts demo,main
 */

import '../scripts/dotenv-preload.js';
import { Command } from 'commander';
import fs from 'fs-extra';
import { RestClientV5 } from 'bybit-api';
import { DatabaseManager, Message, Trade } from '../db/schema.js';
import { BotConfig, AccountConfig } from '../types/config.js';
import { ParsedOrder } from '../types/order.js';
import { parseMessage } from '../parsers/signalParser.js';
import { applyTradeObfuscation } from '../utils/tradeObfuscation.js';
import { getManager, ManagerContext } from '../managers/managerRegistry.js';
import '../managers/index.js';
import { logger } from '../utils/logger.js';
import { serializeErrorForLog } from '../utils/errorUtils.js';
import { getBybitField } from '../utils/bybitFieldHelper.js';
import { normalizeBybitSymbol } from '../utils/normalizeBybitSymbol.js';
import { withBybitRateLimitRetry } from '../utils/bybitRateLimitRetry.js';
import { getSymbolInfo } from '../initiators/symbolValidator.js';
import {
  distributeQuantityAcrossTPs,
  roundPrice,
  validateAndRedistributeTPQuantities,
} from '../utils/positionSizing.js';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { resolveCtraderAccountCredentials } from '../utils/ctraderAccountCredentials.js';
import { normalizeCTraderSymbol } from '../utils/ctraderSymbolUtils.js';

const UPDATABLE_STATUSES = new Set<Trade['status']>(['pending', 'active', 'filled']);

const takeProfitsEqual = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((tp, i) => Math.abs(tp - b[i]) < 0.0001);

const normalizeTradeAccount = (accountName: string | null | undefined): string =>
  accountName?.trim() || 'default';

const parseAccountFilter = (raw: string | undefined): Set<string> | null => {
  if (!raw) return null;
  const names = raw.split(',').map(s => s.trim()).filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
};

const tradeMatchesAccountFilter = (trade: Trade, filter: Set<string> | null): boolean => {
  if (!filter) return true;
  return filter.has(normalizeTradeAccount(trade.account_name));
};

const parseTakeProfitsJson = (raw: string): number[] => {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const formatQuantity = (quantity: number, precision: number): string =>
  quantity.toFixed(precision).replace(/\.?0+$/, '');

const initDatabase = async (config: BotConfig): Promise<DatabaseManager> => {
  const rawDbType = (config.database?.type || 'sqlite').toLowerCase();
  const dbType =
    rawDbType === 'postgres' || rawDbType === 'postgresql' ? 'postgresql' : 'sqlite';
  const dbPath =
    dbType === 'sqlite'
      ? config.database?.path || 'data/trading_bot.db'
      : config.database?.url || process.env.DATABASE_URL || '';
  if (dbType === 'postgresql' && !dbPath) {
    throw new Error(
      'PostgreSQL database selected but no URL provided. Set config.database.url or DATABASE_URL.'
    );
  }
  const db = new DatabaseManager({
    type: dbType,
    path: dbType === 'sqlite' ? dbPath : undefined,
    url: dbType === 'postgresql' ? dbPath : undefined,
  });
  await db.initialize();
  return db;
};

const createBybitClient = (account: AccountConfig | undefined): RestClientV5 | undefined => {
  const envVarNameForKey = account?.envVarNames?.apiKey || account?.envVars?.apiKey;
  const envVarNameForSecret = account?.envVarNames?.apiSecret || account?.envVars?.apiSecret;
  const apiKey = envVarNameForKey
    ? process.env[envVarNameForKey]
    : account?.apiKey || process.env.BYBIT_API_KEY;
  const apiSecret = envVarNameForSecret
    ? process.env[envVarNameForSecret]
    : account?.apiSecret || process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) return undefined;

  const demo = account?.demo || false;
  const testnet = account?.testnet || false;
  const baseUrl = demo ? 'https://api-demo.bybit.com' : undefined;

  return new RestClientV5({
    key: apiKey,
    secret: apiSecret,
    testnet: testnet && !demo,
    ...(baseUrl && { baseUrl }),
  });
};

const createCtraderClient = async (
  account: AccountConfig | undefined,
  config: BotConfig
): Promise<CTraderClient | undefined> => {
  const creds = resolveCtraderAccountCredentials(account ?? null);
  if (!creds.accessToken || !creds.accountId) return undefined;

  const ctraderMonitors = config.monitors?.filter(m => m.type === 'ctrader') ?? [];
  const ctraderSymbolMap = Object.assign(
    {},
    ...ctraderMonitors.map(m => (m as { ctraderSymbolMap?: Record<string, string> }).ctraderSymbolMap ?? {})
  );

  const clientConfig: CTraderClientConfig = {
    clientId: creds.clientId || '',
    clientSecret: creds.clientSecret || '',
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    accountId: creds.accountId,
    environment: creds.environment,
    ...(Object.keys(ctraderSymbolMap).length > 0 && { symbolMap: ctraderSymbolMap }),
  };

  const client = new CTraderClient(clientConfig);
  await client.connect();
  await client.authenticate();
  return client;
};

const resolveTakeProfits = (
  message: Message,
  channelConfig: BotConfig['channels'][number],
  parserConfig: { entryPriceStrategy?: 'worst' | 'average' } | undefined,
  explicitTps: number[] | undefined
): number[] => {
  if (explicitTps && explicitTps.length > 0) return explicitTps;

  const parserOptions = parserConfig?.entryPriceStrategy
    ? { entryPriceStrategy: parserConfig.entryPriceStrategy }
    : undefined;
  let parsed = parseMessage(message.content, channelConfig.parser, parserOptions);
  if (parsed && channelConfig.tradeObfuscation) {
    parsed = applyTradeObfuscation(parsed, channelConfig.tradeObfuscation);
  }
  if (!parsed?.takeProfits?.length) {
    throw new Error(
      `Could not parse take profits from message. Provide --tps or fix message content/parser (${channelConfig.parser}).`
    );
  }
  return parsed.takeProfits;
};

const isCtraderNTradeGroup = (trades: Trade[]): boolean =>
  trades.length > 1 &&
  trades.every(t => {
    const tps = parseTakeProfitsJson(t.take_profits);
    return tps.length === 1;
  });

const cancelPendingBybitTpOrders = async (
  trade: Trade,
  db: DatabaseManager,
  bybitClient: RestClientV5
): Promise<void> => {
  const symbol = normalizeBybitSymbol(trade.trading_pair);
  const orders = await db.getOrdersByTradeId(trade.id);
  const pendingTpOrders = orders.filter(
    o => o.order_type === 'take_profit' && o.status === 'pending' && o.order_id
  );

  for (const order of pendingTpOrders) {
    try {
      await withBybitRateLimitRetry(() =>
        bybitClient.cancelOrder({
          category: 'linear',
          symbol,
          orderId: order.order_id!,
        })
      );
      await db.updateOrder(order.id, { status: 'cancelled' });
      console.log(`    Cancelled Bybit TP order ${order.order_id} (tp_index=${order.tp_index})`);
    } catch (error) {
      console.warn(
        `    Failed to cancel Bybit TP order ${order.order_id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
};

const syncBybitTakeProfits = async (
  trade: Trade,
  takeProfits: number[],
  db: DatabaseManager,
  bybitClient: RestClientV5
): Promise<void> => {
  if (!trade.entry_filled_at) {
    console.log('    Entry not filled — DB updated only');
    return;
  }

  await cancelPendingBybitTpOrders(trade, db, bybitClient);

  const symbol = normalizeBybitSymbol(trade.trading_pair);
  const positionResponse = await withBybitRateLimitRetry(() =>
    bybitClient.getPositionInfo({ category: 'linear', symbol })
  );
  const position = positionResponse.result?.list?.find((p: { size?: string }) => {
    const size = parseFloat(p.size || '0');
    return Math.abs(size) > 0;
  });

  if (!position) {
    console.log('    No open Bybit position — DB updated only');
    return;
  }

  const positionSize = Math.abs(parseFloat(getBybitField<string>(position, 'size') || '0'));
  const positionSizeStr = getBybitField<string>(position, 'size') || '0';
  let positionSide: 'Buy' | 'Sell';
  if (position.side === 'Buy' || position.side === 'Sell') {
    positionSide = position.side;
  } else {
    positionSide = parseFloat(positionSizeStr) > 0 ? 'Buy' : 'Sell';
  }
  const tpSide = positionSide === 'Buy' ? 'Sell' : 'Buy';

  let positionIdx: 0 | 1 | 2 = 0;
  if (trade.position_id) {
    const storedIdx = parseInt(trade.position_id, 10);
    if (!isNaN(storedIdx) && storedIdx >= 0 && storedIdx <= 2) {
      positionIdx = storedIdx as 0 | 1 | 2;
    }
  } else {
    const idxRaw = getBybitField<string | number>(position, 'positionIdx', 'position_idx');
    const idx = typeof idxRaw === 'string' ? parseInt(idxRaw, 10) : idxRaw;
    if (typeof idx === 'number' && !isNaN(idx) && idx >= 0 && idx <= 2) {
      positionIdx = idx as 0 | 1 | 2;
    }
  }

  const symbolInfo = await getSymbolInfo(bybitClient, symbol);
  const decimalPrecision = symbolInfo?.qtyPrecision ?? 2;
  const pricePrecision = symbolInfo?.pricePrecision;
  const qtyStep = symbolInfo?.qtyStep;
  const minOrderQty = symbolInfo?.minOrderQty;
  const maxOrderQty = symbolInfo?.maxOrderQty;

  const roundedTPPrices = takeProfits.map(tp => roundPrice(tp, pricePrecision, undefined));
  const tpQuantities = distributeQuantityAcrossTPs(positionSize, takeProfits.length, decimalPrecision);
  const validTPOrders = validateAndRedistributeTPQuantities(
    tpQuantities,
    roundedTPPrices,
    positionSize,
    qtyStep,
    minOrderQty,
    maxOrderQty,
    decimalPrecision
  );

  const bestTpPrice = roundedTPPrices[roundedTPPrices.length - 1];
  try {
    const tradingStopParams: {
      category: 'linear';
      symbol: string;
      positionIdx: 0 | 1 | 2;
      tpslMode: 'Full';
      stopLoss?: string;
      takeProfit?: string;
    } = {
      category: 'linear',
      symbol,
      positionIdx,
      tpslMode: 'Full',
    };
    if (trade.stop_loss != null) {
      tradingStopParams.stopLoss = trade.stop_loss.toString();
    }
    if (bestTpPrice > 0) {
      tradingStopParams.takeProfit = bestTpPrice.toString();
    }
    await withBybitRateLimitRetry(() => bybitClient.setTradingStop(tradingStopParams));
    console.log(`    Set position best TP to ${bestTpPrice}`);
  } catch (error) {
    console.warn(`    Failed to set position best TP: ${serializeErrorForLog(error).error}`);
  }

  for (const tpOrder of validTPOrders) {
    if (tpOrder.index === takeProfits.length) continue;

    try {
      const response = await withBybitRateLimitRetry(() =>
        bybitClient.submitOrder({
          category: 'linear',
          symbol,
          side: tpSide as 'Buy' | 'Sell',
          orderType: 'Limit',
          qty: formatQuantity(tpOrder.quantity, decimalPrecision),
          price: tpOrder.price.toString(),
          timeInForce: 'GTC',
          reduceOnly: true,
          closeOnTrigger: false,
          positionIdx,
        })
      );
      const orderId = getBybitField<string>(response.result, 'orderId', 'order_id');
      if (response.retCode === 0 && orderId) {
        await db.insertOrder({
          trade_id: trade.id,
          order_type: 'take_profit',
          order_id: orderId,
          price: tpOrder.price,
          tp_index: tpOrder.index,
          quantity: tpOrder.quantity,
          status: 'pending',
        });
        console.log(`    Placed Bybit TP #${tpOrder.index} @ ${tpOrder.price} (orderId=${orderId})`);
      } else {
        console.warn(`    Failed to place Bybit TP #${tpOrder.index}: ${JSON.stringify(response)}`);
      }
    } catch (error) {
      console.warn(`    Error placing Bybit TP #${tpOrder.index}: ${serializeErrorForLog(error).error}`);
    }
  }
};

const cancelPendingCtraderTpOrders = async (
  trade: Trade,
  db: DatabaseManager,
  ctraderClient: CTraderClient
): Promise<void> => {
  const orders = await db.getOrdersByTradeId(trade.id);
  const pendingTpOrders = orders.filter(
    o => o.order_type === 'take_profit' && o.status === 'pending' && o.order_id
  );

  for (const order of pendingTpOrders) {
    try {
      await ctraderClient.cancelOrder(order.order_id!);
      await db.updateOrder(order.id, { status: 'cancelled' });
      console.log(`    Cancelled cTrader TP order ${order.order_id} (tp_index=${order.tp_index})`);
    } catch (error) {
      console.warn(
        `    Failed to cancel cTrader TP order ${order.order_id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
};

const syncCtraderLegTakeProfit = async (
  trade: Trade,
  tpPrice: number,
  db: DatabaseManager,
  ctraderClient: CTraderClient
): Promise<void> => {
  if (!trade.entry_filled_at || !trade.position_id) {
    console.log('    Entry not filled / no position_id — DB updated only');
    return;
  }

  await cancelPendingCtraderTpOrders(trade, db, ctraderClient);

  const symbol = normalizeCTraderSymbol(trade.trading_pair);
  const openPositions = await ctraderClient.getOpenPositions();
  const position = openPositions.find(
    (p: { positionId?: string | number; id?: string | number }) =>
      String(p.positionId ?? p.id) === String(trade.position_id)
  );
  if (!position) {
    console.log('    No open cTrader position — DB updated only');
    return;
  }

  const positionSide = (position.tradeSide || position.side || trade.direction || 'BUY').toString().toUpperCase();
  const tpSide = positionSide === 'BUY' || positionSide === 'LONG' ? 'SELL' : 'BUY';
  const volumeLots = trade.quantity ?? 0;

  try {
    const tpOrderId = await ctraderClient.placeLimitOrder({
      symbol,
      volume: volumeLots,
      tradeSide: tpSide as 'BUY' | 'SELL',
      price: tpPrice,
      positionId: String(trade.position_id),
    });

    await db.insertOrder({
      trade_id: trade.id,
      order_type: 'take_profit',
      order_id: tpOrderId,
      price: tpPrice,
      quantity: volumeLots,
      tp_index: 1,
      status: 'pending',
    });
    console.log(`    Placed cTrader TP @ ${tpPrice} (orderId=${tpOrderId})`);
  } catch (error) {
    console.warn(`    Failed to place cTrader TP: ${serializeErrorForLog(error).error}`);
  }
};

const syncCtraderMultiTpTakeProfits = async (
  trade: Trade,
  takeProfits: number[],
  db: DatabaseManager,
  ctraderClient: CTraderClient
): Promise<void> => {
  if (!trade.entry_filled_at || !trade.position_id) {
    console.log('    Entry not filled / no position_id — DB updated only');
    return;
  }

  await cancelPendingCtraderTpOrders(trade, db, ctraderClient);

  const symbol = normalizeCTraderSymbol(trade.trading_pair);
  const openPositions = await ctraderClient.getOpenPositions();
  const position = openPositions.find(
    (p: { positionId?: string | number; id?: string | number }) =>
      String(p.positionId ?? p.id) === String(trade.position_id)
  );
  if (!position) {
    console.log('    No open cTrader position — DB updated only');
    return;
  }

  const positionSide = (position.tradeSide || position.side || trade.direction || 'BUY').toString().toUpperCase();
  const tpSide = positionSide === 'BUY' || positionSide === 'LONG' ? 'SELL' : 'BUY';
  const positionSize = Math.abs(trade.quantity ?? 0);
  const tpQuantities = distributeQuantityAcrossTPs(positionSize, takeProfits.length, 2);

  for (let i = 0; i < takeProfits.length; i++) {
    const tpPrice = takeProfits[i];
    const tpQty = tpQuantities[i];
    if (tpQty <= 0) continue;

    try {
      const tpOrderId = await ctraderClient.placeLimitOrder({
        symbol,
        volume: tpQty,
        tradeSide: tpSide as 'BUY' | 'SELL',
        price: tpPrice,
        positionId: String(trade.position_id),
      });

      await db.insertOrder({
        trade_id: trade.id,
        order_type: 'take_profit',
        order_id: tpOrderId,
        price: tpPrice,
        quantity: tpQty,
        tp_index: i + 1,
        status: 'pending',
      });
      console.log(`    Placed cTrader TP #${i + 1} @ ${tpPrice} (orderId=${tpOrderId})`);
    } catch (error) {
      console.warn(`    Failed to place cTrader TP #${i + 1}: ${serializeErrorForLog(error).error}`);
    }
  }
};

const updateTradeTakeProfitsDb = async (
  trade: Trade,
  takeProfits: number[],
  message: Message,
  channel: string,
  db: DatabaseManager
): Promise<void> => {
  const manager = getManager('update_take_profits');
  if (!manager) throw new Error('update_take_profits manager not registered');

  const newOrder: ParsedOrder = {
    tradingPair: trade.trading_pair,
    leverage: trade.leverage,
    entryPrice: trade.entry_price,
    stopLoss: trade.stop_loss,
    takeProfits,
    signalType: (trade.direction as 'long' | 'short') || 'long',
  };

  await manager({
    channel,
    message,
    command: { type: 'update_take_profits', newOrder, trade },
    db,
    isSimulation: false,
  } as ManagerContext);
};

const program = new Command();

program
  .name('update-message-tps')
  .description('Update take profits for all trades on a message and channel')
  .requiredOption('--message-id <id>', 'Source message ID (Telegram/Discord ID)')
  .requiredOption('--channel <channel>', 'Channel the message belongs to')
  .option('--tps <prices>', 'Comma-separated TP prices (overrides message parsing)')
  .option('--accounts <names>', 'Comma-separated account names to update (default: all)')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--force', 'Update even when TPs appear unchanged')
  .option('--db-only', 'Update database only; skip exchange order sync')
  .option('--dry-run', 'Show what would change without applying updates')
  .action(async options => {
    try {
      const configPath = options.config || 'config.json';
      if (!fs.existsSync(configPath)) {
        console.error(`Config file not found: ${configPath}`);
        process.exit(1);
      }

      const config: BotConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      const db = await initDatabase(config);

      const messageId = String(options.messageId);
      const channel = String(options.channel);
      const force = !!options.force;
      const dryRun = !!options.dryRun;
      const dbOnly = !!options.dbOnly;
      const accountFilter = parseAccountFilter(options.accounts);

      const message = await db.getMessageByMessageId(messageId, channel);
      if (!message) {
        console.error(`Message not found: message_id=${messageId}, channel=${channel}`);
        await db.close();
        process.exit(1);
      }

      const channelConfig = config.channels.find(c => c.channel === channel);
      if (!channelConfig) {
        console.error(`Channel ${channel} not found in config`);
        await db.close();
        process.exit(1);
      }

      const parserConfig = config.parsers?.find(p => p.name === channelConfig.parser);
      const explicitTps = options.tps
        ? String(options.tps)
            .split(',')
            .map((s: string) => parseFloat(s.trim()))
            .filter((n: number) => isFinite(n) && n > 0)
        : undefined;

      const newTakeProfits = resolveTakeProfits(message, channelConfig, parserConfig, explicitTps);

      console.log('\n--- Message ---');
      console.log(`  Message ID: ${message.message_id}`);
      console.log(`  Channel:    ${message.channel}`);
      console.log(`  Parser:     ${channelConfig.parser}`);
      console.log(`  New TPs:    [${newTakeProfits.join(', ')}]`);
      console.log(
        `  Accounts:   ${accountFilter ? [...accountFilter].join(', ') : 'all'}`
      );

      const allTrades = await db.getTradesByMessageId(messageId, channel);
      const updatableTrades = allTrades.filter(t => UPDATABLE_STATUSES.has(t.status));
      const trades = accountFilter
        ? updatableTrades.filter(t => tradeMatchesAccountFilter(t, accountFilter))
        : updatableTrades;

      if (accountFilter && trades.length === 0) {
        const availableAccounts = [
          ...new Set(updatableTrades.map(t => normalizeTradeAccount(t.account_name))),
        ];
        console.log(
          `\nNo updatable trades for account filter [${[...accountFilter].join(', ')}].` +
            (availableAccounts.length > 0
              ? ` Available accounts: ${availableAccounts.join(', ')}`
              : ' No updatable trades on this message.')
        );
        await db.close();
        process.exit(0);
      }

      if (trades.length === 0) {
        console.log('\nNo updatable trades (pending/active/filled) for this message.');
        await db.close();
        process.exit(0);
      }

      if (accountFilter && updatableTrades.length > trades.length) {
        console.log(
          `\n  (${updatableTrades.length - trades.length} trade(s) on other accounts skipped)`
        );
      }

      console.log(`\n--- Trades to update (${trades.length}) ---`);
      for (const trade of trades) {
        const oldTps = parseTakeProfitsJson(trade.take_profits);
        const changed = !takeProfitsEqual(oldTps, newTakeProfits);
        console.log(
          `  Trade #${trade.id}: ${trade.trading_pair} ${trade.direction || '?'} | status=${trade.status} | exchange=${trade.exchange} | account=${normalizeTradeAccount(trade.account_name)} | old TPs=[${oldTps.join(', ')}] | ${changed ? 'WILL UPDATE' : 'unchanged'}`
        );
      }

      const ctraderGroups = new Map<string, Trade[]>();
      for (const trade of trades.filter(t => t.exchange === 'ctrader')) {
        const key = normalizeTradeAccount(trade.account_name);
        const group = ctraderGroups.get(key) ?? [];
        group.push(trade);
        ctraderGroups.set(key, group);
      }

      const nTradeAccounts = new Set<string>();
      for (const [account, group] of ctraderGroups) {
        if (isCtraderNTradeGroup(group)) nTradeAccounts.add(account);
      }

      if (dryRun) {
        console.log('\n[dry-run] No changes applied.');
        await db.close();
        process.exit(0);
      }

      const accountMap = new Map(config.accounts?.map(a => [a.name, a]) ?? []);
      const bybitClients = new Map<string, RestClientV5>();
      const ctraderClients = new Map<string, CTraderClient>();

      const getBybit = (accountName?: string): RestClientV5 | undefined => {
        const key = accountName || 'default';
        if (bybitClients.has(key)) return bybitClients.get(key);
        const account = accountName ? accountMap.get(accountName) : config.accounts?.[0];
        const client = createBybitClient(account);
        if (client) bybitClients.set(key, client);
        return client;
      };

      const getCtrader = async (accountName?: string): Promise<CTraderClient | undefined> => {
        const key = accountName || 'default';
        if (ctraderClients.has(key)) return ctraderClients.get(key);
        const account = accountName ? accountMap.get(accountName) : config.accounts?.find(a => a.exchange === 'ctrader');
        const client = await createCtraderClient(account, config);
        if (client) ctraderClients.set(key, client);
        return client;
      };

      console.log('\n--- Applying updates ---');

      for (const trade of trades) {
        const oldTps = parseTakeProfitsJson(trade.take_profits);
        const accountKey = normalizeTradeAccount(trade.account_name);

        if (trade.exchange === 'ctrader' && nTradeAccounts.has(accountKey)) {
          const group = ctraderGroups.get(accountKey) ?? [];
          const legIndex = group.findIndex(t => t.id === trade.id);
          const legTp = newTakeProfits[legIndex];
          if (legTp == null) {
            console.log(`\nTrade #${trade.id}: skipped — no TP at leg index ${legIndex + 1}`);
            continue;
          }
          const legTps = [legTp];
          if (!force && takeProfitsEqual(oldTps, legTps)) {
            console.log(`\nTrade #${trade.id}: TPs unchanged, skipping`);
            continue;
          }

          console.log(`\nTrade #${trade.id} (cTrader N-trade leg ${legIndex + 1}): [${oldTps.join(', ')}] → [${legTp}]`);
          await db.updateTrade(trade.id, { take_profits: JSON.stringify(legTps) });

          if (!dbOnly) {
            const ctraderClient = await getCtrader(trade.account_name);
            if (ctraderClient) {
              await syncCtraderLegTakeProfit(trade, legTp, db, ctraderClient);
            } else {
              console.log('    No cTrader client — DB updated only');
            }
          }
          continue;
        }

        if (!force && takeProfitsEqual(oldTps, newTakeProfits)) {
          console.log(`\nTrade #${trade.id}: TPs unchanged, skipping`);
          continue;
        }

        console.log(`\nTrade #${trade.id}: [${oldTps.join(', ')}] → [${newTakeProfits.join(', ')}]`);
        await updateTradeTakeProfitsDb(trade, newTakeProfits, message, channel, db);

        if (dbOnly) continue;

        if (trade.exchange === 'bybit') {
          const bybitClient = getBybit(trade.account_name);
          if (bybitClient) {
            const refreshed = (await db.getTradesByMessageId(messageId, channel)).find(t => t.id === trade.id);
            if (refreshed) await syncBybitTakeProfits(refreshed, newTakeProfits, db, bybitClient);
          } else {
            console.log('    No Bybit client — DB updated only');
          }
        } else if (trade.exchange === 'ctrader') {
          const ctraderClient = await getCtrader(trade.account_name);
          if (ctraderClient) {
            const refreshed = (await db.getTradesByMessageId(messageId, channel)).find(t => t.id === trade.id);
            if (refreshed) await syncCtraderMultiTpTakeProfits(refreshed, newTakeProfits, db, ctraderClient);
          } else {
            console.log('    No cTrader client — DB updated only');
          }
        }
      }

      console.log('\nDone.');
      await db.close();
      process.exit(0);
    } catch (error) {
      console.error('Update failed:', error instanceof Error ? error.message : String(error));
      if (error instanceof Error && error.stack) console.error(error.stack);
      logger.error('update_message_tps failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      process.exit(1);
    }
  });

program.parse(process.argv);
