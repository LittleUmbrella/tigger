import { registerInitiator } from './initiatorRegistry.js';
import { bybitInitiator } from './bybitInitiator.js';
import { evaluationInitiator } from './evaluationInitiator.js';
import { ctraderInitiator } from './ctraderInitiator.js';

// Register built-in initiators
registerInitiator('bybit', bybitInitiator);
registerInitiator('evaluation', evaluationInitiator);
registerInitiator('ctrader', ctraderInitiator);
// Keep backward compatibility with 'dex' name (even though not implemented yet)
// registerInitiator('dex', dexInitiator); // Future implementation

