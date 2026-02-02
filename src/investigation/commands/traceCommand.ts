/**
 * /trace Command
 * 
 * Traces a message through the entire flow:
 * 1. Message storage
 * 2. Parsing
 * 3. Trade creation
 * 4. Order creation
 * 5. Order execution
 * 
 * Usage: /trace message:<id> [channel:<channel>]
 */

import { CommandContext, CommandResult } from '../commandRegistry.js';
import { traceMessage } from '../../scripts/trace_message.js';
import { logger } from '../../utils/logger.js';

export async function traceCommandHandler(context: CommandContext): Promise<CommandResult> {
  const messageId = context.args.message;
  const channel = context.args.channel as string | undefined;

  if (!messageId) {
    return {
      success: false,
      message: 'Missing required argument: message',
      error: 'Usage: /trace message:<id> [channel:<channel>]',
      recommendations: [
        'Provide message ID: /trace message:12345',
        'Optionally specify channel: /trace message:12345 channel:2394142145'
      ]
    };
  }

  try {
    // Use the existing traceMessage function
    // Note: traceMessage manages its own database connection
    const traceResult = await traceMessage(
      String(messageId),
      channel
    );

    // Format results for command output
    const findings: string[] = [];
    const recommendations: string[] = [...traceResult.recommendations];
    const nextSteps: string[] = [];

    // Analyze trace results
    for (const step of traceResult.steps) {
      if (step.status === 'failure') {
        findings.push(`❌ ${step.step}: ${step.error || 'Failed'}`);
      } else if (step.status === 'success') {
        findings.push(`✅ ${step.step}`);
      }
    }

    // Generate next steps based on failure point
    if (traceResult.failurePoint) {
      if (traceResult.failurePoint.includes('Entry Order')) {
        nextSteps.push('/check-logs message:' + messageId + ' timeframe:5');
        nextSteps.push('/analyze trade:' + traceResult.steps.find(s => s.step.includes('Trade'))?.details?.trades?.[0]?.id);
      } else if (traceResult.failurePoint.includes('Parsing')) {
        nextSteps.push('/verify-parser message:' + messageId);
      } else if (traceResult.failurePoint.includes('Trade Creation')) {
        nextSteps.push('/check-logs message:' + messageId + ' timeframe:10');
      }
    }

    return {
      success: !traceResult.failurePoint,
      message: traceResult.failurePoint 
        ? `Trace completed. Failure point: ${traceResult.failurePoint}`
        : 'Trace completed successfully - all steps passed',
      data: {
        traceResult,
        failurePoint: traceResult.failurePoint,
        findings
      },
      recommendations,
      nextSteps
    };
  } catch (error) {
    logger.error('Error in trace command', {
      messageId,
      channel,
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      success: false,
      message: 'Failed to trace message',
      error: error instanceof Error ? error.message : String(error),
      recommendations: [
        'Verify message ID is correct',
        'Check database connection',
        'Try: /investigate message:' + messageId + ' for guided investigation'
      ]
    };
  }
}

