/**
 * /query-bybit-day Command
 *
 * Exchange-side execution list + closed PnL for one UTC day (demo accounts in env).
 * Complements /investigate when Loggly is empty or trace time range hits Bybit's 7-day API limit.
 *
 * Usage:
 *   /query-bybit-day day:2026-03-13
 *   /query-bybit-day day:2026-03-13 symbol:BTCUSDT
 */

import { CommandContext, CommandResult } from '../commandRegistry.js';
import { runQueryBybitDayWindow } from '../utils/queryBybitDayWindow.js';

export async function queryBybitDayCommandHandler(context: CommandContext): Promise<CommandResult> {
  const dayRaw = context.args.day;
  const day =
    dayRaw != null && String(dayRaw).trim() !== '' ? String(dayRaw) : '2026-03-13';
  const symbolArg = context.args.symbol;
  const symbol =
    symbolArg != null && String(symbolArg).trim() !== ''
      ? String(symbolArg)
      : undefined;

  try {
    const data = await runQueryBybitDayWindow({ day, symbol });
    const queried = data.accounts.filter((a) => !a.skipped);
    const withExec = queried.filter((a) => (a.executionCount ?? 0) > 0);

    return {
      success: true,
      message: `Bybit day window ${data.day} ${data.symbol}: ${queried.length} account(s) queried, ${withExec.length} with executions`,
      data,
      recommendations:
        withExec.length === 0 && queried.length > 0
          ? [
              'No executions in window — check day (UTC), symbol, or that trades used these demo API keys',
            ]
          : undefined,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to query Bybit day window',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
