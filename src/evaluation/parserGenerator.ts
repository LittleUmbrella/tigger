/**
 * Parser Generator
 * 
 * Generates parser code on-the-fly based on signal formats found in messages.
 * Saves parsers to channel-specific subfolders to avoid polluting the codebase.
 */

import fs from 'fs-extra';
import path from 'path';
import { DatabaseManager, SignalFormatRecord } from '../db/schema.js';
import { logger } from '../utils/logger.js';
import { createOllamaClient, OllamaClient } from '../utils/llmClient.js';

/**
 * Generate a parser for a channel based on its signal formats
 */
export async function generateParserForChannel(
  db: DatabaseManager,
  channel: string,
  parserName: string,
  ollamaConfig?: {
    baseUrl?: string;
    model?: string;
    timeout?: number;
    maxRetries?: number;
  }
): Promise<string> {
  logger.info('Generating parser for channel', { channel, parserName });

  // Get signal formats for this channel
  const formats = await db.getSignalFormats(channel);
  const signalFormats = formats.filter(f => f.classification === 'signal');

  if (signalFormats.length === 0) {
    throw new Error(`No signal formats found for channel: ${channel}`);
  }

  // Sort by example count (most common first)
  signalFormats.sort((a, b) => b.example_count - a.example_count);

  logger.info('Found signal formats', {
    channel,
    count: signalFormats.length,
    topFormats: signalFormats.slice(0, 10).map(f => ({
      hash: f.format_hash,
      examples: f.example_count
    }))
  });

  // Use Ollama to generate parser code if available
  const ollamaClient = createOllamaClient(ollamaConfig || {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2:1b',
    timeout: 60000, // Longer timeout for code generation
    maxRetries: 2,
  });

  const isOllamaAvailable = await ollamaClient.healthCheck();
  let parserCode: string;

  if (isOllamaAvailable) {
    // Generate parser using LLM
    parserCode = await generateParserWithLLM(ollamaClient, channel, signalFormats, parserName);
  } else {
    // Generate basic parser template
    parserCode = generateBasicParserTemplate(channel, signalFormats, parserName);
  }

  // Create channel-specific directory
  const channelDir = path.join(process.cwd(), 'src', 'parsers', 'channels', sanitizeChannelName(channel));
  await fs.ensureDir(channelDir);

  // Write parser file
  const parserPath = path.join(channelDir, `${parserName}.ts`);
  await fs.writeFile(parserPath, parserCode, 'utf-8');

  logger.info('Parser generated', {
    channel,
    parserName,
    path: parserPath
  });

  return parserPath;
}

/**
 * Generate parser code using LLM
 */
async function generateParserWithLLM(
  ollamaClient: OllamaClient,
  channel: string,
  formats: SignalFormatRecord[],
  parserName: string
): Promise<string> {
  // Get top 5 formats as examples
  const examples = formats.slice(0, 5).map(f => f.format_pattern).join('\n\n---\n\n');

  const prompt = `Generate a TypeScript parser function for Telegram crypto trading signals.

Channel: ${channel}

Example signal formats:
${examples}

The parser should:
1. Import ParsedOrder from '../../../types/order'
2. Export a function that takes a string (message content) and returns ParsedOrder | null
3. Extract: trading_pair, entry_price, stop_loss, take_profits (array), leverage, signal_type ('long' | 'short')
4. The entry price can be 'current' or 'market'. If it is a range, pick the worst value for the signal_type.
5. Handle multiple format variations from the examples
6. Return null if the message doesn't match any format
7. Use regex patterns to extract the required fields

Return ONLY the TypeScript code, no explanations. The function should be exported with the name provided in the export statement.

Example structure:
import { ParsedOrder } from '../../../types/order';

export const ${parserName} = (content: string): ParsedOrder | null => {
  // Your parser logic here
};`;

  try {
    const response = await ollamaClient.generate(prompt, channel);
    
    // Extract code block if present
    const codeMatch = response.match(/```typescript\n([\s\S]*?)```/) || 
                     response.match(/```ts\n([\s\S]*?)```/) ||
                     response.match(/```\n([\s\S]*?)```/);
    
    if (codeMatch) {
      return codeMatch[1].trim();
    }

    // If no code block, assume entire response is code
    return response.trim();
  } catch (error) {
    logger.warn('Failed to generate parser with LLM, using template', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    });
    return generateBasicParserTemplate(channel, formats, parserName);
  }
}

/**
 * Generate a basic parser template
 */
function generateBasicParserTemplate(
  channel: string,
  formats: SignalFormatRecord[],
  parserName: string
): string {
  const topFormat = formats[0]?.format_pattern || '';

  return `import { ParsedOrder } from '../../../types/order';
import { logger } from '../../utils/logger.js';

/**
 * Parser for ${channel}
 * 
 * Generated from ${formats.length} signal format(s)
 * Top format example: ${topFormat.substring(0, 100)}...
 */
export const ${parserName} = (content: string): ParsedOrder | null => {
  try {
    // TODO: Implement parser logic based on signal formats
    // Common patterns to extract:
    // - Trading pair (e.g., #SYMBOL/USDT, SYMBOL/USDT)
    // - Entry price/range
    // - Stop loss
    // - Take profit targets
    // - Leverage
    // - Signal type (long/short)
    
    // Example format patterns found:
${formats.slice(0, 3).map((f, i) => `    // ${i + 1}. ${f.format_pattern.substring(0, 80)}...`).join('\n')}

    // Basic implementation - needs refinement
    const symbolMatch = content.match(/#?([A-Z0-9]+)\/?USDT/i);
    if (!symbolMatch) return null;
    
    const tradingPair = symbolMatch[1].toUpperCase();
    
    // Extract entry price (simplified)
    const entryMatch = content.match(/(?:entry|buy|price)[: ]*([0-9.]+)/i);
    if (!entryMatch) return null;
    const entryPrice = parseFloat(entryMatch[1]);
    
    // Extract stop loss
    const stopLossMatch = content.match(/(?:stop|sl|stop.?loss)[: ]*([0-9.]+)/i);
    if (!stopLossMatch) return null;
    const stopLoss = parseFloat(stopLossMatch[1]);
    
    // Extract take profits
    const tpMatches = content.match(/(?:tp|target|take.?profit)[: ]*([0-9.\s-]+)/i);
    const takeProfits: number[] = [];
    if (tpMatches) {
      const numbers = tpMatches[1].match(/[0-9.]+/g);
      if (numbers) {
        takeProfits.push(...numbers.map(parseFloat).filter(n => !isNaN(n)));
      }
    }
    
    // Extract leverage
    const leverageMatch = content.match(/(?:leverage|lev)[: ]*([0-9]+)x?/i);
    const leverage = leverageMatch ? parseInt(leverageMatch[1], 10) : 1;
    
    // Determine signal type
    const isShort = /short|sell|down|bear/i.test(content);
    const signalType: 'long' | 'short' = isShort ? 'short' : 'long';
    
    if (takeProfits.length === 0) {
      logger.warn('No take profits found', { content: content.substring(0, 100) });
      return null;
    }
    
    return {
      tradingPair: \`\${tradingPair}/USDT\`,
      entryPrice,
      stopLoss,
      takeProfits,
      leverage,
      signalType,
    };
  } catch (error) {
    logger.error('Error parsing message', {
      error: error instanceof Error ? error.message : String(error),
      content: content.substring(0, 100)
    });
    return null;
  }
};
`;
}

/**
 * Sanitize channel name for use in file/folder names
 */
function sanitizeChannelName(channel: string): string {
  return channel
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/^https?:\/\//, '')
    .replace(/^t\.me\//, '')
    .replace(/^@/, '')
    .toLowerCase()
    .substring(0, 50);
}

/**
 * Generate index file for channel parsers
 */
export async function generateChannelParserIndex(channel: string, parserName: string): Promise<void> {
  const channelDir = path.join(process.cwd(), 'src', 'parsers', 'channels', sanitizeChannelName(channel));
  const indexPath = path.join(channelDir, 'index.ts');
  
  // Check if index already exists and append to it
  let indexContent = '';
  if (await fs.pathExists(indexPath)) {
    const existing = await fs.readFile(indexPath, 'utf-8');
    // Check if parser is already exported
    if (existing.includes(parserName)) {
      logger.info('Parser already exported in index', { channel, parserName });
      return;
    }
    indexContent = existing.trim() + '\n\n';
  }
  
  indexContent += `export { ${parserName} } from './${parserName}.js';`;

  await fs.writeFile(indexPath, indexContent, 'utf-8');
  logger.info('Parser index generated', { channel, indexPath });
}

