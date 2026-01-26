#!/usr/bin/env tsx
/**
 * Investigation CLI
 * 
 * Command-line interface for investigation slash commands.
 * 
 * Usage:
 *   npm run investigate -- /trace message:12345 channel:2394142145
 *   npm run investigate -- /investigate message:12345
 *   npm run investigate -- /analyze trade:123
 *   npm run investigate -- /check-logs message:12345 channel:2394142145
 */

import { parseCommandFlexible } from './commandParser.js';
import { commandRegistry } from './index.js';
import { createWorkflowContext } from './workflowEngine.js';
import { logger } from '../utils/logger.js';
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
  logger.info('Loaded environment variables from .env-investigation');
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  logger.info('Loaded environment variables from .env');
} else {
  dotenv.config(); // Fallback to default behavior
}

async function main() {
  const input = process.argv.slice(2).join(' ');

  if (!input) {
    console.log('Investigation Commands');
    console.log('====================\n');
    console.log('Available commands:\n');
    
    const commands = commandRegistry.listCommands();
    for (const cmd of commands) {
      console.log(`/${cmd.name}`);
      console.log(`  ${cmd.description}`);
      if (cmd.examples.length > 0) {
        console.log('  Examples:');
        cmd.examples.forEach(ex => console.log(`    ${ex}`));
      }
      console.log('');
    }
    
    console.log('Usage: npm run investigate -- /<command> <args>');
    console.log('Example: npm run investigate -- /trace message:12345 channel:2394142145');
    process.exit(0);
  }

  // Parse command
  const parsed = parseCommandFlexible(input);
  
  if (!parsed) {
    console.error('Error: Could not parse command');
    console.error('Usage: npm run investigate -- /<command> <args>');
    process.exit(1);
  }

  // Get command handler
  const handler = commandRegistry.get(parsed.command);
  
  if (!handler) {
    console.error(`Error: Unknown command "${parsed.command}"`);
    console.error('Available commands:', commandRegistry.listCommands().map(c => c.name).join(', '));
    process.exit(1);
  }

  // Create context
  const context = await createWorkflowContext(parsed.args);
  
  // Execute command
  try {
    console.log(`\n🔍 Executing: /${parsed.command}`);
    console.log('─'.repeat(60) + '\n');
    
    const result = await handler(context);
    
    // Display results
    if (result.success) {
      console.log(`✅ ${result.message}\n`);
    } else {
      console.log(`❌ ${result.message}\n`);
      if (result.error) {
        console.log(`Error: ${result.error}\n`);
      }
    }

    // Show findings if available
    if (result.data?.findings) {
      console.log('📋 Findings:');
      result.data.findings.forEach((finding: string) => {
        console.log(`   ${finding}`);
      });
      console.log('');
    }

    // Show recommendations
    if (result.recommendations && result.recommendations.length > 0) {
      console.log('💡 Recommendations:');
      result.recommendations.forEach((rec, i) => {
        console.log(`   ${i + 1}. ${rec}`);
      });
      console.log('');
    }

    // Show next steps
    if (result.nextSteps && result.nextSteps.length > 0) {
      console.log('➡️  Next Steps:');
      result.nextSteps.forEach((step, i) => {
        console.log(`   ${i + 1}. ${step}`);
      });
      console.log('');
    }

    // Show data if verbose
    if (process.env.VERBOSE === 'true' && result.data) {
      console.log('📊 Data:');
      console.log(JSON.stringify(result.data, null, 2));
      console.log('');
    }

    await context.db.close();
    
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    logger.error('Error executing command', {
      command: parsed.command,
      error: error instanceof Error ? error.message : String(error)
    });
    
    console.error(`\n❌ Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    await context.db.close();
    process.exit(1);
  }
}

main();

