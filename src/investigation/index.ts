/**
 * Investigation Commands
 * 
 * Slash command system for investigation workflows.
 * Provides structured, guided investigation of message flow and order execution.
 */

import { commandRegistry } from './commandRegistry.js';
import { traceCommandHandler } from './commands/traceCommand.js';
import { investigateCommandHandler } from './commands/investigateCommand.js';
import { analyzeCommandHandler } from './commands/analyzeCommand.js';
import { checkLogsCommandHandler } from './commands/checkLogsCommand.js';

// Register all commands
commandRegistry.register(
  'trace',
  traceCommandHandler,
  'Trace a message through the entire flow from receipt to order execution',
  [
    '/trace message:12345',
    '/trace message:12345 channel:2394142145'
  ]
);

commandRegistry.register(
  'investigate',
  investigateCommandHandler,
  'Full guided investigation: gathers all data, analyzes, and provides recommendations',
  [
    '/investigate message:12345',
    '/investigate message:12345 channel:2394142145'
  ]
);

commandRegistry.register(
  'analyze',
  analyzeCommandHandler,
  'Deep analysis of a specific trade',
  [
    '/analyze trade:123'
  ]
);

commandRegistry.register(
  'check-logs',
  checkLogsCommandHandler,
  'Query Loggly for logs related to a message or custom query',
  [
    '/check-logs message:12345 channel:2394142145',
    '/check-logs message:12345 channel:2394142145 timeframe:5',
    '/check-logs query:"level:error AND channel:2394142145"'
  ]
);

export * from './commandRegistry.js';
export * from './commandParser.js';
export * from './workflowEngine.js';
export { commandRegistry };

