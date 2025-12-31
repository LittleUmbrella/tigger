#!/usr/bin/env node

import 'dotenv/config';
import fs from 'fs-extra';
import { BotConfig } from './types/config.js';
import { startTradeOrchestrator } from './orchestrator/tradeOrchestrator.js';
import { logger } from './utils/logger.js';

// Ensure logs directory exists
await fs.ensureDir('logs');

// Load configuration
const configPath = process.env.CONFIG_PATH || 'config.json';

// If CONFIG_JSON environment variable is set, write it to config.json
// This is useful for cloud deployments (e.g., DigitalOcean App Platform)
if (process.env.CONFIG_JSON && !fs.existsSync(configPath)) {
  try {
    await fs.writeFile(configPath, process.env.CONFIG_JSON, 'utf-8');
    logger.info('Configuration file created from CONFIG_JSON environment variable', {
      path: configPath
    });
  } catch (error) {
    logger.error('Failed to write configuration from CONFIG_JSON', {
      path: configPath,
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

if (!fs.existsSync(configPath)) {
  logger.error('Configuration file not found', { 
    path: configPath,
    hint: 'Set CONFIG_JSON environment variable or ensure config.json exists'
  });
  process.exit(1);
}

let config: BotConfig;
try {
  const configContent = await fs.readFile(configPath, 'utf-8');
  config = JSON.parse(configContent);
} catch (error) {
  logger.error('Failed to load configuration', {
    path: configPath,
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
}

// Validate configuration
if (!config.channels || !Array.isArray(config.channels) || config.channels.length === 0) {
  logger.error('Configuration must have at least one channel set');
  process.exit(1);
}

logger.info('Configuration loaded', {
  channels: config.channels.length
});

// Start orchestrator
const stopOrchestrator = await startTradeOrchestrator(config);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await stopOrchestrator();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  await stopOrchestrator();
  process.exit(0);
});
