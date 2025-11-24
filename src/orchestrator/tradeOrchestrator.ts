import { BotConfig } from '../types/config.js';
import { DatabaseManager, Message } from '../db/schema.js';
import { startSignalHarvester } from '../harvesters/signalHarvester.js';
import { startCSVHarvester } from '../harvesters/csvHarvester.js';
import { parseUnparsedMessages, parseMessage } from '../parsers/signalParser.js';
import { processUnparsedMessages } from '../initiators/signalInitiator.js';
import { startTradeMonitor } from '../monitors/tradeMonitor.js';
import { logger } from '../utils/logger.js';
import { HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { registerParser } from '../parsers/parserRegistry.js';
import { emojiHeavyParser } from '../parsers/emojiHeavyParser.js';
import dayjs from 'dayjs';

// Register built-in parsers
registerParser('emoji_heavy', emojiHeavyParser);

interface OrchestratorState {
  stopHarvesters: (() => Promise<void>)[];
  stopMonitors: (() => Promise<void>)[];
  parserInterval?: NodeJS.Timeout;
  initiatorInterval?: NodeJS.Timeout;
  running: boolean;
}

export const startTradeOrchestrator = async (
  config: BotConfig
): Promise<() => Promise<void>> => {
  const isSimulation = config.simulation?.enabled || false;
  logger.info('Starting trade orchestrator', { simulation: isSimulation });
  
  const db = new DatabaseManager(config.database?.path);
  const state: OrchestratorState = {
    stopHarvesters: [],
    stopMonitors: [],
    running: true
  };

  // Initialize historical price provider if in simulation mode
  let priceProvider: HistoricalPriceProvider | undefined;
  if (isSimulation) {
    const startDate = config.simulation?.startDate || new Date().toISOString();
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    
    priceProvider = new HistoricalPriceProvider(
      startDate,
      config.simulation?.speedMultiplier || 1.0,
      apiKey,
      apiSecret
    );
    logger.info('Historical price provider initialized', {
      startDate,
      speedMultiplier: config.simulation?.speedMultiplier || 1.0
    });
  }

  // Create lookup maps for harvesters, parsers, initiators, and monitors
  const harvesterMap = new Map(config.harvesters.map(h => [h.name, h]));
  const parserMap = new Map(config.parsers.map(p => [p.name, p]));
  const initiatorMap = new Map(config.initiators.map(i => [i.type, i]));
  const monitorMap = new Map(config.monitors.map(m => [m.type, m]));

  // Start all channel sets
  for (const channelConfig of config.channels) {
    try {
      // Resolve harvester
      const harvester = harvesterMap.get(channelConfig.harvester);
      if (!harvester) {
        logger.error('Harvester not found', {
          channel: channelConfig.channel,
          harvesterName: channelConfig.harvester
        });
        continue;
      }

      // Resolve parser
      const parser = parserMap.get(channelConfig.parser);
      if (!parser) {
        logger.error('Parser not found', {
          channel: channelConfig.channel,
          parserName: channelConfig.parser
        });
        continue;
      }

      // Resolve initiator
      const initiator = initiatorMap.get(channelConfig.initiator);
      if (!initiator) {
        logger.error('Initiator not found', {
          channel: channelConfig.channel,
          initiatorType: channelConfig.initiator
        });
        continue;
      }

      // Resolve monitor
      const monitor = monitorMap.get(channelConfig.monitor);
      if (!monitor) {
        logger.error('Monitor not found', {
          channel: channelConfig.channel,
          monitorType: channelConfig.monitor
        });
        continue;
      }

      // Start harvester for this channel
      let stopHarvester: () => Promise<void>;
      if (isSimulation && config.simulation?.messagesFile) {
        // Use CSV harvester in simulation mode
        stopHarvester = await startCSVHarvester(config.simulation.messagesFile, channelConfig.channel, db);
      } else {
        // Use Telegram harvester in live mode
        stopHarvester = await startSignalHarvester(harvester, db);
      }
      state.stopHarvesters.push(stopHarvester);

      // Start monitor for this channel
      const stopMonitor = await startTradeMonitor(monitor, channelConfig.channel, db, isSimulation, priceProvider);
      state.stopMonitors.push(stopMonitor);

      logger.info('Started channel set', {
        channel: channelConfig.channel,
        harvester: harvester.name,
        parser: parser.name,
        initiator: initiator.type,
        monitor: monitor.type
      });
    } catch (error) {
      logger.error('Failed to start channel set', {
        channel: channelConfig.channel,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // In simulation mode, process messages chronologically
  if (isSimulation && priceProvider) {
    // Process messages in chronological order based on their timestamps
    const processSimulationMessages = async () => {
      for (const channelConfig of config.channels) {
        const parser = parserMap.get(channelConfig.parser);
        if (!parser) continue;

        // Get unparsed messages ordered by date
        const messages = db.getUnparsedMessages(parser.channel);
        const sortedMessages = [...messages].sort((a, b) => {
          const dateA = new Date(a.date).getTime();
          const dateB = new Date(b.date).getTime();
          return dateA - dateB;
        });

        for (const message of sortedMessages) {
          if (!state.running) break;
          
          const messageTime = dayjs(message.date);
          // Set simulation time to message time
          priceProvider.setCurrentTime(messageTime);
          
            try {
              // Parse the message using the configured parser
              const parsed = parseMessage(message.content, parser.name);
              if (parsed) {
                db.markMessageParsed(message.id);
                logger.info('Parsed message in simulation', {
                  channel: channelConfig.channel,
                  parserName: parser.name,
                  messageId: message.message_id,
                  tradingPair: parsed.tradingPair,
                  messageTime: messageTime.toISOString()
                });
              } else {
                db.markMessageParsed(message.id);
              }
            
            // Small delay to allow processing
            await new Promise(resolve => setTimeout(resolve, 10));
          } catch (error) {
            logger.error('Error processing simulation message', {
              channel: channelConfig.channel,
              messageId: message.message_id,
              error: error instanceof Error ? error.message : String(error)
            });
            db.markMessageParsed(message.id); // Mark as parsed to avoid infinite retry
          }
        }
      }
    };

    // Start processing messages
    processSimulationMessages().catch(error => {
      logger.error('Error in simulation message processing', {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  } else {
    // Live mode: Start parser loop (runs periodically to parse new messages)
    state.parserInterval = setInterval(() => {
      if (!state.running) return;
      
      for (const channelConfig of config.channels) {
        const parser = parserMap.get(channelConfig.parser);
        if (parser) {
          parseUnparsedMessages(parser, db).catch(error => {
            logger.error('Parser error', {
              channel: channelConfig.channel,
              parserName: parser.name,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
      }
    }, 5000); // Parse every 5 seconds
  }

  // In simulation mode, advance time for monitoring
  let simulationTimeInterval: NodeJS.Timeout | undefined;
  if (isSimulation && priceProvider) {
    const pollInterval = config.monitors[0]?.pollInterval || 10000;
    simulationTimeInterval = setInterval(() => {
      if (!state.running) return;
      // Advance simulation time by poll interval
      priceProvider.advanceTime(pollInterval);
      const currentTime = priceProvider.getCurrentTime();
      logger.debug('Simulation time advanced', { 
        currentTime: currentTime.toISOString() 
      });
    }, 100); // Advance time every 100ms for smooth simulation
  }

  // Start initiator loop
  if (isSimulation && priceProvider) {
    // In simulation mode, process all messages once in chronological order
    const processSimulationTrades = async () => {
      for (const channelConfig of config.channels) {
        const initiator = initiatorMap.get(channelConfig.initiator);
        const monitor = monitorMap.get(channelConfig.monitor);
        
        if (!initiator) {
          logger.error('Initiator not found for channel', {
            channel: channelConfig.channel,
            initiatorType: channelConfig.initiator
          });
          continue;
        }
        
        const entryTimeoutDays = monitor?.entryTimeoutDays || 2;
        
        // Process all unparsed messages (they will be sorted chronologically in processUnparsedMessages)
        await processUnparsedMessages(
          initiator,
          channelConfig.channel,
          entryTimeoutDays,
          db,
          isSimulation,
          priceProvider,
          channelConfig.parser // Pass parser name to initiator
        );
      }
    };

    // Process trades after a short delay to allow messages to be loaded
    setTimeout(() => {
      processSimulationTrades().catch(error => {
        logger.error('Error processing simulation trades', {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, 2000);
  } else {
    // Live mode: Start initiator loop (runs periodically to initiate trades from parsed messages)
    state.initiatorInterval = setInterval(() => {
      if (!state.running) return;
      
      for (const channelConfig of config.channels) {
        const initiator = initiatorMap.get(channelConfig.initiator);
        const monitor = monitorMap.get(channelConfig.monitor);
        
        if (!initiator) {
          logger.error('Initiator not found for channel', {
            channel: channelConfig.channel,
            initiatorType: channelConfig.initiator
          });
          continue;
        }
        
        const entryTimeoutDays = monitor?.entryTimeoutDays || 2;
        
        processUnparsedMessages(
          initiator,
          channelConfig.channel,
          entryTimeoutDays,
          db,
          isSimulation,
          priceProvider,
          channelConfig.parser // Pass parser name to initiator
        ).catch(error => {
          logger.error('Initiator error', {
            channel: channelConfig.channel,
            initiatorType: initiator.type,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }, 10000); // Initiate every 10 seconds
  }

  logger.info('Trade orchestrator started', {
    channels: config.channels.length,
    harvesters: config.harvesters.length,
    parsers: config.parsers.length,
    initiators: config.initiators.length,
    monitors: config.monitors.length
  });

  // Return stop function
  return async (): Promise<void> => {
    logger.info('Stopping trade orchestrator');
    state.running = false;

    if (state.parserInterval) {
      clearInterval(state.parserInterval);
    }
    if (state.initiatorInterval) {
      clearInterval(state.initiatorInterval);
    }
    if (simulationTimeInterval) {
      clearInterval(simulationTimeInterval);
    }

    // Stop all harvesters
    for (const stopHarvester of state.stopHarvesters) {
      try {
        await stopHarvester();
      } catch (error) {
        logger.error('Error stopping harvester', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Stop all monitors
    for (const stopMonitor of state.stopMonitors) {
      try {
        await stopMonitor();
      } catch (error) {
        logger.error('Error stopping monitor', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    db.close();
    logger.info('Trade orchestrator stopped');
  };
};
