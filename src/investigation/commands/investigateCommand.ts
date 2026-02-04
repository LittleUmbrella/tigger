/**
 * /investigate Command
 * 
 * Full guided investigation workflow:
 * 1. Gather all data (database, Loggly, Bybit)
 * 2. Analyze findings
 * 3. Identify root cause
 * 4. Provide recommendations
 * 
 * Usage: /investigate message:<id> [channel:<channel>]
 */

import { CommandContext, CommandResult } from '../commandRegistry.js';
import { WorkflowEngine, WorkflowStep, createWorkflowContext } from '../workflowEngine.js';
import { logger } from '../../utils/logger.js';
import { traceMessage } from '../../scripts/trace_message.js';
import { queryBybitOrdersForMessage } from '../utils/bybitOrderQuery.js';
import { getGoldPriceComparison } from '../utils/goldPriceCheck.js';

export async function investigateCommandHandler(context: CommandContext): Promise<CommandResult> {
  const messageId = context.args.message;
  const channel = context.args.channel as string | undefined;

  if (!messageId) {
    return {
      success: false,
      message: 'Missing required argument: message',
      error: 'Usage: /investigate message:<id> [channel:<channel>]'
    };
  }

  const workflowContext = await createWorkflowContext({
    messageId: String(messageId), // Keep as string for traceMessage compatibility
    channel
  });

  const engine = new WorkflowEngine(workflowContext);

  // Step 1: Trace message through system
  engine.addStep({
    id: 'trace',
    name: 'Trace Message Through System',
    required: true,
    execute: async (ctx) => {
      const msgId = String(ctx.args.messageId);
      const ch = ctx.args.channel;
      
      logger.debug('Trace step - calling traceMessage', {
        messageId: msgId,
        channel: ch,
        messageIdType: typeof msgId,
        channelType: typeof ch
      });
      
      try {
        const traceResult = await traceMessage(msgId, ch);
        
        return {
          success: !traceResult.failurePoint,
          message: traceResult.failurePoint 
            ? `Trace found failure at: ${traceResult.failurePoint}`
            : 'Trace completed - all steps passed',
          data: traceResult,
          error: traceResult.failurePoint ? `Failure at: ${traceResult.failurePoint}` : undefined
        };
      } catch (error) {
        logger.error('Error in trace step', {
          messageId: msgId,
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          success: false,
          message: 'Failed to trace message',
          error: error instanceof Error ? error.message : String(error),
          data: { messageId: msgId, channel: ch }
        };
      }
    }
  });

  // Step 2: Query Loggly for related logs
  engine.addStep({
    id: 'loggly',
    name: 'Query Loggly for Related Logs',
    required: false,
    execute: async (ctx) => {
      if (!ctx.logglyClient) {
        return {
          success: false,
          message: 'Loggly client not available',
          skipRemaining: false
        };
      }

      const traceResult = ctx.stepResults.get('trace')?.data;
      const messageId = ctx.args.messageId;
      const channel = ctx.args.channel;

      if (!traceResult) {
        return {
          success: false,
          message: 'Trace step must complete first'
        };
      }

      // Get timestamp from trace
      const timestamp = traceResult.steps[0]?.timestamp || new Date().toISOString();
      const windowMinutes = 10;

      try {
        // Query for message-specific logs
        const messageLogs = await ctx.logglyClient!.searchByMessageId(
          messageId,
          channel || '',
          {
            from: new Date(new Date(timestamp).getTime() - windowMinutes * 60 * 1000).toISOString(),
            until: new Date(new Date(timestamp).getTime() + windowMinutes * 60 * 1000).toISOString()
          }
        );

        // Query for errors around that time
        const errorLogs = await ctx.logglyClient!.searchErrorsAroundTime(
          timestamp,
          windowMinutes
        );

        // Query for Bybit errors
        const bybitErrors = await ctx.logglyClient!.searchBybitErrors({
          from: new Date(new Date(timestamp).getTime() - windowMinutes * 60 * 1000).toISOString(),
          until: new Date(new Date(timestamp).getTime() + windowMinutes * 60 * 1000).toISOString()
        });

        return {
          success: true,
          message: `Found ${messageLogs.total_events} message logs, ${errorLogs.total_events} errors, ${bybitErrors.total_events} Bybit errors`,
          data: {
            messageLogs,
            errorLogs,
            bybitErrors
          }
        };
      } catch (error) {
        logger.error('Error querying Loggly', {
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          success: false,
          message: 'Failed to query Loggly',
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  });

  // Step 3: Query Bybit orders
  engine.addStep({
    id: 'bybitOrders',
    name: 'Query Bybit Order Details',
    required: false,
    execute: async (ctx) => {
      if (!ctx.getBybitClient) {
        return {
          success: false,
          message: 'Bybit client helper not available',
          skipRemaining: false
        };
      }

      const traceResult = ctx.stepResults.get('trace')?.data;
      const messageId = ctx.args.messageId;
      const channel = ctx.args.channel;

      if (!traceResult) {
        return {
          success: false,
          message: 'Trace step must complete first'
        };
      }

      // Get trades from trace result
      const trades = traceResult.steps?.find((s: any) => s.step.includes('Trade Creation'))?.details?.trades;
      if (!trades || trades.length === 0) {
        return {
          success: true,
          message: 'No trades found to query orders for',
          data: { orders: [] }
        };
      }

      try {
        // Get full trade details from database
        const dbTrades = await ctx.db.getTradesByMessageId(String(messageId), channel || 'unknown');
        
        if (dbTrades.length === 0) {
          return {
            success: true,
            message: 'No trades in database to query orders for',
            data: { orders: [] }
          };
        }

        // Query orders for each trade
        const orderDetails = await queryBybitOrdersForMessage(
          ctx.getBybitClient,
          dbTrades.map(t => ({
            order_id: t.order_id,
            trading_pair: t.trading_pair,
            account_name: t.account_name
          }))
        );

        const foundOrders = orderDetails.filter(o => o.found);
        const notFoundOrders = orderDetails.filter(o => !o.found);

        return {
          success: true,
          message: `Queried ${orderDetails.length} orders: ${foundOrders.length} found, ${notFoundOrders.length} not found`,
          data: {
            orders: orderDetails,
            foundCount: foundOrders.length,
            notFoundCount: notFoundOrders.length
          }
        };
      } catch (error) {
        logger.error('Error querying Bybit orders', {
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          success: false,
          message: 'Failed to query Bybit orders',
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  });

  // Step 4: Check gold/XAUT prices for PAXG trades
  engine.addStep({
    id: 'goldPriceCheck',
    name: 'Check Gold/XAUT Prices (PAXG trades only)',
    required: false,
    execute: async (ctx) => {
      const traceResult = ctx.stepResults.get('trace')?.data;
      
      if (!traceResult) {
        return {
          success: false,
          message: 'Trace step must complete first'
        };
      }

      // Check if this is a PAXG trade
      const parsingStep = traceResult.steps?.find((s: any) => s.step.includes('Parsing'));
      const tradingPair = parsingStep?.details?.tradingPair;
      
      if (!tradingPair || (!tradingPair.toUpperCase().includes('PAXG') && tradingPair.toUpperCase() !== 'GOLD')) {
        return {
          success: true,
          message: 'Not a PAXG/Gold trade - skipping gold price check',
          data: { skipped: true }
        };
      }

      // Get entry timestamp from trades
      const trades = traceResult.steps?.find((s: any) => s.step.includes('Trade Creation'))?.details?.trades;
      if (!trades || trades.length === 0) {
        return {
          success: true,
          message: 'No trades found - skipping gold price check',
          data: { skipped: true }
        };
      }

      // Use the message timestamp (when signal was received) rather than trade creation time
      // This gives the price at the time the entry decision was made
      const messageStep = traceResult.steps?.find((s: any) => s.step.includes('Message Storage'));
      const entryTimestamp = messageStep?.details?.date || messageStep?.timestamp || traceResult.steps[0]?.timestamp;
      
      const firstTrade = trades[0];
      
      if (!entryTimestamp) {
        return {
          success: false,
          message: 'Could not determine entry timestamp'
        };
      }

      // Get PAXG entry price from parsing or trade
      const paxgPrice = parsingStep?.details?.entryPrice || firstTrade.entryPrice;

      try {
        const bybitClient = await ctx.getBybitClient?.(firstTrade.accountName);
        const comparison = await getGoldPriceComparison(
          bybitClient,
          new Date(entryTimestamp),
          paxgPrice
        );

        return {
          success: true,
          message: 'Gold/XAUT price comparison completed',
          data: { comparison }
        };
      } catch (error) {
        logger.error('Error checking gold prices', {
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          success: false,
          message: 'Failed to check gold prices',
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  });

  // Step 5: Analyze findings
  engine.addStep({
    id: 'analyze',
    name: 'Analyze Findings',
    required: true,
    execute: async (ctx) => {
      const traceResult = ctx.stepResults.get('trace')?.data;
      const logglyData = ctx.stepResults.get('loggly')?.data;
      const orderData = ctx.stepResults.get('bybitOrders')?.data;
      const goldPriceData = ctx.stepResults.get('goldPriceCheck')?.data;

      if (!traceResult) {
        return {
          success: false,
          message: 'Trace step must complete first'
        };
      }

      // Analyze failure point
      const failurePoint = traceResult.failurePoint;
      const findings: string[] = [];
      const recommendations: string[] = [];

      // Add order details to findings if available
      if (orderData?.orders && orderData.orders.length > 0) {
        findings.push(`Bybit Orders: ${orderData.foundCount} found, ${orderData.notFoundCount} not found`);
        
        orderData.orders.forEach((order: any) => {
          if (order.found) {
            findings.push(`  ✅ Order ${order.orderId} (${order.accountName}): ${order.orderStatus || 'unknown'} - ${order.foundIn}`);
            if (order.avgPrice) {
              findings.push(`     Avg Price: ${order.avgPrice}, Executed Qty: ${order.cumExecQty || '0'}/${order.qty || 'N/A'}`);
            }
          } else {
            findings.push(`  ❌ Order ${order.orderId} (${order.accountName}): Not found on Bybit`);
            if (order.error) {
              findings.push(`     Error: ${order.error}`);
            }
          }
        });
      }

      // Add gold/XAUT price comparison for PAXG trades
      if (goldPriceData?.comparison && !goldPriceData.skipped) {
        const comp = goldPriceData.comparison;
        findings.push(`\n🥇 Gold Price Comparison at Entry:`);
        
        if (comp.paxgPrice) {
          findings.push(`  PAXG Price: $${comp.paxgPrice.toFixed(2)}`);
        }
        if (comp.xautPrice) {
          findings.push(`  XAUT Price: $${comp.xautPrice.toFixed(2)}`);
        }
        if (comp.goldPrice) {
          findings.push(`  Gold (XAU/USD) Price: $${comp.goldPrice.toFixed(2)} ${comp.goldSource ? `(${comp.goldSource})` : ''}`);
        }

        if (comp.comparison) {
          if (comp.comparison.paxgVsGold) {
            const { difference, percent } = comp.comparison.paxgVsGold;
            findings.push(`  PAXG vs Gold: $${difference > 0 ? '+' : ''}${difference.toFixed(2)} (${percent > 0 ? '+' : ''}${percent.toFixed(3)}%)`);
          }
          if (comp.comparison.xautVsGold) {
            const { difference, percent } = comp.comparison.xautVsGold;
            findings.push(`  XAUT vs Gold: $${difference > 0 ? '+' : ''}${difference.toFixed(2)} (${percent > 0 ? '+' : ''}${percent.toFixed(3)}%)`);
          }
          if (comp.comparison.paxgVsXaut) {
            const { difference, percent } = comp.comparison.paxgVsXaut;
            findings.push(`  PAXG vs XAUT: $${difference > 0 ? '+' : ''}${difference.toFixed(2)} (${percent > 0 ? '+' : ''}${percent.toFixed(3)}%)`);
          }
        }

        if (goldPriceData.error) {
          findings.push(`  ⚠️  ${goldPriceData.error}`);
        }
      }

      if (failurePoint) {
        findings.push(`Failure detected at: ${failurePoint}`);

        // Analyze based on failure point
        if (failurePoint.includes('Entry Order')) {
          findings.push('Entry order was not created on Bybit exchange');
          
          // Check Loggly for API errors
          if (logglyData?.bybitErrors?.events) {
            const apiErrors = logglyData.bybitErrors.events.filter((e: any) => 
              e.message?.includes('retCode') || e.message?.includes('retMsg')
            );
            
            if (apiErrors.length > 0) {
              findings.push(`Found ${apiErrors.length} Bybit API errors in logs`);
              // Extract error codes
              apiErrors.forEach((err: any) => {
                const retCodeMatch = err.message?.match(/retCode[:\s]+(\d+)/);
                const retMsgMatch = err.message?.match(/retMsg[:\s]+([^\s,}]+)/);
                
                if (retCodeMatch) {
                  findings.push(`  - Error code: ${retCodeMatch[1]}`);
                  if (retCodeMatch[1] === '110003') {
                    recommendations.push('Insufficient balance - check account balance');
                  } else if (retCodeMatch[1] === '10001') {
                    recommendations.push('Invalid parameters - check order parameters');
                  }
                }
                if (retMsgMatch) {
                  findings.push(`  - Error message: ${retMsgMatch[1]}`);
                }
              });
            }
          }

          recommendations.push('Check account balance: /check-balance');
          recommendations.push('Verify API credentials have order creation permissions');
        } else if (failurePoint.includes('Parsing')) {
          findings.push('Message could not be parsed into a trade signal');
          recommendations.push('Check parser configuration for this channel');
          recommendations.push('Message may not be a trade signal');
        } else if (failurePoint.includes('Trade Creation')) {
          findings.push('Trade was not created in database');
          recommendations.push('Check initiator logs for errors');
          recommendations.push('Verify initiator configuration');
        }
      } else {
        findings.push('All steps completed successfully');
      }

      return {
        success: true,
        message: 'Analysis complete',
        data: {
          findings,
          recommendations,
          failurePoint
        }
      };
    }
  });

  // Execute workflow
  const result = await engine.execute();

  // Extract findings and recommendations from analysis step
  const analysisResult = result.steps.find(s => s.step.id === 'analyze')?.result;
  const traceResult = result.steps.find(s => s.step.id === 'trace')?.result;
  
  const findings = analysisResult?.data?.findings || [];
  const recommendations = analysisResult?.data?.recommendations || [];

  // If trace step failed, include its error in findings
  if (traceResult && !traceResult.success) {
    if (findings.length === 0) {
      findings.push(`Trace step failed: ${traceResult.message}`);
      if (traceResult.error) {
        findings.push(`Error: ${traceResult.error}`);
      }
      if (traceResult.data?.failurePoint) {
        findings.push(`Failure point: ${traceResult.data.failurePoint}`);
      }
    }
  }

  // Generate next steps
  const nextSteps: string[] = [];
  const failurePoint = analysisResult?.data?.failurePoint || traceResult?.data?.failurePoint;
  if (failurePoint) {
    if (failurePoint.includes('Entry Order')) {
      nextSteps.push('/check-balance');
      nextSteps.push('/query-loggly "Bybit API error" timeframe:10');
    }
  }

  await workflowContext.db.close();

  return {
    success: result.success,
    message: result.success 
      ? 'Investigation completed successfully'
      : 'Investigation completed with failures',
    data: {
      workflowResult: result,
      findings,
      failurePoint
    },
    recommendations,
    nextSteps
  };
}

