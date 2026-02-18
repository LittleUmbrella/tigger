/**
 * /investigate Command
 * 
 * Full guided investigation workflow:
 * 1. Gather all data (database, Loggly, Bybit)
 * 2. Cross-check Loggly for order placement (catches trace-vs-logs mismatch)
 * 3. Analyze findings
 * 4. Identify root cause
 * 5. Provide recommendations
 * 
 * Usage: /investigate message:<id> [channel:<channel>]
 */

import { CommandContext, CommandResult } from '../commandRegistry.js';
import { WorkflowEngine, WorkflowStep, createWorkflowContext } from '../workflowEngine.js';
import { logger } from '../../utils/logger.js';
import { traceMessage } from '../../scripts/trace_message.js';
import { queryBybitOrdersForMessage } from '../utils/bybitOrderQuery.js';
import { getGoldPriceComparison } from '../utils/goldPriceCheck.js';
import { validateBybitSymbol } from '../../initiators/symbolValidator.js';

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
      const timeRange = {
        from: new Date(new Date(timestamp).getTime() - windowMinutes * 60 * 1000).toISOString(),
        until: new Date(new Date(timestamp).getTime() + windowMinutes * 60 * 1000).toISOString()
      };

      try {
        // Query for message-specific logs (confirms flow: parsed, initiated, etc.)
        const messageLogs = await ctx.logglyClient!.searchByMessageId(
          messageId,
          channel || '',
          timeRange
        );

        // Query for errors scoped to this message (confirms root cause)
        const messageScopedErrors = await ctx.logglyClient!.searchErrorsAroundTime(
          timestamp,
          windowMinutes,
          `messageId:${messageId} AND channel:${channel || ''}`
        );

        // Query for general errors around that time (fallback if scoped returns nothing)
        const errorLogs = await ctx.logglyClient!.searchErrorsAroundTime(
          timestamp,
          windowMinutes
        );

        // Query for Bybit API errors in the time window
        const bybitErrors = await ctx.logglyClient!.searchBybitErrors(timeRange);

        return {
          success: true,
          message: `Found ${messageLogs.total_events} message logs, ${messageScopedErrors.total_events} message-scoped errors, ${bybitErrors.total_events} Bybit errors`,
          data: {
            messageLogs,
            messageScopedErrors,
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

  // Step 2b: Cross-check Loggly for order placement (catches trace-vs-logs mismatch)
  engine.addStep({
    id: 'logglyOrderPlacementCheck',
    name: 'Cross-check: Bybit Order Placement & Errors',
    required: false,
    execute: async (ctx) => {
      if (!ctx.logglyClient) {
        return {
          success: true,
          message: 'Loggly client not available - skipping order placement cross-check',
          data: { skipped: true }
        };
      }

      const traceResult = ctx.stepResults.get('trace')?.data;
      const logglyData = ctx.stepResults.get('loggly')?.data;
      const messageId = ctx.args.messageId;
      const channel = ctx.args.channel;

      if (!traceResult) {
        return { success: false, message: 'Trace step must complete first' };
      }

      const timestamp = traceResult.steps[0]?.timestamp || traceResult.steps[0]?.details?.date || new Date().toISOString();
      const windowMinutes = 15;
      const timeRange = {
        from: new Date(new Date(timestamp).getTime() - windowMinutes * 60 * 1000).toISOString(),
        until: new Date(new Date(timestamp).getTime() + windowMinutes * 60 * 1000).toISOString()
      };

      try {
        // Query for message + order/trade activity (order placement evidence)
        const orderPlacementQuery = channel
          ? `messageId:${messageId} AND channel:${channel} AND (order OR bybit OR trade)`
          : `messageId:${messageId} AND (order OR bybit OR trade)`;

        const orderPlacementLogs = await ctx.logglyClient!.search({
          query: orderPlacementQuery,
          from: timeRange.from,
          until: timeRange.until,
          size: 100
        });

        // Query for Bybit API errors in window
        const bybitErrors = await ctx.logglyClient!.searchBybitErrors(timeRange);

        // Query for order creation failures in window
        const orderFailures = await ctx.logglyClient!.searchOrderFailures(timeRange, undefined);

        const events = orderPlacementLogs.events || [];
        const successIndicators = [
          'Order placed successfully',
          'Trade initiated successfully',
          'Trade stored in database',
          'Limit order placed',
          'Trade initiation completed for all accounts'
        ];

        const foundSuccessLogs = events.filter((e: any) => {
          const msg = e.event?.message || e.event?.json?.message || e.logmsg || '';
          return successIndicators.some((ind) => msg.includes(ind));
        });

        const failurePoint = traceResult.failurePoint;
        const contradictionWithTrace =
          !!failurePoint &&
          foundSuccessLogs.length > 0 &&
          (failurePoint.includes('Parsing') || failurePoint.includes('Trade Creation'));

        return {
          success: true,
          message: foundSuccessLogs.length > 0
            ? `Found ${foundSuccessLogs.length} order placement log(s)${contradictionWithTrace ? ' - CONTRADICTS trace' : ''}`
            : `No order placement evidence in logs (${events.length} order-related logs)`,
          data: {
            orderPlacementLogCount: foundSuccessLogs.length,
            bybitErrorCount: bybitErrors.events?.length || 0,
            orderFailureCount: orderFailures.events?.length || 0,
            contradictionWithTrace,
            sampleSuccessLogs: foundSuccessLogs.slice(0, 3).map((e: any) => ({
              message: e.event?.message || e.event?.json?.message || e.logmsg || ''
            }))
          }
        };
      } catch (error) {
        logger.error('Error in order placement cross-check', {
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          success: false,
          message: 'Failed to cross-check order placement',
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

  // Step 4: Symbol validation (when Trade Creation failed - rule out invalid symbol)
  engine.addStep({
    id: 'symbolValidation',
    name: 'Validate Symbol on Bybit',
    required: false,
    execute: async (ctx) => {
      const traceResult = ctx.stepResults.get('trace')?.data;

      if (!traceResult) {
        return {
          success: false,
          message: 'Trace step must complete first'
        };
      }

      const failurePoint = traceResult.failurePoint;
      const tradeCreationStep = traceResult.steps?.find((s: any) => s.step?.includes('Trade Creation'));
      const parsingStep = traceResult.steps?.find((s: any) => s.step?.includes('Parsing'));

      if (failurePoint !== 'Trade Creation' || !parsingStep?.details?.tradingPair) {
        return {
          success: true,
          message: 'Not applicable - Trade Creation did not fail or no parsed trading pair',
          data: { skipped: true }
        };
      }

      const tradingPair = parsingStep.details.tradingPair;
      const symbolToValidate = tradingPair.replace('/', '').toUpperCase();
      const symbol = symbolToValidate.endsWith('USDT') || symbolToValidate.endsWith('USDC')
        ? symbolToValidate
        : `${symbolToValidate}USDT`;

      if (!ctx.getBybitClient) {
        return {
          success: false,
          message: 'Bybit client not available for symbol validation'
        };
      }

      try {
        const bybitClient = await ctx.getBybitClient();
        if (!bybitClient) {
          return {
            success: false,
            message: 'Could not create Bybit client for symbol validation'
          };
        }

        const validation = await validateBybitSymbol(bybitClient, symbol);

        return {
          success: true,
          message: validation.valid
            ? `Symbol ${symbol} is valid and trading on Bybit`
            : `Symbol validation failed: ${validation.error}`,
          data: {
            symbol,
            valid: validation.valid,
            actualSymbol: validation.actualSymbol,
            error: validation.error
          }
        };
      } catch (error) {
        logger.error('Symbol validation error', {
          symbol,
          error: error instanceof Error ? error.message : String(error)
        });
        return {
          success: false,
          message: 'Symbol validation failed',
          error: error instanceof Error ? error.message : String(error),
          data: { symbol }
        };
      }
    }
  });

  // Step 5: Check gold/XAUT prices for XAUT trades
  engine.addStep({
    id: 'goldPriceCheck',
    name: 'Check Gold/XAUT Prices (XAUT trades only)',
    required: false,
    execute: async (ctx) => {
      const traceResult = ctx.stepResults.get('trace')?.data;
      
      if (!traceResult) {
        return {
          success: false,
          message: 'Trace step must complete first'
        };
      }

      // Check if this is a XAUT trade
      const parsingStep = traceResult.steps?.find((s: any) => s.step.includes('Parsing'));
      const tradingPair = parsingStep?.details?.tradingPair;
      
      if (!tradingPair || (!tradingPair.toUpperCase().includes('XAUT') && tradingPair.toUpperCase() !== 'GOLD')) {
        return {
          success: true,
          message: 'Not a XAUT/Gold trade - skipping gold price check',
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

      // Use the entry order filled_at timestamp (when the order was actually filled)
      // This gives the price at the time the position was actually opened
      // Find all entry order steps and use the latest one (in case of multiple trades)
      const entryOrderSteps = traceResult.steps?.filter((s: any) => 
        s.step.includes('Entry Order Creation') && s.details?.entryFilledAt
      ) || [];
      
      let entryTimestamp: string | undefined;
      if (entryOrderSteps.length > 0) {
        // Sort by entryFilledAt timestamp and use the latest one
        entryOrderSteps.sort((a: any, b: any) => {
          const timeA = new Date(a.details.entryFilledAt).getTime();
          const timeB = new Date(b.details.entryFilledAt).getTime();
          return timeB - timeA; // Latest first
        });
        entryTimestamp = entryOrderSteps[0].details.entryFilledAt;
      } else {
        // Fallback to message timestamp if entryFilledAt is not available
        const messageStep = traceResult.steps?.find((s: any) => s.step.includes('Message Storage'));
        entryTimestamp = messageStep?.details?.date || messageStep?.timestamp || traceResult.steps[0]?.timestamp;
      }
      
      const firstTrade = trades[0];
      
      if (!entryTimestamp) {
        return {
          success: false,
          message: 'Could not determine entry timestamp'
        };
      }

      // Get XAUT entry price from parsing or trade
      const xautPrice = parsingStep?.details?.entryPrice || firstTrade.entryPrice;

      try {
        const bybitClient = await ctx.getBybitClient?.(firstTrade.accountName);
        const comparison = await getGoldPriceComparison(
          bybitClient,
          new Date(entryTimestamp),
          xautPrice
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

  // Step 6: Analyze findings
  engine.addStep({
    id: 'analyze',
    name: 'Analyze Findings',
    required: true,
    execute: async (ctx) => {
      const traceResult = ctx.stepResults.get('trace')?.data;
      const logglyData = ctx.stepResults.get('loggly')?.data;
      const orderPlacementData = ctx.stepResults.get('logglyOrderPlacementCheck')?.data;
      const orderData = ctx.stepResults.get('bybitOrders')?.data;
      const symbolValidationData = ctx.stepResults.get('symbolValidation')?.data;
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

      // Cross-check: Logs contradict trace? (e.g. trace says Parsing failed but logs show orders placed)
      if (orderPlacementData && !orderPlacementData.skipped) {
        if (orderPlacementData.contradictionWithTrace) {
          findings.push('\n⚠️ **Logs contradict trace**: Loggly shows orders were placed successfully');
          findings.push('   The trace may use a different database (e.g. local vs production) or have a bug.');
          findings.push('   Treat logs as source of truth.');
          if (orderPlacementData.sampleSuccessLogs?.length > 0) {
            orderPlacementData.sampleSuccessLogs.forEach((log: any, i: number) => {
              const msg = (log.message || '').substring(0, 200);
              if (msg) findings.push(`   ${i + 1}. ${msg}...`);
            });
          }
        }
        if ((orderPlacementData.bybitErrorCount || 0) > 0) {
          findings.push(`\n📋 Bybit API errors in window: ${orderPlacementData.bybitErrorCount}`);
        }
        if ((orderPlacementData.orderFailureCount || 0) > 0) {
          findings.push(`Order creation failures in window: ${orderPlacementData.orderFailureCount}`);
        }
      }

      // Log confirmation - use logs to confirm root cause when available
      if (logglyData) {
        // Prefer message-scoped errors; fall back to general errors (some logs e.g. "Failed to execute trade" may not include messageId)
        const msgScoped = logglyData.messageScopedErrors?.events || [];
        const allErrors = logglyData.errorLogs?.events || [];
        const channel = ctx.args.channel;
        const msgErrors = msgScoped.length > 0
          ? msgScoped
          : channel ? allErrors.filter((e: any) => {
              const ch = e.event?.channel ?? e.event?.json?.channel;
              return ch === channel || ch === String(channel);
            }) : allErrors;
        const msgLogs = logglyData.messageLogs?.events || [];

        if (msgLogs.length > 0 || msgErrors.length > 0) {
          findings.push('\n📋 Log confirmation:');

          // Trade Creation failure: surface "Failed to execute trade" and "Trade initiation completed"
          if (failurePoint?.includes('Trade Creation')) {
            const failedExecuteLogs = msgErrors.filter((e: any) =>
              e.event?.message?.includes('Failed to execute trade for account') ||
              e.logmsg?.includes('Failed to execute trade')
            );
            const completionLogs = msgLogs.filter((m: any) =>
              m.event?.message?.includes('Trade initiation completed for all accounts') ||
              m.logmsg?.includes('Trade initiation completed')
            );

            if (failedExecuteLogs.length > 0) {
              findings.push(`  Found ${failedExecuteLogs.length} "Failed to execute trade" log(s):`);
              failedExecuteLogs.slice(0, 3).forEach((log: any, i: number) => {
                const err = log.event?.error || log.event?.json?.error || log.logmsg || '';
                const accountName = log.event?.accountName || log.event?.json?.accountName || '';
                const excerpt = err.length > 200 ? err.substring(0, 200) + '...' : err;
                findings.push(`    ${i + 1}. ${accountName}: ${excerpt}`);
              });
            }
            if (completionLogs.length > 0) {
              completionLogs.forEach((log: any) => {
                const json = log.event?.json || log.event || {};
                const success = json.successful ?? json.successfulCount;
                const failed = json.failed ?? json.failedCount;
                if (success === 0 && failed > 0) {
                  findings.push(`  Trade initiation: successful=${success}, failed=${failed} (all accounts failed)`);
                }
              });
            }
          }

          // Entry Order failure: surface Bybit API errors
          if (failurePoint?.includes('Entry Order') && logglyData.bybitErrors?.events?.length > 0) {
            findings.push(`  Found ${logglyData.bybitErrors.events.length} Bybit API error log(s)`);
          }

          if (msgErrors.length > 0 && !failurePoint?.includes('Trade Creation')) {
            findings.push(`  Found ${msgErrors.length} error log(s) for this message`);
          }
        } else {
          findings.push('\n📋 Log confirmation: No logs found for this message (check Loggly config or time range)');
        }
      } else {
        findings.push('\n📋 Log confirmation: Logs not queried (Loggly client unavailable - set LOGGLY_API_TOKEN)');
        recommendations.push('Configure LOGGLY_API_TOKEN and LOGGLY_SUBDOMAIN for log confirmation in investigations');
      }

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

      // Add gold/PAXG price comparison for XAUT trades
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
        }

        if (goldPriceData.error) {
          findings.push(`  ⚠️  ${goldPriceData.error}`);
        }
      }

      // Add symbol validation findings (when Trade Creation failed)
      if (symbolValidationData && !symbolValidationData.skipped) {
        if (symbolValidationData.valid) {
          findings.push(`\n📊 Symbol Validation: ✅ ${symbolValidationData.symbol} exists on Bybit - invalid symbol ruled out`);
          findings.push('   Root cause is likely: prop firm rules, initiator error, or other validation failure');
        } else {
          findings.push(`\n📊 Symbol Validation: ❌ ${symbolValidationData.symbol} - ${symbolValidationData.error || 'not found on Bybit'}`);
          findings.push('   Invalid symbol may explain Trade Creation failure');
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
          // Include full message content so investigators can verify - truncated display leads to incorrect conclusions
          const parsingStep = traceResult.steps?.find((s: any) => s.step?.includes('Parsing'));
          const fullContent = parsingStep?.details?.fullContent;
          if (fullContent) {
            findings.push(`\nFull message content (verify parser against this):\n\`\`\`\n${fullContent}\n\`\`\``);
          }
          if (orderPlacementData?.contradictionWithTrace) {
            recommendations.push('Logs show orders were placed - trace may use different DB. Verify DATABASE_URL.');
          } else {
            recommendations.push('Check parser configuration for this channel');
            recommendations.push('Message may not be a trade signal');
            recommendations.push('Verify: npx tsx src/scripts/query_message.ts <messageId> <channel> then test parser on full content');
          }
        } else if (failurePoint.includes('Trade Creation')) {
          findings.push('Trade was not created in database');
          recommendations.push('Check initiator logs for errors');
          recommendations.push('Verify initiator configuration');
          if (symbolValidationData?.valid) {
            recommendations.push('Symbol validated - investigate prop firm rules, balance, or initiator-specific validation');
          } else if (symbolValidationData && !symbolValidationData.skipped && !symbolValidationData.valid) {
            recommendations.push('Run: npm run validate-symbol <SYMBOL> to confirm symbol status');
          }
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
    } else if (failurePoint.includes('Parsing')) {
      const ch = traceResult?.data?.channel || context.args.channel;
      nextSteps.push(`npx tsx src/scripts/query_message.ts ${context.args.messageId} ${ch || '<channel>'}`);
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

