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
import { readFileSync } from 'fs';
import { join } from 'path';
import config from '../../config.json';
import { calculatePositionSize } from '../utils/positionSizing.js';

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
  message_id: number;
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
}

interface Message {
  id: number;
  message_id: number;
  channel: string;
  content: string;
  date: string;
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
      created_at
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

async function queryMessage(messageId: number, channel: string): Promise<Message | null> {
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
    
    // Check if stop loss equals entry (breakeven)
    let originalStopLoss: number | undefined;
    if (trade.stop_loss === trade.entry_price) {
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

