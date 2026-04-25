import { registerStrategy } from './strategyRegistry.js';
import { startNoopStrategy } from './noopStrategy.js';
import { startBybitTickerStrategy } from './bybitPublicTickerPoll.js';

registerStrategy('noop', startNoopStrategy);
registerStrategy('bybit_ticker', startBybitTickerStrategy);

export {
  registerStrategy,
  getStrategy,
  getRegisteredStrategyNames,
  type StrategyContext,
  type StrategyStartFn,
  type StrategyStopFn
} from './strategyRegistry.js';
export { initiateFromStrategy } from '../initiators/signalInitiator.js';
