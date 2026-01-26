/**
 * /check-logs Command
 * 
 * Query Loggly for logs related to a message or time period.
 * 
 * Usage: 
 *   /check-logs message:<id> [timeframe:<minutes>]
 *   /check-logs query:"<loggly_query>" [from:<time>] [until:<time>]
 */

import { CommandContext, CommandResult } from '../commandRegistry.js';
import { logger } from '../../utils/logger.js';

export async function checkLogsCommandHandler(context: CommandContext): Promise<CommandResult> {
  const messageId = context.args.message;
  const query = context.args.query as string | undefined;
  const timeframe = context.args.timeframe ? parseInt(String(context.args.timeframe)) : 10;
  const from = context.args.from as string | undefined;
  const until = context.args.until as string | undefined;

  if (!context.logglyClient) {
    return {
      success: false,
      message: 'Loggly client not available',
      error: 'Set LOGGLY_SUBDOMAIN and LOGGLY_API_TOKEN environment variables',
      recommendations: [
        'Configure Loggly credentials in .env file',
        'See docs/LOGGLY_SETUP.md for setup instructions'
      ]
    };
  }

  try {
    if (messageId) {
      // Query by message ID
      const channel = context.args.channel as string | undefined;
      if (!channel) {
        return {
          success: false,
          message: 'Channel required when querying by message ID',
          error: 'Usage: /check-logs message:<id> channel:<channel> [timeframe:<minutes>]'
        };
      }

      const msgId = typeof messageId === 'number' ? messageId : parseInt(String(messageId));
      const timestamp = context.args.timestamp as string || new Date().toISOString();
      const fromTime = new Date(new Date(timestamp).getTime() - timeframe * 60 * 1000).toISOString();
      const untilTime = new Date(new Date(timestamp).getTime() + timeframe * 60 * 1000).toISOString();

      const result = await context.logglyClient.searchByMessageId(msgId, channel, {
        from: fromTime,
        until: untilTime
      });

      // Also search for errors around that time
      const errorLogs = await context.logglyClient.searchErrorsAroundTime(timestamp, timeframe);

      return {
        success: true,
        message: `Found ${result.total_events} message logs and ${errorLogs.total_events} errors`,
        data: {
          messageLogs: result,
          errorLogs,
          timeframe,
          timestamp
        },
        recommendations: result.total_events === 0 
          ? ['No logs found - check message ID and timeframe']
          : ['Review error logs for related issues']
      };
    } else if (query) {
      // Direct query
      const result = await context.logglyClient.search({
        query,
        from,
        until,
        size: 100
      });

      return {
        success: true,
        message: `Found ${result.total_events} log entries`,
        data: {
          logs: result,
          query
        }
      };
    } else {
      return {
        success: false,
        message: 'Missing required argument',
        error: 'Usage: /check-logs message:<id> [timeframe:<minutes>] OR /check-logs query:"<query>"',
        recommendations: [
          'Query by message: /check-logs message:12345 channel:2394142145',
          'Direct query: /check-logs query:"level:error AND channel:2394142145"'
        ]
      };
    }
  } catch (error) {
    logger.error('Error in check-logs command', {
      error: error instanceof Error ? error.message : String(error)
    });

    return {
      success: false,
      message: 'Failed to query Loggly',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

