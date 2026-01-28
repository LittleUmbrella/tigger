#!/usr/bin/env node
/**
 * Investigation MCP Server
 * 
 * Model Context Protocol server exposing investigation commands as MCP tools.
 * Allows AI assistants to use slash commands for debugging workflows.
 * 
 * Usage: Run as MCP server, or use investigation CLI directly
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { commandRegistry } from '../investigation/index.js';
import { createWorkflowContext } from '../investigation/workflowEngine.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Load .env-investigation first, then fall back to .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Try .env-investigation first, then .env
const envInvestigationPath = path.join(projectRoot, '.env-investigation');
const envPath = path.join(projectRoot, '.env');

// Load .env-investigation if it exists, otherwise load .env
if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
  console.error('Loaded environment variables from .env-investigation');
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.error('Loaded environment variables from .env');
} else {
  dotenv.config(); // Fallback to default behavior
}

class InvestigationMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'investigation-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools (commands)
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const commands = commandRegistry.listCommands();
      
      return {
        tools: commands.map(cmd => ({
          name: cmd.name,
          description: cmd.description,
          inputSchema: {
            type: 'object',
            properties: this.getCommandProperties(cmd.name),
            required: this.getRequiredProperties(cmd.name),
          },
        })),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const commandName = request.params.name;
      const args = request.params.arguments as Record<string, any> || {};

      const handler = commandRegistry.get(commandName);
      if (!handler) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown command "${commandName}"`,
            },
          ],
          isError: true,
        };
      }

      try {
        // Create workflow context
        const context = await createWorkflowContext(args);
        
        // Execute command
        const result = await handler(context);

        // Format response
        let responseText = result.message + '\n\n';
        
        if (result.data?.findings) {
          responseText += 'Findings:\n';
          result.data.findings.forEach((finding: string) => {
            responseText += `- ${finding}\n`;
          });
          responseText += '\n';
        }

        if (result.recommendations && result.recommendations.length > 0) {
          responseText += 'Recommendations:\n';
          result.recommendations.forEach((rec, i) => {
            responseText += `${i + 1}. ${rec}\n`;
          });
          responseText += '\n';
        }

        if (result.nextSteps && result.nextSteps.length > 0) {
          responseText += 'Next Steps:\n';
          result.nextSteps.forEach((step, i) => {
            responseText += `${i + 1}. ${step}\n`;
          });
          responseText += '\n';
        }

        if (result.error) {
          responseText += `Error: ${result.error}\n`;
        }

        // Include structured data if available
        if (result.data && Object.keys(result.data).length > 0) {
          responseText += '\nStructured Data:\n';
          responseText += JSON.stringify(result.data, null, 2);
        }

        await context.db.close();

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
          isError: !result.success,
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private getCommandProperties(commandName: string): Record<string, any> {
    switch (commandName) {
      case 'trace':
        return {
          message: {
            type: 'number',
            description: 'Message ID to trace',
          },
          channel: {
            type: 'string',
            description: 'Channel ID (optional)',
          },
        };
      case 'investigate':
        return {
          message: {
            type: 'number',
            description: 'Message ID to investigate',
          },
          channel: {
            type: 'string',
            description: 'Channel ID (optional)',
          },
        };
      case 'analyze':
        return {
          trade: {
            type: 'number',
            description: 'Trade ID to analyze',
          },
        };
      case 'check-logs':
        return {
          message: {
            type: 'number',
            description: 'Message ID (if querying by message)',
          },
          channel: {
            type: 'string',
            description: 'Channel ID (required if querying by message)',
          },
          query: {
            type: 'string',
            description: 'Loggly query string (if doing direct query)',
          },
          timeframe: {
            type: 'number',
            description: 'Time window in minutes (default: 10)',
          },
        };
      default:
        return {};
    }
  }

  private getRequiredProperties(commandName: string): string[] {
    switch (commandName) {
      case 'trace':
      case 'investigate':
        return ['message'];
      case 'analyze':
        return ['trade'];
      case 'check-logs':
        return []; // Either message+channel OR query
      default:
        return [];
    }
  }

  async run(): Promise<void> {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Investigation MCP server running on stdio');
      
      // Log available commands
      const commands = commandRegistry.listCommands();
      console.error(`Registered ${commands.length} investigation commands: ${commands.map(c => c.name).join(', ')}`);
    } catch (error) {
      console.error('Error starting Investigation MCP server:', error);
      process.exit(1);
    }
  }
}

// Run server if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new InvestigationMCPServer();
  server.run().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { InvestigationMCPServer };

