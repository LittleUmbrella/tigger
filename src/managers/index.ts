import { registerManager } from './managerRegistry.js';
import { closeAllLongsManager } from './closeAllLongsManager.js';
import { closeAllShortsManager } from './closeAllShortsManager.js';
import { closeAllTradesManager } from './closeAllTradesManager.js';
import { closePositionManager } from './closePositionManager.js';
import { closePercentageManager } from './closePercentageManager.js';
import { updateEntryManager } from './updateEntryManager.js';
import { updateStopLossManager } from './updateStopLossManager.js';
import { updateTakeProfitsManager } from './updateTakeProfitsManager.js';

// Register all built-in managers
registerManager('close_all_longs', closeAllLongsManager);
registerManager('close_all_shorts', closeAllShortsManager);
registerManager('close_all_trades', closeAllTradesManager);
registerManager('close_position', closePositionManager);
registerManager('close_percentage', closePercentageManager);
registerManager('update_entry', updateEntryManager);
registerManager('update_stop_loss', updateStopLossManager);
registerManager('update_take_profits', updateTakeProfitsManager);

export * from './managerRegistry.js';
export * from './managementParser.js';
export * from './closeAllLongsManager.js';
export * from './closeAllShortsManager.js';
export * from './closeAllTradesManager.js';
export * from './closePositionManager.js';
export * from './closePercentageManager.js';

