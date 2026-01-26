#!/usr/bin/env node
/**
 * Loggly MCP Server
 * 
 * Model Context Protocol server for querying Loggly logs.
 * Exposes Loggly search functionality as MCP tools/resources.
 * 
 * Usage: Run this as an MCP server, or use the logglyClient directly.
 */

// Note: MCP SDK needs to be installed: npm install @modelcontextprotocol/sdk
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { LogglyClient, createLogglyClient } from '../utils/logglyClient.js';
import dotenv from 'dotenv';

dotenv.config();

class LogglyMCPServer {
  private server: Server;
  private logglyClient: LogglyClient | null;

  constructor() {
    this.server = new Server(
      {
        name: 'loggly-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.logglyClient = createLogglyClient();

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'loggly_search',
          description: 'Search Loggly logs with a query string. Supports Loggly query syntax.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Loggly search query (e.g., "messageId:12345 AND channel:2394142145")',
              },
              from: {
                type: 'string',
                description: 'Start time in ISO 8601 format (optional)',
              },
              until: {
                type: 'string',
                description: 'End time in ISO 8601 format (optional)',
              },
              size: {
                type: 'number',
                description: 'Number of results to return (default: 100, max: 10000)',
                default: 100,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'loggly_search_by_message',
          description: 'Search Loggly logs for a specific message ID and channel',
          inputSchema: {
            type: 'object',
            properties: {
              messageId: {
                type: 'number',
                description: 'Message ID to search for',
              },
              channel: {
                type: 'string',
                description: 'Channel ID',
              },
              from: {
                type: 'string',
                description: 'Start time in ISO 8601 format (optional)',
              },
              until: {
                type: 'string',
                description: 'End time in ISO 8601 format (optional)',
              },
            },
            required: ['messageId', 'channel'],
          },
        },
        {
          name: 'loggly_search_errors_around_time',
          description: 'Search for errors around a specific timestamp',
          inputSchema: {
            type: 'object',
            properties: {
              timestamp: {
                type: 'string',
                description: 'ISO 8601 timestamp to search around',
              },
              windowMinutes: {
                type: 'number',
                description: 'Time window in minutes before/after timestamp (default: 5)',
                default: 5,
              },
              additionalQuery: {
                type: 'string',
                description: 'Additional query terms to add (optional)',
              },
            },
            required: ['timestamp'],
          },
        },
        {
          name: 'loggly_search_bybit_errors',
          description: 'Search for Bybit API errors',
          inputSchema: {
            type: 'object',
            properties: {
              from: {
                type: 'string',
                description: 'Start time in ISO 8601 format (optional)',
              },
              until: {
                type: 'string',
                description: 'End time in ISO 8601 format (optional)',
              },
            },
          },
        },
        {
          name: 'loggly_search_order_failures',
          description: 'Search for order creation failures',
          inputSchema: {
            type: 'object',
            properties: {
              from: {
                type: 'string',
                description: 'Start time in ISO 8601 format (optional)',
              },
              until: {
                type: 'string',
                description: 'End time in ISO 8601 format (optional)',
              },
              accountName: {
                type: 'string',
                description: 'Filter by account name (optional)',
              },
            },
          },
        },
      ],
    }));

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'loggly://config',
          name: 'Loggly Configuration',
          description: 'Current Loggly configuration status',
          mimeType: 'application/json',
        },
      ],
    }));

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri === 'loggly://config') {
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: JSON.stringify(
                {
                  configured: this.logglyClient !== null,
                  subdomain: process.env.LOGGLY_SUBDOMAIN ? '***' : null,
                  token: process.env.LOGGLY_TOKEN ? '***' : null,
                },
                null,
                2
              ),
            },
          ],
        };
      }
      throw new Error(`Unknown resource: ${request.params.uri}`);
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!this.logglyClient) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Loggly client not configured. Set LOGGLY_SUBDOMAIN and LOGGLY_TOKEN environment variables.',
            },
          ],
          isError: true,
        };
      }

      try {
        switch (request.params.name) {
          case 'loggly_search': {
            const { query, from, until, size } = request.params.arguments as any;
            const result = await this.logglyClient.search({ query, from, until, size });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'loggly_search_by_message': {
            const { messageId, channel, from, until } = request.params.arguments as any;
            const result = await this.logglyClient.searchByMessageId(messageId, channel, { from, until });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'loggly_search_errors_around_time': {
            const { timestamp, windowMinutes, additionalQuery } = request.params.arguments as any;
            const result = await this.logglyClient.searchErrorsAroundTime(timestamp, windowMinutes, additionalQuery);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'loggly_search_bybit_errors': {
            const { from, until } = request.params.arguments as any;
            const result = await this.logglyClient.searchBybitErrors({ from, until });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'loggly_search_order_failures': {
            const { from, until, accountName } = request.params.arguments as any;
            const result = await this.logglyClient.searchOrderFailures({ from, until }, accountName);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Loggly MCP server running on stdio');
  }
}

// Run server if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new LogglyMCPServer();
  server.run().catch(console.error);
}

export { LogglyMCPServer };

