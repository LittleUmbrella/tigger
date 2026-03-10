/**
 * Extracts trade information from chart images using Ollama vision models (e.g. llava).
 *
 * Usage:
 *   const order = await extractTradeFromImage('./path/to/chart.png');
 */

import fs from 'fs-extra';
import path from 'path';
import { logger } from './logger.js';
import { fxcmChartParser } from '../parsers/fxcmChartParser.js';
import type { ParsedOrder } from '../types/order.js';

export interface ImageTradeExtractorConfig {
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

const EXTRACTION_PROMPT = `Extract the trade parameters from this trading chart image.

Look for:
- Instrument/symbol (e.g. XAUUSD, Gold Spot, EURUSD)
- Trade direction: Long (buy) or Short (sell) - green/teal zone above entry = long, red zone below entry = short
- Entry price (the line between the stop loss and take profit zones)
- Stop Loss price (typically the boundary of the red/danger zone)
- Take Profit price(s) (typically the boundary of the green/profit zone)

Respond with ONLY a JSON object in this exact format, no other text:
{
  "asset": "XAUUSD",
  "direction": "long",
  "entry": 5216.72,
  "sl": 5203.40,
  "tp": [5245.38]
}

Use "long" or "short" for direction. The tp field can be an array if multiple take profit levels are shown.
If you cannot confidently extract all values, respond with: {"error": "brief reason"}`;

/**
 * Extract trade parameters from an image using Ollama vision.
 * Requires a vision model like llava: ollama pull llava
 */
export async function extractTradeFromImage(
  imagePath: string,
  config: ImageTradeExtractorConfig = {}
): Promise<ParsedOrder | null> {
  const baseUrl = config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const model = config.model ?? process.env.OLLAMA_VISION_MODEL ?? 'llava';
  const timeout = config.timeout ?? 60000;

  const resolvedPath = path.resolve(imagePath);
  if (!(await fs.pathExists(resolvedPath))) {
    logger.error('Image file not found', { path: resolvedPath });
    return null;
  }

  const buffer = await fs.readFile(resolvedPath);
  const base64 = buffer.toString('base64');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: EXTRACTION_PROMPT,
        stream: false,
        images: [base64],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.error('Ollama vision API error', {
        status: response.status,
        statusText: response.statusText,
        model,
      });
      return null;
    }

    const data = (await response.json()) as { response?: string };
    const text = data.response?.trim() ?? '';

    if (!text) {
      logger.warn('Empty response from vision model');
      return null;
    }

    // Check for error response from model
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) {
        logger.warn('Vision model could not extract trade', { reason: parsed.error });
        return null;
      }
    } catch {
      // Not JSON or no error field - continue to parser
    }

    const order = fxcmChartParser(text);
    if (order) {
      logger.info('Extracted trade from image', {
        tradingPair: order.tradingPair,
        signalType: order.signalType,
        entryPrice: order.entryPrice,
        stopLoss: order.stopLoss,
        takeProfits: order.takeProfits,
      });
    }
    return order;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      logger.error('Vision model timeout', { timeout, model });
    } else {
      logger.error('Error extracting trade from image', {
        path: resolvedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}
