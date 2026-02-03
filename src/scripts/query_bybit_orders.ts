#!/usr/bin/env tsx
/**
 * Query Bybit Orders Script
 * 
 * Queries Bybit for order details by order ID or searches recent orders
 * 
 * Usage: 
 *   tsx src/scripts/query_bybit_orders.ts <orderId> <symbol> <accountName>
 *   tsx src/scripts/query_bybit_orders.ts search <symbol> <accountName> [limit]
 */

import { RestClientV5 } from 'bybit-api';
import { queryBybitOrder, searchRecentOrdersBySymbol } from '../investigation/utils/bybitOrderQuery.js';
import { createWorkflowContext } from '../investigation/workflowEngine.js';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Load .env-investigation first, then fall back to .env
const envInvestigationPath = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');

if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.log('Usage:');
    console.log('  Query by order ID: tsx src/scripts/query_bybit_orders.ts <orderId> <symbol> <accountName>');
    console.log('  Search recent orders: tsx src/scripts/query_bybit_orders.ts search <symbol> <accountName> [limit]');
    console.log('\nExamples:');
    console.log('  tsx src/scripts/query_bybit_orders.ts 27cc3c97 PAXGUSDT demo');
    console.log('  tsx src/scripts/query_bybit_orders.ts search PAXGUSDT demo 20');
    process.exit(1);
  }

  const [orderIdOrSearch, symbol, accountName, limitStr] = args;
  
  // Check if this is a search request
  if (orderIdOrSearch === 'search') {
    const limit = limitStr ? parseInt(limitStr) : 20;
    
    console.log(`\nSearching recent orders:`);
    console.log(`  Symbol: ${symbol}`);
    console.log(`  Account: ${accountName}`);
    console.log(`  Limit: ${limit}\n`);

    const context = await createWorkflowContext({});
    const bybitClient = await context.getBybitClient?.(accountName);

    if (!bybitClient) {
      console.error('❌ Failed to create Bybit client. Check API credentials.');
      await context.db.close();
      process.exit(1);
    }

    const baseUrl = (bybitClient as any).baseUrl || 'https://api.bybit.com';
    const isDemo = baseUrl.includes('api-demo');
    console.log(`  API Endpoint: ${isDemo ? 'DEMO' : 'LIVE'} (${baseUrl})\n`);

    try {
      const orders = await searchRecentOrdersBySymbol(bybitClient, symbol, accountName, limit);
      
      console.log(`\n📊 Found ${orders.length} Recent Orders:`);
      console.log('─'.repeat(80));
      
      if (orders.length === 0) {
        console.log('No orders found');
      } else {
        orders.forEach((order, idx) => {
          console.log(`\n${idx + 1}. Order ID: ${order.orderId}`);
          console.log(`   Status: ${order.orderStatus || 'N/A'}`);
          console.log(`   Type: ${order.orderType || 'N/A'}, Side: ${order.side || 'N/A'}`);
          if (order.price) console.log(`   Price: ${order.price}`);
          if (order.qty) console.log(`   Quantity: ${order.qty}`);
          if (order.avgPrice) console.log(`   Avg Price: ${order.avgPrice}`);
          if (order.cumExecQty) console.log(`   Executed: ${order.cumExecQty}`);
          if (order.createdTime) {
            console.log(`   Created: ${new Date(parseInt(order.createdTime)).toISOString()}`);
          }
        });
      }
      
      console.log('─'.repeat(80));
    } catch (error) {
      console.error('❌ Error searching orders:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      await context.db.close();
    }
    
    return;
  }

  // Regular order query
  const orderId = orderIdOrSearch;

  console.log(`\nQuerying Bybit order:`);
  console.log(`  Order ID: ${orderId}`);
  console.log(`  Symbol: ${symbol}`);
  console.log(`  Account: ${accountName}\n`);

  const context = await createWorkflowContext({});
  const bybitClient = await context.getBybitClient?.(accountName);

  if (!bybitClient) {
    console.error('❌ Failed to create Bybit client. Check API credentials.');
    await context.db.close();
    process.exit(1);
  }

  // Show which API endpoint is being used
  const baseUrl = (bybitClient as any).baseUrl || 'https://api.bybit.com';
  const isDemo = baseUrl.includes('api-demo');
  const isTestnet = (bybitClient as any).testnet || false;
  console.log(`  API Endpoint: ${isDemo ? 'DEMO' : isTestnet ? 'TESTNET' : 'LIVE'} (${baseUrl})\n`);

  try {
    const orderDetails = await queryBybitOrder(bybitClient, orderId, symbol, accountName);

    console.log('\n📊 Order Details:');
    console.log('─'.repeat(60));
    
    if (orderDetails.found) {
      console.log(`✅ Order Found (${orderDetails.foundIn})`);
      console.log(`   Status: ${orderDetails.orderStatus || 'N/A'}`);
      console.log(`   Type: ${orderDetails.orderType || 'N/A'}`);
      console.log(`   Side: ${orderDetails.side || 'N/A'}`);
      if (orderDetails.price) {
        console.log(`   Price: ${orderDetails.price}`);
      }
      if (orderDetails.qty) {
        console.log(`   Quantity: ${orderDetails.qty}`);
      }
      if (orderDetails.avgPrice) {
        console.log(`   Avg Price: ${orderDetails.avgPrice}`);
      }
      if (orderDetails.cumExecQty) {
        console.log(`   Executed Qty: ${orderDetails.cumExecQty}`);
      }
      if (orderDetails.createdTime) {
        console.log(`   Created: ${new Date(parseInt(orderDetails.createdTime)).toISOString()}`);
      }
      if (orderDetails.updatedTime) {
        console.log(`   Updated: ${new Date(parseInt(orderDetails.updatedTime)).toISOString()}`);
      }
    } else {
      console.log(`❌ Order Not Found`);
      if (orderDetails.error) {
        console.log(`   Error: ${orderDetails.error}`);
      }
    }
    
    console.log('─'.repeat(60));
  } catch (error) {
    console.error('❌ Error querying order:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await context.db.close();
  }
}

main().catch(console.error);

