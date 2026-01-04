import { BotConfig, AccountConfig, MonitorConfig } from '../types/config.js';
import { DatabaseManager, Message } from '../db/schema.js';
import { startSignalHarvester } from '../harvesters/signalHarvester.js';
import { startDiscordHarvester } from '../harvesters/discordHarvester.js';
import { startCSVHarvester } from '../harvesters/csvHarvester.js';
import { parseUnparsedMessages, parseMessage } from '../parsers/signalParser.js';
import { processUnparsedMessages } from '../initiators/signalInitiator.js';
import { startTradeMonitor } from '../monitors/tradeMonitor.js';
import { logger } from '../utils/logger.js';
import { createHistoricalPriceProvider, HistoricalPriceProvider } from '../utils/historicalPriceProvider.js';
import { registerParser } from '../parsers/parserRegistry.js';
import { emojiHeavyParser } from '../parsers/emojiHeavyParser.js';
import '../initiators/index.js'; // Register built-in initiators
import '../managers/index.js'; // Register built-in managers
import { parseManagementCommand, getManager, ManagerContext } from '../managers/index.js';
import { diffOrderWithTrade } from '../managers/orderDiff.js';
import dayjs from 'dayjs';
import { RestClientV5 } from 'bybit-api';
import { vipCryptoSignals } from '../parsers/channels/2427485240/vip-future.js';
import { ronnieCryptoSignals } from '../parsers/channels/3241720654/ronnie-crypto-signals.js';

// Register built-in parsers
registerParser('emoji_heavy', emojiHeavyParser);
registerParser('vip_crypto_signals', vipCryptoSignals);
registerParser('ronnie_crypto_signals', ronnieCryptoSignals);

interface OrchestratorState {
  stopHarvesters: (() => Promise<void>)[];
  stopMonitors: (() => Promise<void>)[];
  parserInterval?: NodeJS.Timeout;
  initiatorInterval?: NodeJS.Timeout;
  managerInterval?: NodeJS.Timeout;
  running: boolean;
}

export const startTradeOrchestrator = async (
  config: BotConfig
): Promise<() => Promise<void>> => {
  const isSimulation = config.simulation?.enabled || false;
  logger.info('Starting trade orchestrator', { simulation: isSimulation });
  
  const db = new DatabaseManager({
    type: config.database?.type,
    path: config.database?.path,
    url: config.database?.url
  });
  await db.initialize();
  const state: OrchestratorState = {
    stopHarvesters: [],
    stopMonitors: [],
    running: true
  };

  // Create account map for easy lookup
  const accountMap = new Map<string, AccountConfig>();
  if (config.accounts) {
    for (const account of config.accounts) {
      accountMap.set(account.name, account);
    }
  }

  // Create Bybit client map for managers (keyed by account name)
  const bybitClientMap = new Map<string, RestClientV5>();
  const createBybitClient = (accountName: string | undefined, testnet: boolean = false): RestClientV5 | undefined => {
    const key = accountName || 'default';
    
    if (bybitClientMap.has(key)) {
      return bybitClientMap.get(key);
    }

    if (isSimulation) {
      return undefined; // No real client needed in simulation
    }

    // Get account config if account name is provided
    let apiKey: string | undefined;
    let apiSecret: string | undefined;
    let useTestnet = testnet;

    if (accountName && accountMap.has(accountName)) {
      const account = accountMap.get(accountName)!;
      // Priority: envVarNames > envVars (backward compat) > apiKey/apiSecret (deprecated) > default env vars
      const envVarNameForKey = account.envVarNames?.apiKey || account.envVars?.apiKey;
      const envVarNameForSecret = account.envVarNames?.apiSecret || account.envVars?.apiSecret;
      apiKey = envVarNameForKey ? process.env[envVarNameForKey] : (account.apiKey || process.env.BYBIT_API_KEY);
      apiSecret = envVarNameForSecret ? process.env[envVarNameForSecret] : (account.apiSecret || process.env.BYBIT_API_SECRET);
      useTestnet = account.testnet || false;
    } else {
      // Fallback to environment variables
      apiKey = process.env.BYBIT_API_KEY;
      apiSecret = process.env.BYBIT_API_SECRET;
    }

    if (!apiKey || !apiSecret) {
      return undefined;
    }

    const client = new RestClientV5({ key: apiKey, secret: apiSecret, testnet: useTestnet });

    bybitClientMap.set(key, client);
    return client;
  };

  // Check if we're in maximum speed mode (no delays) - calculate early for use in monitor
  const speedMultiplier = config.simulation?.speedMultiplier || 1.0;
  const isMaxSpeed = speedMultiplier === 0 || speedMultiplier === Infinity || !isFinite(speedMultiplier);

  // Initialize historical price provider if in simulation mode
  let priceProvider: HistoricalPriceProvider | undefined;
  if (isSimulation) {
    const startDate = config.simulation?.startDate || new Date().toISOString();
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    
    priceProvider = createHistoricalPriceProvider(
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
  const initiatorMap = new Map(config.initiators.map(i => [i.name || i.type || '', i]));
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

      // Resolve initiator by name
      const initiator = initiatorMap.get(channelConfig.initiator);
      if (!initiator) {
        logger.error('Initiator not found', {
          channel: channelConfig.channel,
          initiatorName: channelConfig.initiator
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
        // Select harvester based on platform
        const platform = harvester.platform || 'telegram'; // Default to telegram for backward compatibility
        if (platform === 'discord') {
          stopHarvester = await startDiscordHarvester(harvester, db);
        } else {
          stopHarvester = await startSignalHarvester(harvester, db);
        }
      }
      state.stopHarvesters.push(stopHarvester);

      // Merge channel-specific breakevenAfterTPs override with monitor config
      const monitorConfigWithOverride: MonitorConfig = {
        ...monitor,
        breakevenAfterTPs: channelConfig.breakevenAfterTPs ?? monitor.breakevenAfterTPs
      };

      // Start monitor for this channel
      const stopMonitor = await startTradeMonitor(
        monitorConfigWithOverride, 
        channelConfig.channel, 
        db, 
        isSimulation, 
        priceProvider, 
        speedMultiplier,
        (accountName?: string) => createBybitClient(accountName)
      );
      state.stopMonitors.push(stopMonitor);

      logger.info('Started channel set', {
        channel: channelConfig.channel,
        harvester: harvester.name,
        parser: parser.name,
        initiator: initiator.name || initiator.type || channelConfig.initiator,
        monitor: monitor.type
      });
    } catch (error) {
      logger.error('Failed to start channel set', {
        channel: channelConfig.channel,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }


  // Process edited messages (both trade signals and management commands)
  const processEditedMessages = async (
    channel: string,
    monitorType: string,
    parserName: string,
    maxStalenessMinutes?: number
  ): Promise<void> => {
    // Get edited messages directly (they may already be parsed, so we can't use getUnparsedMessages)
    const editedMessages = await db.getEditedMessages(channel, maxStalenessMinutes);
    
    if (editedMessages.length === 0) {
      return;
    }

    // Get parser config for LLM fallback if configured
    const channelConfig = config.channels.find(c => c.channel === channel);
    const parserConfig = channelConfig ? parserMap.get(channelConfig.parser) : undefined;
    const ollamaConfig = parserConfig?.ollama ? {
      ...parserConfig.ollama,
      channel: channel
    } : undefined;

    for (const message of editedMessages) {
      try {
        // First, check if the edited message is a management command
        const command = await parseManagementCommand(message.content, ollamaConfig, message, db);
        if (command) {
          // This is an edited management command - execute the new command
          // (We don't need to undo the old command, just execute the new one)
            const manager = getManager(command.type);
            if (manager) {
            const managerContext: ManagerContext = {
              channel,
              message,
              command,
              db,
              isSimulation,
              priceProvider,
              getBybitClient: (accountName?: string) => createBybitClient(accountName)
            };

            await manager(managerContext);
            await db.markMessageParsed(message.id);
            logger.info('Edited management command processed', {
              channel,
              commandType: command.type,
              messageId: message.message_id,
              oldContent: message.old_content?.substring(0, 50),
              newContent: message.content.substring(0, 50)
            });
            continue; // Skip trade signal processing
          } else {
            logger.warn('Manager not found for edited command type', {
              channel,
              commandType: command.type,
              messageId: message.message_id
            });
            await db.markMessageParsed(message.id);
            continue;
          }
        }

        // Not a management command, check if it's a trade signal
        const newParsed = parseMessage(message.content, parserName);
        if (!newParsed) {
          // Not a trade signal either, mark as parsed and skip
          await db.markMessageParsed(message.id);
          continue;
        }

        // Check if there are existing trades for this message
        const existingTrades = await db.getTradesByMessageId(message.message_id, channel);
        if (existingTrades.length === 0) {
          // No existing trades, this is a new signal (shouldn't happen if message was edited)
          // But handle it anyway - will be processed by normal flow
          await db.markMessageParsed(message.id);
          continue;
        }

        // For each existing trade, check what changed
        for (const trade of existingTrades) {
          const diff = diffOrderWithTrade(newParsed, trade);
          
          // Route to appropriate update managers
          if (diff.entryPriceChanged) {
            const updateEntryManager = getManager('update_entry');
            if (updateEntryManager) {
              await updateEntryManager({
                channel,
                message,
                command: { type: 'update_entry', newOrder: newParsed, trade },
                db,
                isSimulation,
                priceProvider,
                getBybitClient: (accountName?: string) => createBybitClient(accountName || trade.account_name)
              } as ManagerContext);
            }
          }

          if (diff.stopLossChanged) {
            const updateStopLossManager = getManager('update_stop_loss');
            if (updateStopLossManager) {
              await updateStopLossManager({
                channel,
                message,
                command: { type: 'update_stop_loss', newOrder: newParsed, trade },
                db,
                isSimulation,
                priceProvider,
                getBybitClient: (accountName?: string) => createBybitClient(accountName || trade.account_name)
              } as ManagerContext);
            }
          }

          if (diff.takeProfitsChanged) {
            const updateTakeProfitsManager = getManager('update_take_profits');
            if (updateTakeProfitsManager) {
              await updateTakeProfitsManager({
                channel,
                message,
                command: { type: 'update_take_profits', newOrder: newParsed, trade },
                db,
                isSimulation,
                priceProvider,
                getBybitClient: (accountName?: string) => createBybitClient(accountName || trade.account_name)
              } as ManagerContext);
            }
          }

          if (!diff.entryPriceChanged && !diff.stopLossChanged && !diff.takeProfitsChanged) {
            logger.info('Edited message parsed but no trade parameters changed', {
              channel,
              messageId: message.message_id,
              tradeId: trade.id
            });
          }
        }

        // Mark message as parsed after processing edits
        await db.markMessageParsed(message.id);
        logger.info('Edited trade message processed', {
          channel,
          messageId: message.message_id,
          tradesUpdated: existingTrades.length
        });
      } catch (error) {
        logger.error('Error processing edited message', {
          channel,
          messageId: message.message_id,
          error: error instanceof Error ? error.message : String(error)
        });
        // Don't mark as parsed on error - allow retry
      }
    }
  };

  // Process management messages
  const processManagementMessages = async (
    channel: string,
    monitorType: string,
    maxStalenessMinutes?: number
  ): Promise<void> => {
    const messages = await db.getUnparsedMessages(channel, maxStalenessMinutes);
    
    // Get parser config for this channel to check for LLM fallback
    const channelConfig = config.channels.find(c => c.channel === channel);
    const parserConfig = channelConfig ? parserMap.get(channelConfig.parser) : undefined;
    const ollamaConfig = parserConfig?.ollama ? {
      ...parserConfig.ollama,
      channel: channel
    } : undefined;
    
    for (const message of messages) {
      try {
        // Check if message is a management command (with LLM fallback if configured)
        // Pass message and db to enable reply chain context extraction
        const command = await parseManagementCommand(message.content, ollamaConfig, message, db);
        if (command) {
          const manager = getManager(command.type);
          if (manager) {
            const managerContext: ManagerContext = {
              channel,
              message,
              command,
              db,
              isSimulation,
              priceProvider,
              getBybitClient: (accountName?: string) => createBybitClient(accountName)
            };

            await manager(managerContext);
            await db.markMessageParsed(message.id);
            logger.info('Management command processed', {
              channel,
              commandType: command.type,
              messageId: message.message_id
            });
          } else {
            logger.warn('Manager not found for command type', {
              channel,
              commandType: command.type,
              messageId: message.message_id
            });
            await db.markMessageParsed(message.id); // Mark as parsed to avoid reprocessing
          }
        }
      } catch (error) {
        logger.error('Error processing management message', {
          channel,
          messageId: message.message_id,
          error: error instanceof Error ? error.message : String(error)
        });
        // Don't mark as parsed on error - allow retry
      }
    }
  };

  // In simulation mode, process messages chronologically
  if (isSimulation && priceProvider) {
    // Process messages in chronological order based on their timestamps
    const processSimulationMessages = async () => {
      for (const channelConfig of config.channels) {
        const parser = parserMap.get(channelConfig.parser);
        if (!parser) continue;

        // Get unparsed messages ordered by date
        const messages = await db.getUnparsedMessages(parser.channel);
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
            // Check if this is an edited message - process it specially
            if (message.old_content) {
              // First check if edited message is a management command
              const parser = parserMap.get(channelConfig.parser);
              const ollamaConfig = parser?.ollama ? {
                ...parser.ollama,
                channel: channelConfig.channel
              } : undefined;
              const command = await parseManagementCommand(message.content, ollamaConfig, message, db);
              
              if (command) {
                // Edited management command - execute the new command
                const manager = getManager(command.type);
                if (manager) {
                  const managerContext: ManagerContext = {
                    channel: channelConfig.channel,
                    message,
                    command,
                    db,
                    isSimulation,
                    priceProvider,
                    getBybitClient: (accountName?: string) => createBybitClient(accountName)
                  };

                  await manager(managerContext);
                  await db.markMessageParsed(message.id);
                  logger.info('Edited management command processed in simulation', {
                    channel: channelConfig.channel,
                    commandType: command.type,
                    messageId: message.message_id,
                    messageTime: messageTime.toISOString()
                  });
                  continue; // Skip signal parsing for management messages
                }
              } else {
                // Not a management command, check if it's an edited trade signal
                if (!parser) {
                  logger.warn('Parser not found for edited message', {
                    channel: channelConfig.channel,
                    parserName: channelConfig.parser
                  });
                  await db.markMessageParsed(message.id);
                  continue;
                }
                const newParsed = parseMessage(message.content, parser.name);
                if (newParsed) {
                  const existingTrades = await db.getTradesByMessageId(message.message_id, channelConfig.channel);
                  if (existingTrades.length > 0) {
                    // Process trade parameter updates
                    for (const trade of existingTrades) {
                      const diff = diffOrderWithTrade(newParsed, trade);
                      
                      if (diff.entryPriceChanged) {
                        const updateEntryManager = getManager('update_entry');
                        if (updateEntryManager) {
                          await updateEntryManager({
                            channel: channelConfig.channel,
                            message,
                            command: { type: 'update_entry', newOrder: newParsed, trade },
                            db,
                            isSimulation,
                            priceProvider,
                            getBybitClient: (accountName?: string) => createBybitClient(accountName || trade.account_name)
                          } as ManagerContext);
                        }
                      }

                      if (diff.stopLossChanged) {
                        const updateStopLossManager = getManager('update_stop_loss');
                        if (updateStopLossManager) {
                          await updateStopLossManager({
                            channel: channelConfig.channel,
                            message,
                            command: { type: 'update_stop_loss', newOrder: newParsed, trade },
                            db,
                            isSimulation,
                            priceProvider,
                            getBybitClient: (accountName?: string) => createBybitClient(accountName || trade.account_name)
                          } as ManagerContext);
                        }
                      }

                      if (diff.takeProfitsChanged) {
                        const updateTakeProfitsManager = getManager('update_take_profits');
                        if (updateTakeProfitsManager) {
                          await updateTakeProfitsManager({
                            channel: channelConfig.channel,
                            message,
                            command: { type: 'update_take_profits', newOrder: newParsed, trade },
                            db,
                            isSimulation,
                            priceProvider,
                            getBybitClient: (accountName?: string) => createBybitClient(accountName || trade.account_name)
                          } as ManagerContext);
                        }
                      }
                    }

                    await db.markMessageParsed(message.id);
                    logger.info('Edited trade message processed in simulation', {
                      channel: channelConfig.channel,
                      messageId: message.message_id,
                      tradesUpdated: existingTrades.length
                    });
                    continue; // Skip normal parsing
                  }
                }
              }
            }

            // Normal processing for non-edited messages
            // First check if it's a management command (with LLM fallback if configured)
            const parser = parserMap.get(channelConfig.parser);
            const ollamaConfig = parser?.ollama ? {
              ...parser.ollama,
              channel: channelConfig.channel
            } : undefined;
            // Pass message and db to enable reply chain context extraction
            const command = await parseManagementCommand(message.content, ollamaConfig, message, db);
            if (command) {
              const manager = getManager(command.type);
              if (manager) {
                const managerContext: ManagerContext = {
                  channel: channelConfig.channel,
                  message,
                  command,
                  db,
                  isSimulation,
                  priceProvider,
                  getBybitClient: (accountName?: string) => createBybitClient(accountName)
                };

                await manager(managerContext);
                await db.markMessageParsed(message.id);
                logger.info('Management command processed in simulation', {
                  channel: channelConfig.channel,
                  commandType: command.type,
                  messageId: message.message_id,
                  messageTime: messageTime.toISOString()
                });
                continue; // Skip signal parsing for management messages
              }
            }

            // Parse the message using the configured parser
            if (!parser) {
              logger.warn('Parser not found for channel', {
                channel: channelConfig.channel,
                parserName: channelConfig.parser
              });
              await db.markMessageParsed(message.id);
              continue;
            }

            const parsed = parseMessage(message.content, parser.name);
            if (parsed) {
              // Check if trade already exists for this message (shouldn't happen, but safety check)
              const existingTrades = await db.getTradesByMessageId(message.message_id, channelConfig.channel);
              if (existingTrades.length > 0) {
                logger.warn('Trade already exists for message, skipping duplicate', {
                  channel: channelConfig.channel,
                  messageId: message.message_id,
                  tradeId: existingTrades[0].id
                });
                await db.markMessageParsed(message.id);
                continue;
              }

              await db.markMessageParsed(message.id);
              logger.info('Parsed message in simulation', {
                channel: channelConfig.channel,
                parserName: parser.name,
                messageId: message.message_id,
                tradingPair: parsed.tradingPair,
                messageTime: messageTime.toISOString()
              });
            } else {
              await db.markMessageParsed(message.id);
            }
            
            // Only add delay if not in maximum speed mode
            if (!isMaxSpeed) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          } catch (error) {
            logger.error('Error processing simulation message', {
              channel: channelConfig.channel,
              messageId: message.message_id,
              error: error instanceof Error ? error.message : String(error)
            });
            await db.markMessageParsed(message.id); // Mark as parsed to avoid infinite retry
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
          // First check for management messages
          processManagementMessages(
            channelConfig.channel,
            channelConfig.monitor,
            channelConfig.maxMessageStalenessMinutes
          ).catch(error => {
            logger.error('Manager error', {
              channel: channelConfig.channel,
              error: error instanceof Error ? error.message : String(error)
            });
          });

          // Then process edited messages (both management commands and trade signals)
          processEditedMessages(
            channelConfig.channel,
            channelConfig.monitor,
            parser.name,
            channelConfig.maxMessageStalenessMinutes
          ).catch(error => {
            logger.error('Edited message processing error', {
              channel: channelConfig.channel,
              error: error instanceof Error ? error.message : String(error)
            });
          });

          // Then parse signal messages
          parseUnparsedMessages(parser, db, channelConfig.maxMessageStalenessMinutes).catch(error => {
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
  // Skip time advancement in maximum speed mode (time is set directly per message/trade)
  let simulationTimeInterval: NodeJS.Timeout | undefined;
  if (isSimulation && priceProvider && !isMaxSpeed) {
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
            initiatorName: channelConfig.initiator
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
          channelConfig.parser, // Pass parser name to initiator
          config.accounts, // Pass accounts config
          undefined, // startDate (not used in live mode)
          channelConfig.baseLeverage, // Pass channel-specific baseLeverage
          channelConfig.maxMessageStalenessMinutes // Pass channel-specific message staleness limit
        );
      }
    };

    // Process trades immediately in max speed mode, otherwise wait for messages to load
    if (isMaxSpeed) {
      processSimulationTrades().catch(error => {
        logger.error('Error processing simulation trades', {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    } else {
      setTimeout(() => {
        processSimulationTrades().catch(error => {
          logger.error('Error processing simulation trades', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, 2000);
    }
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
            initiatorName: channelConfig.initiator
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
          channelConfig.parser, // Pass parser name to initiator
          config.accounts, // Pass accounts config
          undefined, // startDate (not used in live mode)
          channelConfig.baseLeverage, // Pass channel-specific baseLeverage
          channelConfig.maxMessageStalenessMinutes // Pass channel-specific message staleness limit
        ).catch(error => {
          logger.error('Initiator error', {
            channel: channelConfig.channel,
            initiatorName: initiator.name || initiator.type || channelConfig.initiator,
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
    if (state.managerInterval) {
      clearInterval(state.managerInterval);
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

    await db.close();
    logger.info('Trade orchestrator stopped');
  };
};
