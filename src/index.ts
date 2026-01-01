#!/usr/bin/env node

import 'dotenv/config';
import fs from 'fs-extra';
import http from 'http';
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

// Start health check server first so it's available even if orchestrator fails
const port = process.env.PORT ? Number(process.env.PORT) : 8080;

const server = http.createServer(
  (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.end('OK');
  }
);

server.listen(port, () => {
  logger.info('Health check server started', { port });
});

// Handle unhandled promise rejections to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack
  });
  // Don't exit immediately - let the health check server continue
});

// Start orchestrator (errors are handled within, so it won't crash the app)
let stopOrchestrator: (() => Promise<void>) | null = null;
try {
  stopOrchestrator = await startTradeOrchestrator(config);
  logger.info('Orchestrator started successfully');
} catch (error) {
  logger.error('Failed to start orchestrator', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  // Don't exit - health check server should continue running
  // This allows the deployment platform to see the app is running even if harvesters fail
}

// Handle graceful shutdown
const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  // Close HTTP server first (stops accepting new connections)
  server.close(() => {
    logger.info('HTTP server closed');
  });
  
  // Stop orchestrator (which will stop all harvesters and disconnect Telegram clients)
  if (stopOrchestrator) {
    try {
      // Add timeout to ensure shutdown completes even if it hangs
      await Promise.race([
        stopOrchestrator(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            logger.warn('Orchestrator shutdown timeout, forcing exit', {
              timeout: 15000
            });
            resolve();
          }, 15000); // 15 second timeout for full shutdown
        })
      ]);
      logger.info('Graceful shutdown completed');
    } catch (error) {
      logger.error('Error during graceful shutdown', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  // Give a small delay to ensure all disconnect operations complete
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  process.exit(0);
};

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch(error => {
    logger.error('Error in SIGINT handler', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch(error => {
    logger.error('Error in SIGTERM handler', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
});
