import { logger } from '../utils/logger.js';
import type { StrategyStartFn } from './strategyRegistry.js';

const DEFAULT_INTERVAL_MS = 60_000;

type TickerOptions = {
  symbol?: string;
  pollIntervalMs?: number;
};

/**
 * Public Bybit v5 market ticker poll (no API keys). Logs last price; does not open trades.
 * Add your own signal logic in a separate strategy, or call {@link insertStrategySignal} from a fork of this.
 */
export const startBybitTickerStrategy: StrategyStartFn = async (ctx) => {
  const opts = (ctx.options || {}) as TickerOptions;
  const symbol = typeof opts.symbol === 'string' ? opts.symbol : 'BTCUSDT';
  const pollIntervalMs =
    typeof opts.pollIntervalMs === 'number' && opts.pollIntervalMs > 0
      ? opts.pollIntervalMs
      : DEFAULT_INTERVAL_MS;

  const tick = async (): Promise<void> => {
    if (!ctx.isRunning()) {
      return;
    }
    try {
      const url = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`;
      const res = await fetch(url);
      const data = (await res.json()) as {
        retCode?: number;
        result?: { list?: Array<{ lastPrice?: string; symbol?: string }> };
      };
      if (data.retCode !== 0) {
        logger.warn('bybit_ticker: non-zero retCode', { channel: ctx.channel, symbol, retCode: data.retCode });
        return;
      }
      const last = data.result?.list?.[0]?.lastPrice;
      logger.debug('bybit_ticker', {
        channel: ctx.channel,
        strategyName: ctx.strategyName,
        symbol,
        lastPrice: last
      });
    } catch (e) {
      logger.warn('bybit_ticker: request failed', {
        channel: ctx.channel,
        symbol,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  };

  const handle = setInterval(() => {
    tick().catch(() => {});
  }, pollIntervalMs);
  await tick();
  return async () => {
    clearInterval(handle);
    logger.info('bybit_ticker stopped', { channel: ctx.channel, symbol });
  };
};
