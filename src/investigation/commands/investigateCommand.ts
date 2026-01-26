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
    messageId: typeof messageId === 'number' ? messageId : parseInt(String(messageId)),
    channel
  });

  const engine = new WorkflowEngine(workflowContext);

  // Step 1: Trace message through system
  engine.addStep({
    id: 'trace',
    name: 'Trace Message Through System',
    required: true,
    execute: async (ctx) => {
      const msgId = ctx.args.messageId;
      const ch = ctx.args.channel;
      
      const traceResult = await traceMessage(msgId, ch);
      
      return {
        success: !traceResult.failurePoint,
        message: traceResult.failurePoint 
          ? `Trace found failure at: ${traceResult.failurePoint}`
          : 'Trace completed - all steps passed',
        data: traceResult
      };
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

  // Step 3: Analyze findings
  engine.addStep({
    id: 'analyze',
    name: 'Analyze Findings',
    required: true,
    execute: async (ctx) => {
      const traceResult = ctx.stepResults.get('trace')?.data;
      const logglyData = ctx.stepResults.get('loggly')?.data;

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
  const findings = analysisResult?.data?.findings || [];
  const recommendations = analysisResult?.data?.recommendations || [];

  // Generate next steps
  const nextSteps: string[] = [];
  if (analysisResult?.data?.failurePoint) {
    if (analysisResult.data.failurePoint.includes('Entry Order')) {
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
      failurePoint: analysisResult?.data?.failurePoint
    },
    recommendations,
    nextSteps
  };
}

