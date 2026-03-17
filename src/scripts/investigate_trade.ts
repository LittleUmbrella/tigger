/**
 * Investigate Trade 31 - Position Sizing Calculation
 * 
 * This script queries trade 31 from the database and verifies the position sizing
 * calculation using the config.json settings (riskPercentage: 1%, baseLeverage: 20)
 * 
 * Usage: tsx src/scripts/investigate_trade.ts <trade_id> [account_balance]
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../../config.json';
import { calculatePositionSize } from '../utils/positionSizing.js';
import { parseManagementCommand } from '../managers/managementParser.js';
import { queryCTraderClosingDeals, queryCTraderPositionClosingDeals, queryCTraderPositionSlLevel } from '../investigation/utils/ctraderManagementExecution.js';
import { queryBybitClosingExecutions } from '../investigation/utils/bybitManagementExecution.js';
import { CTraderClient, CTraderClientConfig } from '../clients/ctraderClient.js';
import { RestClientV5 } from 'bybit-api';
import dayjs from 'dayjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Database connection based on config
let db: Database.Database | Pool;
let isPostgres = false;

if (config.database.type === 'postgresql') {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable not set');
  }
  db = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
  isPostgres = true;
} else {
  const dbPath = (config.database as any).path || 'data/tigger.db';
  db = new Database(dbPath);
}

interface Trade {
  id: number;
  message_id: string;
  channel: string;
  trading_pair: string;
  leverage: number;
  entry_price: number;
  stop_loss: number;
  take_profits: string;
  risk_percentage: number;
  quantity: number | null;
  exchange: string;
  account_name: string | null;
  direction: string | null;
  status: string;
  created_at: string;
  entry_filled_at?: string | null;
  exit_filled_at?: string | null;
  position_id?: string | null;
}

interface Message {
  id: number;
  message_id: string;
  channel: string;
  content: string;
  date: string;
  reply_to_message_id?: string | null;
}

async function queryTrade(tradeId: number): Promise<Trade | null> {
  const query = `
    SELECT 
      id,
      message_id,
      channel,
      trading_pair,
      leverage,
      entry_price,
      stop_loss,
      take_profits,
      risk_percentage,
      quantity,
      exchange,
      account_name,
      direction,
      status,
      created_at,
      entry_filled_at,
      exit_filled_at,
      position_id
    FROM trades
    WHERE id = $1
  `;
  
  if (isPostgres) {
    const result = await (db as Pool).query(query, [tradeId]);
    return result.rows[0] || null;
  } else {
    return (db as Database.Database).prepare(query.replace(/\$1/g, '?')).get(tradeId) as Trade | null;
  }
}

async function queryMessage(messageId: string, channel: string): Promise<Message | null> {
  const query = `
    SELECT 
      id,
      message_id,
      channel,
      content,
      date
    FROM messages
    WHERE message_id = $1 AND channel = $2
  `;

  if (isPostgres) {
    const result = await (db as Pool).query(query, [messageId, channel]);
    return result.rows[0] || null;
  } else {
    return (db as Database.Database).prepare(query.replace(/\$1/g, '?').replace(/\$2/g, '?')).get(messageId, channel) as Message | null;
  }
}

async function queryMessagesInWindow(channel: string, startDate: string, endDate: string): Promise<Message[]> {
  const query = `
    SELECT id, message_id, channel, content, date, reply_to_message_id
    FROM messages
    WHERE channel = $1 AND date >= $2 AND date <= $3
    ORDER BY date ASC
  `;

  if (isPostgres) {
    const result = await (db as Pool).query(query, [channel, startDate, endDate]);
    return result.rows || [];
  } else {
    const stmt = (db as Database.Database)
      .prepare(query.replace(/\$1/g, '?').replace(/\$2/g, '?').replace(/\$3/g, '?'));
    return (stmt.all(channel, startDate, endDate) as Message[]) || [];
  }
}

/** Normalize trading pair for comparison (XAUUSD, XAU/USD, BTCUSDT, BTC/USDT -> canonical form) */
function normalizePairForMatch(pair: string): string {
  const s = (pair || '').replace(/\//g, '').toUpperCase();
  if (s === 'XAUUSD') return 'XAUUSD';
  return s.replace(/USDT$/, '') + 'USDT';
}

/** Check if a management command could apply to this trade */
function commandAppliesToTrade(cmd: { type: string; tradingPair?: string }, trade: Trade): boolean {
  if (cmd.type === 'close_all_trades' || cmd.type === 'close_all_longs' || cmd.type === 'close_all_shorts') {
    if (cmd.type === 'close_all_longs' && trade.direction !== 'long') return false;
    if (cmd.type === 'close_all_shorts' && trade.direction !== 'short') return false;
    return true;
  }
  if (cmd.type === 'close_percentage' || cmd.type === 'close_position') {
    if (!cmd.tradingPair) return true; // Unspecified = could apply to any
    return normalizePairForMatch(cmd.tradingPair) === normalizePairForMatch(trade.trading_pair);
  }
  return false;
}

async function getCTraderClientForTrade(accountName?: string | null): Promise<CTraderClient | undefined> {
  const configPath = process.env.CONFIG_PATH || path.join(projectRoot, 'config.json');
  if (!(await fs.pathExists(configPath))) return undefined;
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const account = cfg?.accounts?.find((a: any) =>
    a.exchange === 'ctrader' && (accountName ? a.name === accountName : true)
  ) ?? cfg?.accounts?.find((a: any) => a.exchange === 'ctrader');
  const envKey = account?.envVarNames?.apiKey ?? account?.envVars?.apiKey;
  const envSecret = account?.envVarNames?.apiSecret ?? account?.envVars?.apiSecret;
  const envToken = account?.envVarNames?.accessToken ?? account?.envVars?.accessToken;
  const envAccountId = account?.envVarNames?.accountId ?? account?.envVars?.accountId;
  const clientId = envKey ? process.env[envKey] : process.env.CTRADER_CLIENT_ID;
  const clientSecret = envSecret ? process.env[envSecret] : process.env.CTRADER_CLIENT_SECRET;
  const accessToken = envToken ? process.env[envToken] : process.env.CTRADER_ACCESS_TOKEN;
  const accountId = envAccountId ? process.env[envAccountId] : process.env.CTRADER_ACCOUNT_ID;
  if (!clientId || !clientSecret || !accessToken || !accountId) return undefined;
  const clientConfig: CTraderClientConfig = {
    clientId,
    clientSecret,
    accessToken,
    accountId,
    environment: account?.demo ? 'demo' : 'live'
  };
  const client = new CTraderClient(clientConfig);
  try {
    await client.connect();
    await client.authenticate();
    return client;
  } catch {
    return undefined;
  }
}

async function getBybitClientForTrade(accountName?: string | null): Promise<RestClientV5 | undefined> {
  const configPath = process.env.CONFIG_PATH || path.join(projectRoot, 'config.json');
  if (!(await fs.pathExists(configPath))) return undefined;
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const account = cfg?.accounts?.find((a: any) =>
    (accountName ? a.name === accountName : true) && a.exchange !== 'ctrader'
  ) ?? cfg?.accounts?.find((a: any) => !a.exchange || a.exchange === 'bybit');
  const envKey = account?.envVarNames?.apiKey ?? account?.envVars?.apiKey;
  const envSecret = account?.envVarNames?.apiSecret ?? account?.envVars?.apiSecret;
  const apiKey = envKey ? process.env[envKey] : process.env.BYBIT_API_KEY;
  const apiSecret = envSecret ? process.env[envSecret] : process.env.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) return undefined;
  const demo = account?.demo || false;
  const baseUrl = demo ? 'https://api-demo.bybit.com' : undefined;
  return new RestClientV5({
    key: apiKey,
    secret: apiSecret,
    testnet: account?.testnet || false,
    ...(baseUrl && { baseUrl })
  });
}

function calculateExpectedQuantity(trade: Trade, accountBalance: number, baseLeverage?: number, originalStopLoss?: number) {
  console.log('\n=== Position Sizing Calculation ===');
  console.log(`Trade ID: ${trade.id}`);
  console.log(`Trading Pair: ${trade.trading_pair}`);
  console.log(`Entry Price: ${trade.entry_price}`);
  console.log(`Current Stop Loss: ${trade.stop_loss}`);
  if (originalStopLoss && originalStopLoss !== trade.stop_loss) {
    console.log(`⚠️  Original Stop Loss: ${originalStopLoss} (moved to breakeven)`);
  }
  console.log(`Leverage: ${trade.leverage}`);
  console.log(`Risk Percentage: ${trade.risk_percentage}%`);
  console.log(`Base Leverage: ${baseLeverage || 'N/A'}`);
  console.log(`Account Balance: ${accountBalance}`);
  
  // Use original stop loss if provided, otherwise use current
  const stopLossToUse = originalStopLoss || trade.stop_loss;
  const priceDiff = Math.abs(trade.entry_price - stopLossToUse);
  
  if (priceDiff === 0) {
    console.log('\n⚠️  WARNING: Stop loss equals entry price (breakeven)!');
    console.log('   Cannot calculate position size based on risk percentage.');
    console.log('   The stop loss was likely moved to breakeven after take profits were hit.');
    if (!originalStopLoss) {
      console.log('   Try querying the original message to find the initial stop loss.');
    }
    return null;
  }
  
  // Additional safety check - ensure priceDiff is valid
  if (!isFinite(priceDiff) || priceDiff <= 0) {
    console.log('\n⚠️  ERROR: Invalid price difference calculated!');
    console.log(`   Entry: ${trade.entry_price}, Stop Loss: ${stopLossToUse}, Diff: ${priceDiff}`);
    return null;
  }
  const riskAmount = accountBalance * (trade.risk_percentage / 100);
  
  // Calculate adjusted risk amount (same logic as calculatePositionSize)
  let adjustedRiskPercentage = trade.risk_percentage;
  if (baseLeverage !== undefined && baseLeverage > 0) {
    const effectiveLeverage = trade.leverage > 0 ? trade.leverage : (baseLeverage || 1);
    const leverageRatio = effectiveLeverage / baseLeverage;
    const riskMultiplier = Math.max(0.25, Math.min(2.0, leverageRatio));
    adjustedRiskPercentage = trade.risk_percentage * riskMultiplier;
  }
  const adjustedRiskAmount = accountBalance * (adjustedRiskPercentage / 100);
  
  // Calculate using CURRENT (potentially incorrect) formula from positionSizing.ts
  // Use stopLossToUse (original stop loss) for calculation, not current stop loss
  // IMPORTANT: Never use trade.stop_loss if it equals entry_price (breakeven) - that causes division by zero
  let positionSizeCurrent: number;
  try {
    positionSizeCurrent = calculatePositionSize(
      accountBalance,
      trade.risk_percentage,
      trade.entry_price,
      stopLossToUse, // Use original stop loss, not current (breakeven) stop loss
      trade.leverage,
      baseLeverage
    );
    
    // Check for invalid results
    if (!isFinite(positionSizeCurrent) || positionSizeCurrent <= 0) {
      console.log('\n⚠️  CURRENT Formula produced invalid result (Infinity or NaN)');
      console.log(`   Result: ${positionSizeCurrent}`);
      console.log('   This may indicate division by zero or other calculation error.');
      console.log(`   Entry: ${trade.entry_price}, Stop Loss Used: ${stopLossToUse}, Price Diff: ${priceDiff}`);
    }
  } catch (error) {
    console.log('\n⚠️  ERROR calculating position size with current formula:');
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
    positionSizeCurrent = Infinity; // Mark as invalid
  }
  
  const quantityCurrent = isFinite(positionSizeCurrent) ? positionSizeCurrent / trade.entry_price : Infinity;
  const lossCurrent = isFinite(quantityCurrent) ? quantityCurrent * priceDiff : Infinity;
  
  // Calculate using CORRECT formula
  // Loss = quantity * priceDiff
  // We want: loss = riskAmount
  // Therefore: quantity = riskAmount / priceDiff
  // Position Size = quantity * entryPrice = (riskAmount / priceDiff) * entryPrice
  const quantityCorrect = riskAmount / priceDiff;
  const positionSizeCorrect = quantityCorrect * trade.entry_price;
  const lossCorrect = quantityCorrect * priceDiff;
  
  console.log('\n=== CURRENT Formula (from positionSizing.ts) ===');
  console.log(`Using Stop Loss: ${stopLossToUse}`);
  if (baseLeverage && adjustedRiskPercentage !== trade.risk_percentage) {
    console.log(`Adjusted Risk %: ${adjustedRiskPercentage.toFixed(2)}% (base: ${trade.risk_percentage}%, leverage ratio: ${(trade.leverage / baseLeverage).toFixed(2)}x)`);
    console.log(`Adjusted Risk Amount: ${adjustedRiskAmount.toFixed(4)} USD (base: ${riskAmount.toFixed(4)} USD)`);
  } else {
    console.log(`Risk Amount: ${riskAmount.toFixed(4)} USD`);
  }
  console.log(`Risk Per Unit = (${priceDiff.toFixed(8)} / ${trade.entry_price}) × ${trade.leverage}`);
  const riskPerUnit = (priceDiff / trade.entry_price) * trade.leverage;
  console.log(`Risk Per Unit = ${riskPerUnit.toFixed(8)}`);
  
  if (isFinite(positionSizeCurrent) && positionSizeCurrent > 0) {
    const displayRiskAmount = baseLeverage && adjustedRiskPercentage !== trade.risk_percentage ? adjustedRiskAmount : riskAmount;
    const calculatedPositionSize = displayRiskAmount / riskPerUnit;
    console.log(`Position Size = ${displayRiskAmount.toFixed(4)} / ${riskPerUnit.toFixed(8)} = ${calculatedPositionSize.toFixed(4)} USD`);
    console.log(`(Function returned: ${positionSizeCurrent.toFixed(4)} USD)`);
    console.log(`Quantity = ${positionSizeCurrent.toFixed(4)} / ${trade.entry_price} = ${quantityCurrent.toFixed(4)}`);
    console.log(`Loss at SL = ${quantityCurrent.toFixed(4)} × ${priceDiff.toFixed(8)} = ${lossCurrent.toFixed(4)} USD`);
    console.log(`Expected Risk: ${riskAmount.toFixed(4)} USD (${trade.risk_percentage}% of balance)`);
    if (baseLeverage && adjustedRiskPercentage !== trade.risk_percentage) {
      console.log(`Adjusted Risk: ${adjustedRiskAmount.toFixed(4)} USD (${adjustedRiskPercentage.toFixed(2)}% of balance)`);
    }
    if (isFinite(lossCurrent)) {
      // Compare against adjusted risk amount if leverage adjustment was applied
      const expectedRiskForComparison = baseLeverage && adjustedRiskPercentage !== trade.risk_percentage ? adjustedRiskAmount : riskAmount;
      if (Math.abs(lossCurrent - expectedRiskForComparison) > 0.01) {
        console.log(`⚠️  MISMATCH: Loss (${lossCurrent.toFixed(4)}) vs Expected (${expectedRiskForComparison.toFixed(4)}) = ${Math.abs(lossCurrent - expectedRiskForComparison).toFixed(4)} USD difference!`);
      }
    }
  } else {
    const displayRiskAmount = baseLeverage && adjustedRiskPercentage !== trade.risk_percentage ? adjustedRiskAmount : riskAmount;
    const calculatedPositionSize = displayRiskAmount / riskPerUnit;
    console.log(`Position Size = ${displayRiskAmount.toFixed(4)} / ${riskPerUnit.toFixed(8)} = ${calculatedPositionSize.toFixed(4)} USD`);
    console.log(`(Function returned: ${positionSizeCurrent} - INVALID)`);
    console.log(`⚠️  Formula produced invalid result - this indicates a bug in the calculation`);
    console.log(`   Possible causes: division by zero, invalid input parameters, or calculation error`);
  }
  
  console.log('\n=== CORRECT Formula ===');
  console.log(`Using Stop Loss: ${stopLossToUse}`);
  console.log(`Quantity = ${riskAmount.toFixed(4)} / ${priceDiff.toFixed(8)} = ${quantityCorrect.toFixed(4)}`);
  console.log(`Position Size = ${quantityCorrect.toFixed(4)} × ${trade.entry_price} = ${positionSizeCorrect.toFixed(4)} USD`);
  console.log(`Loss at SL = ${quantityCorrect.toFixed(4)} × ${priceDiff.toFixed(8)} = ${lossCorrect.toFixed(4)} USD`);
  console.log(`Expected Risk: ${riskAmount.toFixed(4)} USD`);
  console.log(`✓ Loss matches risk amount`);
  
  console.log('\n=== Comparison ===');
  console.log(`Actual Quantity in DB: ${trade.quantity || 'NULL'}`);
  if (isFinite(quantityCurrent)) {
    console.log(`Current Formula Quantity: ${quantityCurrent.toFixed(4)}`);
  } else {
    console.log(`Current Formula Quantity: ${quantityCurrent} (INVALID)`);
  }
  console.log(`Correct Formula Quantity: ${quantityCorrect.toFixed(4)}`);
  
  if (trade.quantity) {
    if (isFinite(quantityCurrent)) {
      const diffCurrent = Math.abs(quantityCurrent - trade.quantity);
      const diffCorrect = Math.abs(quantityCorrect - trade.quantity);
      console.log(`\nDifference from Current Formula: ${diffCurrent.toFixed(4)}`);
      console.log(`Difference from Correct Formula: ${diffCorrect.toFixed(4)}`);
      
      if (diffCorrect < diffCurrent) {
        console.log('✓ Correct formula matches better!');
      }
    } else {
      const diffCorrect = Math.abs(quantityCorrect - trade.quantity);
      console.log(`\nDifference from Current Formula: N/A (invalid result)`);
      console.log(`Difference from Correct Formula: ${diffCorrect.toFixed(4)}`);
      console.log('✓ Correct formula must be used (current formula is broken)');
    }
  }
  
  // Calculate margin requirements
  const marginCurrent = isFinite(positionSizeCurrent) ? positionSizeCurrent / trade.leverage : Infinity;
  const marginCorrect = positionSizeCorrect / trade.leverage;
  
  console.log('\n=== Margin Requirements ===');
  console.log(`Current Formula Margin: ${marginCurrent.toFixed(4)} USD (${trade.leverage}x)`);
  console.log(`Correct Formula Margin: ${marginCorrect.toFixed(4)} USD (${trade.leverage}x)`);
  
  return {
    positionSizeCurrent,
    quantityCurrent,
    lossCurrent,
    positionSizeCorrect,
    quantityCorrect,
    lossCorrect,
    actualQuantity: trade.quantity,
    riskAmount,
    marginCurrent,
    marginCorrect
  };
}

async function main() {
  const tradeId = parseInt(process.argv[2] || '31');
  const balanceArg = process.argv[3];
  
  console.log(`\n🔍 Investigating Trade ${tradeId}\n`);
  console.log('='.repeat(60));
  
  try {
    // Get trade from database
    const trade = await queryTrade(tradeId);
    
    if (!trade) {
      console.log(`❌ Trade ${tradeId} not found in database`);
      process.exit(1);
    }
    
    console.log('\n=== Trade Details ===');
    console.log(JSON.stringify(trade, null, 2));
    
    // Check for invalid TP prices
    const takeProfits = JSON.parse(trade.take_profits || '[]') as number[];
    if (takeProfits.length > 0) {
      console.log('\n=== TP Price Validation ===');
      const invalidTPs: Array<{ index: number; price: number; reason: string }> = [];
      
      takeProfits.forEach((tp, index) => {
        if (trade.direction === 'long' && tp <= trade.entry_price) {
          invalidTPs.push({
            index: index + 1,
            price: tp,
            reason: `TP${index + 1} (${tp}) is below or equal to entry price (${trade.entry_price}) for long position`
          });
        } else if (trade.direction === 'short' && tp >= trade.entry_price) {
          invalidTPs.push({
            index: index + 1,
            price: tp,
            reason: `TP${index + 1} (${tp}) is above or equal to entry price (${trade.entry_price}) for short position`
          });
        }
      });
      
      if (invalidTPs.length > 0) {
        console.log('⚠️  INVALID TP PRICES DETECTED:');
        invalidTPs.forEach(tp => {
          console.log(`   ${tp.reason}`);
        });
        console.log('\n⚠️  This trade should not have been placed!');
        console.log('   For market orders, TP prices may have been valid relative to the parsed entry price');
        console.log('   but invalid relative to the actual fill price.');
      } else {
        console.log('✓ All TP prices are valid relative to entry price');
      }
    }
    
    // Original (pre-BE) stop loss — for SL verification narrative and "SL not reset" check
    let originalStopLoss: number | undefined;
    const tol = Math.max(0.01, (trade.entry_price || 0) * 0.0001);
    if (trade.stop_loss != null && Math.abs(trade.stop_loss - trade.entry_price) >= tol) {
      originalStopLoss = trade.stop_loss;
    } else if (trade.stop_loss === trade.entry_price) {
      console.log('\n⚠️  Stop loss equals entry price - likely moved to breakeven');
      console.log('   Querying original message to find initial stop loss...');
      
      const message = await queryMessage(trade.message_id, trade.channel);
      if (message) {
        console.log('\n=== Original Message ===');
        console.log(`Message ID: ${message.message_id}`);
        console.log(`Content: ${message.content.substring(0, 200)}...`);
        
        // Try to extract stop loss from message (basic parsing)
        const stopLossMatch = message.content.match(/stop[_\s-]?loss[:\s]+([0-9.]+)/i) ||
                             message.content.match(/stoploss[:\s]+([0-9.]+)/i) ||
                             message.content.match(/sl[:\s]+([0-9.]+)/i) ||
                             message.content.match(/❌[^\d]*([0-9.]+)/);
        
        if (stopLossMatch) {
          originalStopLoss = parseFloat(stopLossMatch[1]);
          console.log(`\n✓ Found original stop loss in message: ${originalStopLoss}`);
        } else {
          console.log('\n⚠️  Could not extract stop loss from message');
          console.log('   You may need to manually check the message or parser output');
        }
      } else {
        console.log(`\n⚠️  Message ${trade.message_id} not found in database`);
      }
    }
    
    // Get channel config to find baseLeverage
    const channelConfig = config.channels.find((c: any) => c.channel === trade.channel);
    const baseLeverage = channelConfig?.baseLeverage;
    
    // Get initiator config for risk percentage
    const initiatorConfig = config.initiators.find((i: any) => i.name === 'bybit');
    const riskPercentage = initiatorConfig?.riskPercentage || trade.risk_percentage;
    
    console.log('\n=== Config Settings ===');
    console.log(`Channel: ${trade.channel}`);
    console.log(`Base Leverage: ${baseLeverage || 'Not configured'}`);
    console.log(`Risk Percentage: ${riskPercentage}%`);

    // Management commands (like message investigation): messages that could have affected this trade
    console.log('\n=== Management Commands ===');
    const windowStart = trade.entry_filled_at || trade.created_at;
    if (windowStart) {
      const startDate = dayjs(windowStart).subtract(5, 'minute').toISOString();
      const endDate = (trade.exit_filled_at ? dayjs(trade.exit_filled_at) : dayjs()).add(10, 'minute').toISOString();
      const windowMessages = await queryMessagesInWindow(trade.channel, startDate, endDate);
      const applicable: Array<{ date: string; content: string; cmd: { type: string; tradingPair?: string; percentage?: number; moveStopLossToEntry?: boolean } }> = [];
      for (const m of windowMessages) {
        const cmd = await parseManagementCommand(m.content, undefined, undefined, undefined);
        if (cmd && commandAppliesToTrade(cmd, trade)) {
          applicable.push({
            date: m.date,
            content: m.content,
            cmd: {
              type: cmd.type,
              tradingPair: cmd.tradingPair,
              percentage: (cmd as any).percentage,
              moveStopLossToEntry: (cmd as any).moveStopLossToEntry
            }
          });
        }
      }
      if (applicable.length > 0) {
        console.log(`Found ${applicable.length} message(s) that may be management commands affecting this trade:`);
        applicable.forEach((a, i) => {
          const opts: string[] = [];
          if (a.cmd.percentage) opts.push(`${a.cmd.percentage}%`);
          if (a.cmd.moveStopLossToEntry) opts.push('SL→BE');
          const optsStr = opts.length ? ` [${opts.join(', ')}]` : '';
          console.log(`  ${i + 1}. ${a.date} | ${a.cmd.type}${optsStr}`);
          console.log(`     "${(a.content || '').slice(0, 80)}${(a.content || '').length > 80 ? '...' : ''}"`);
        });

        // Verify execution by querying the exchange
        const fromTs = dayjs(windowStart).subtract(5, 'minute').valueOf();
        const toTs = (trade.exit_filled_at ? dayjs(trade.exit_filled_at) : dayjs()).add(10, 'minute').valueOf();
        let executionConfirmed = false;
        let executionDetail = '';

        if (trade.exchange === 'ctrader') {
          const ctraderClient = await getCTraderClientForTrade(trade.account_name);
          if (ctraderClient) {
            try {
              const posId = trade.position_id ? String(trade.position_id) : '';
              let relevantDeals: Array<{ dealId: string; volume: number; executionPrice?: number; grossProfit?: number; orderType?: string; closedBy?: string }>;

              if (posId) {
                const posResult = await queryCTraderPositionClosingDeals(ctraderClient, posId, fromTs, toTs, {
                  entryPrice: trade.entry_price,
                  isLong: (trade.direction ?? '').toLowerCase() === 'long'
                });
                relevantDeals = posResult.closingDeals ?? [];
                if (posResult.error) {
                  executionDetail = ` (position deals error: ${posResult.error})`;
                } else if (relevantDeals.length > 0) {
                  executionConfirmed = true;
                  executionDetail = ` — ${relevantDeals.length} closing deal(s) for this position (pos ${posId})`;
                  console.log(`\n  === Position closed by ===`);
                  relevantDeals.forEach((d) => {
                    const reason = d.closedBy ? ` [${d.closedBy}]` : d.orderType ? ` [${d.orderType}]` : '';
                    const parts = [`Deal ${d.dealId}`, `${d.volume} lots`, `${d.orderType ?? '?'}${reason}`];
                    if (d.executionPrice != null) parts.push(`@ ${d.executionPrice}`);
                    if (d.grossProfit != null) parts.push(`P&L ${d.grossProfit}${(d as any).grossProfitEstimated ? ' (est.)' : ''}`);
                    console.log(`     • ${parts.join(' ')}`);
                  });
                } else {
                  const accountResult = await queryCTraderClosingDeals(ctraderClient, fromTs, toTs);
                  relevantDeals = (accountResult.closingDeals ?? []).filter((d: any) => String(d.positionId) === posId);
                  if (relevantDeals.length > 0) {
                    executionConfirmed = true;
                    executionDetail = ` — ${relevantDeals.length} closing deal(s) from account history (pos ${posId})`;
                    console.log(`\n  === Position closed by (from account history) ===`);
                    relevantDeals.forEach((d) => {
                      const reason = d.closedBy ? ` [${d.closedBy}]` : d.orderType ? ` [${d.orderType}]` : '';
                      const parts = [`Deal ${d.dealId}`, `${d.volume} lots`, `${d.orderType ?? '?'}${reason}`];
                      if (d.executionPrice != null) parts.push(`@ ${d.executionPrice}`);
                      if (d.grossProfit != null) parts.push(`P&L ${d.grossProfit}${(d as any).grossProfitEstimated ? ' (est.)' : ''}`);
                      console.log(`     • ${parts.join(' ')}`);
                    });
                  } else {
                    executionDetail = ` — no closing deals found for position ${posId}`;
                  }
                }
              } else {
                const result = await queryCTraderClosingDeals(ctraderClient, fromTs, toTs);
                relevantDeals = result.closingDeals ?? [];
                if (result.error) executionDetail = ` (query error: ${result.error})`;
                else if (relevantDeals.length > 0) {
                  executionConfirmed = true;
                  executionDetail = ` — ${result.closingDealsCount} closing deal(s) in window`;
                } else executionDetail = ' — no closing deals in window';
              }

              // Verify SL→BE: check position's SL/TP orders (linked by positionId), not the close orders
              const anyHadSlToBe = applicable.some((a) => a.cmd.moveStopLossToEntry);
              if (anyHadSlToBe && trade.entry_price && trade.position_id) {
                const takeProfits = JSON.parse(trade.take_profits || '[]') as number[];
                const slResult = await queryCTraderPositionSlLevel(
                  ctraderClient,
                  String(trade.position_id),
                  trade.entry_price,
                  fromTs,
                  toTs,
                  { originalStopLoss, tpPrices: takeProfits }
                );
                if (slResult.error) {
                  console.log(`\n  ⚠️ SL→BE verification failed: ${slResult.error}`);
                } else if (slResult.verified) {
                  console.log(`\n  ✅ SL moved to breakeven confirmed — position's SL order shows stopLoss @ ${trade.entry_price}`);
                } else if (slResult.ordersWithSl.length > 0) {
                  const slVals = slResult.ordersWithSl.map((o) => o.stopLoss).join(', ');
                  console.log(`\n  ⚠️ SL→BE not verified — position SL orders have stopLoss: ${slVals} (entry: ${trade.entry_price})`);
                } else {
                  const dbShowsBe = Math.abs((trade.stop_loss ?? 0) - trade.entry_price) < Math.max(0.01, trade.entry_price * 0.0001);
                  if (dbShowsBe) {
                    console.log(`\n  ✅ SL moved to breakeven — DB shows stop at entry (manager sets this after modifyPosition succeeds)`);
                  } else {
                    console.log(`\n  ⚠️ SL→BE not verifiable — no position SL orders found in closed orders for pos ${trade.position_id}`);
                    console.log(`  💡 To find why: check logs for "Error moving stop loss to entry on cTrader" or "modifyPosition"`);
                    console.log(`     Full investigation: npm run investigate -- /investigate message:${trade.message_id} channel:${trade.channel}`);
                  }
                }
                if (slResult.narrative) {
                  if (slResult.narrative.closedAtTp) {
                    console.log(`  ℹ️  Narrative: Position closed at TP — SL was never hit`);
                  }
                  if (slResult.narrative.slMatchesOriginal && slResult.narrative.closingOrderSl != null) {
                    console.log(`  ⚠️  Narrative: Closing order had SL @ ${slResult.narrative.closingOrderSl} (original) — SL may not have been reset; examine logs`);
                  } else if (slResult.narrative.closingOrderSl != null && !slResult.verified) {
                    console.log(`  ℹ️  Narrative: Closing order had SL @ ${slResult.narrative.closingOrderSl}`);
                  }
                }
                // Infer narrative from closing deals when position-deal narrative is empty
                const takeProfitsForNarrative = JSON.parse(trade.take_profits || '[]') as number[];
                const tolNarrative = Math.max(0.01, (trade.entry_price || 0) * 0.0001);
                const closedAtTpFromDeals = takeProfitsForNarrative.length > 0 && relevantDeals.some(
                  (d: any) => d.executionPrice != null && takeProfitsForNarrative.some((tp: number) => Math.abs(d.executionPrice - tp) < tolNarrative)
                );
                if (closedAtTpFromDeals && !slResult.narrative?.closedAtTp) {
                  console.log(`  ℹ️  Narrative: Position closed at TP — SL was never hit`);
                }
              }
            } catch (err) {
              executionDetail = ` (error: ${err instanceof Error ? err.message : String(err)})`;
            }
          } else {
            executionDetail = ' (cTrader client not available)';
          }
          if (ctraderClient) {
            await ctraderClient.disconnect().catch(() => {});
          }
        } else {
          const bybitClient = await getBybitClientForTrade(trade.account_name);
          const symbol = (trade.trading_pair || '').replace('/', '');
          const bybitSymbol = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
          if (bybitClient) {
            try {
              const result = await queryBybitClosingExecutions(bybitClient, fromTs, toTs, bybitSymbol);
              if (result.error) {
                executionDetail = ` (query error: ${result.error})`;
              } else               if (result.closingExecutionsCount > 0) {
                executionConfirmed = true;
                executionDetail = ` — ${result.closingExecutionsCount} closing execution(s)`;
                result.closingExecutions.slice(0, 5).forEach((e) => {
                  console.log(`     • ${e.execId} | ${e.closedSize} closed @ ${e.execPrice || '?'}`);
                });
                const anyHadSlToBe = applicable.some((a) => a.cmd.moveStopLossToEntry);
                if (anyHadSlToBe) {
                  console.log(`\n  ⚠️ SL→BE not verifiable — Bybit execution history does not include stop loss level`);
                }
              } else {
                executionDetail = ' — no closing executions in window';
              }
            } catch (err) {
              executionDetail = ` (error: ${err instanceof Error ? err.message : String(err)})`;
            }
          } else {
            executionDetail = ' (Bybit client not available)';
          }
        }

        if (executionConfirmed) {
          console.log(`\n  ✅ Management command executed on exchange${executionDetail}`);
        } else {
          console.log(`\n  ⚠️ Exchange verification: no execution found${executionDetail}`);
          console.log('     Management command may not have run, or effect may be on a different position.');
        }
        console.log('  For full investigation: npm run investigate -- /investigate message:<id> channel:<channel>');
      } else {
        console.log('No management commands found in message window.');
      }
    } else {
      console.log('No entry_filled_at or created_at - cannot scope message window.');
    }

    // Use provided balance or prompt for it
    if (balanceArg) {
      const balance = parseFloat(balanceArg);
      calculateExpectedQuantity(trade, balance, baseLeverage, originalStopLoss);
    } else {
      console.log('\n💡 To calculate expected quantity, provide account balance as second argument:');
      console.log(`   tsx src/scripts/investigate_trade.ts ${tradeId} <account_balance>`);
      console.log('\nExample:');
      console.log(`   tsx src/scripts/investigate_trade.ts ${tradeId} 10000`);
    }
    
    // Show the formula being used
    console.log('\n=== Formula Explanation ===');
    console.log('CURRENT Formula:');
    console.log('  Risk Per Unit = (Price Diff / Entry Price) × Leverage');
    console.log('  Position Size = Risk Amount / Risk Per Unit');
    console.log('\nCORRECT Formula:');
    console.log('  Loss = Quantity × Price Diff');
    console.log('  We want: Loss = Risk Amount');
    console.log('  Therefore: Quantity = Risk Amount / Price Diff');
    console.log('  Position Size = Quantity × Entry Price');
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    if (isPostgres) {
      await (db as Pool).end();
    } else {
      (db as Database.Database).close();
    }
  }
}

main();

