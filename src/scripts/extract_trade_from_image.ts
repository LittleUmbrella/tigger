#!/usr/bin/env npx tsx
/**
 * Extract trade parameters from a trading chart image.
 *
 * Requires Ollama with a vision model (e.g. llava):
 *   ollama pull llava
 *
 * Usage:
 *   npm run extract-trade-from-image -- -i path/to/chart.png
 *   npm run extract-trade-from-image -- -t "XAUUSD Long Entry: 5216.72 SL: 5203.40 TP: 5245.38"
 */

import { Command } from 'commander';
import { extractTradeFromImage } from '../utils/imageTradeExtractor.js';
import { fxcmChartParser } from '../parsers/fxcmChartParser.js';

const program = new Command();

program
  .name('extract-trade-from-image')
  .description('Extract trade parameters from a trading chart image using Ollama vision')
  .option('-i, --image <path>', 'Path to the chart image (PNG, JPG, etc.)')
  .option('-t, --text <string>', 'Parse text directly (skip image extraction, for testing parser)')
  .option('--model <model>', 'Ollama vision model to use', 'llava')
  .option('--base-url <url>', 'Ollama base URL', 'http://localhost:11434')
  .action(async (options: { image?: string; text?: string; model?: string; baseUrl?: string }) => {
    if (options.text) {
      const order = fxcmChartParser(options.text);
      if (order) {
        console.log('\nParsed order (from text):\n');
        console.log(JSON.stringify(order, null, 2));
      } else {
        console.error('Could not parse trade from text');
        process.exit(1);
      }
      return;
    }

    if (!options.image) {
      console.error('Error: --image <path> is required when not using --text');
      program.help({ error: true });
    }

    const order = await extractTradeFromImage(options.image as string, {
      baseUrl: options.baseUrl,
      model: options.model,
    });

    if (order) {
      console.log('\nExtracted trade:\n');
      console.log(JSON.stringify(order, null, 2));
    } else {
      console.error('Could not extract trade from image.');
      console.error('Ensure Ollama is running with a vision model: ollama pull llava');
      process.exit(1);
    }
  });

program.parse();
