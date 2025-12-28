import { registerInitiator } from './initiatorRegistry.js';
import { bybitInitiator } from './bybitInitiator.js';
import { evaluationInitiator } from './evaluationInitiator.js';

// Register built-in initiators
registerInitiator('bybit', bybitInitiator);
registerInitiator('evaluation', evaluationInitiator);
// Keep backward compatibility with 'dex' name (even though not implemented yet)
// registerInitiator('dex', dexInitiator); // Future implementation

