/**
 * LLM Fallback Parser
 * 
 * Uses ollama to interpret ambiguous Telegram messages that strict parsers cannot handle.
 * This parser should be used as a last resort after all other parsers have failed.
 * 
 * Can return either:
 * - ParsedOrder for OPEN actions (goes to initiators)
 * - ParsedManagementCommand for management actions (goes to managers)
 */
import { ParsedOrder } from '../types/order.js';
import { ParsedManagementCommand } from '../managers/managerRegistry.js';
import { logger } from '../utils/logger.js';
import { OllamaClient, OllamaConfig } from '../utils/llmClient.js';
import { extractAndParseJSON } from '../utils/jsonExtractor.js';
import { LLMOutputSchema, LLMOutput, LLMOpenAction, LLMNoneAction, LLMCloseAllAction, LLMSetTPAction, LLMSetSLAction, LLMAdjustEntryAction } from './llmSchemas.js';

/**
 * Result from LLM fallback parser - can be either a trade order or a management command
 */
export type LLMParserResult = 
  | { type: 'order'; order: ParsedOrder }
  | { type: 'management'; command: ParsedManagementCommand }
  | null;

/**
 * System prompt for the LLM
 */
const SYSTEM_PROMPT = `You are a specialized trading signal processor. Your sole task is to analyze the user's message and convert it into a valid JSON object for executing trades or managing positions via the Bybit API.

**CRITICAL RULES:**
1. You must ONLY output valid JSON. Do not include any text, commentary, or explanation outside of the JSON object.
2. If the message contains a valid trade signal (opening a new position), use action "OPEN".
3. If the message contains a management instruction (closing positions, adjusting stop loss, etc.), use the appropriate action: "CLOSE_ALL", "SET_TP", "SET_SL", or "ADJUST_ENTRY".
4. If the message is *not* a clear trade signal or management instruction (e.g., general chat, thanks, market news), you must return the following specific JSON object: {"action": "NONE", "reason": "Non-Signal Message"}.
5. **Action** must be one of: OPEN, CLOSE_ALL, SET_TP, SET_SL, or ADJUST_ENTRY.
6. For OPEN actions, you MUST include: symbol, side, price, quantity_type, quantity, sl, and tps.
7. For CLOSE_ALL actions, you MUST include: symbol, side, and price (can be "MARKET").
8. Always convert symbol to uppercase and remove slashes (e.g., "BTC/USDT" becomes "BTCUSDT").
9. The tps field must be a JSON array of numbers, not a comma-separated string.
10. If leverage is mentioned, include it. Otherwise, default to 1.
11. If order type is not specified, default to "MARKET".

**JSON Schema:**
{
  "action": "OPEN" | "CLOSE_ALL" | "SET_TP" | "SET_SL" | "ADJUST_ENTRY" | "NONE",
  "symbol": "string (e.g., BTCUSDT)",
  "side": "LONG" | "SHORT" (required for OPEN, CLOSE_ALL)",
  "price": number | "MARKET",
  "quantity_type": "PERCENT_BALANCE" | "FIXED_AMOUNT" (required for OPEN)",
  "quantity": number (required for OPEN)",
  "leverage": number (optional, default 1)",
  "order_type": "MARKET" | "LIMIT" (optional, default MARKET)",
  "sl": number (required for OPEN)",
  "tps": [number, ...] (required for OPEN, must be array)",
  "reason": "string (required for NONE, optional for others)",
  "confidence": number 0.0-1.0 (optional)
}

**Examples:**
Input: "New trade setup: short ETHUSDT at 1850 with 10x leverage. Risk 2%. Stop loss 1900. Targets: 1800, 1750, 1700"
Output: {"action": "OPEN", "symbol": "ETHUSDT", "side": "SHORT", "price": 1850, "quantity_type": "PERCENT_BALANCE", "quantity": 2.0, "leverage": 10, "order_type": "LIMIT", "sl": 1900, "tps": [1800, 1750, 1700]}

Input: "Close all longs on Bitcoin. Profit secured!"
Output: {"action": "CLOSE_ALL", "symbol": "BTCUSDT", "side": "LONG", "price": "MARKET"}

Input: "just saw a new article on the Fed, looks bearish"
Output: {"action": "NONE", "reason": "Non-Signal Message"}`;

/**
 * Metrics for monitoring LLM fallback usage
 */
interface LLMParserMetrics {
  totalCalls: number;
  successfulParses: number;
  validationFailures: number;
  llmErrors: number;
  timeouts: number;
  rateLimitHits: number;
  averageResponseTime: number;
  lastError?: string;
}

const metrics: LLMParserMetrics = {
  totalCalls: 0,
  successfulParses: 0,
  validationFailures: 0,
  llmErrors: 0,
  timeouts: 0,
  rateLimitHits: 0,
  averageResponseTime: 0,
};

/**
 * Get current metrics
 */
export function getLLMParserMetrics(): LLMParserMetrics {
  return { ...metrics };
}

/**
 * LLM Fallback Parser
 */
export class LLMFallbackParser {
  private client: OllamaClient;
  private channel: string;
  private enabled: boolean = true;

  constructor(config: OllamaConfig & { channel?: string } = {}) {
    this.client = new OllamaClient(config);
    this.channel = config.channel || 'default';
  }

  /**
   * Parse a message using LLM fallback
   * Returns either a ParsedOrder (for OPEN actions) or ParsedManagementCommand (for management actions)
   */
  async parse(content: string): Promise<LLMParserResult> {
    if (!this.enabled) {
      logger.debug('LLM fallback parser is disabled');
      return null;
    }

    const startTime = Date.now();
    metrics.totalCalls++;

    try {
      // Check if LLM service is available
      const isHealthy = await this.client.healthCheck();
      if (!isHealthy) {
        logger.warn('Ollama service unavailable, skipping LLM fallback', {
          channel: this.channel,
        });
        metrics.llmErrors++;
        return null;
      }

      // Build the prompt
      const prompt = `${SYSTEM_PROMPT}\n\n**User Message:**\n${content}\n\n**Output JSON:**`;

      // Call LLM
      const llmOutput = await this.client.generate(prompt, this.channel);

      // Extract and parse JSON
      const parsed = extractAndParseJSON<LLMOutput>(llmOutput);
      if (!parsed) {
        logger.warn('Failed to extract JSON from LLM output', {
          channel: this.channel,
          output: llmOutput.substring(0, 200), // Log first 200 chars
        });
        metrics.validationFailures++;
        return null;
      }

      // Validate with Zod schema
      const validationResult = LLMOutputSchema.safeParse(parsed);
      if (!validationResult.success) {
        logger.warn('LLM output failed schema validation', {
          channel: this.channel,
          errors: validationResult.error.errors,
          output: parsed,
        });
        metrics.validationFailures++;
        return null;
      }

      const validated = validationResult.data;

      // Handle NONE action
      if (validated.action === 'NONE') {
        logger.debug('LLM determined message is not a signal', {
          channel: this.channel,
          reason: validated.reason,
        });
        return null;
      }

      // Handle different action types
      if (validated.action === 'OPEN') {
        const order = this.convertToParsedOrder(validated);
        if (order) {
          const responseTime = Date.now() - startTime;
          metrics.successfulParses++;
          metrics.averageResponseTime =
            (metrics.averageResponseTime * (metrics.successfulParses - 1) + responseTime) /
            metrics.successfulParses;

          logger.info('LLM fallback parser succeeded (OPEN)', {
            channel: this.channel,
            action: validated.action,
            symbol: validated.symbol,
            side: validated.side,
            confidence: validated.confidence,
            responseTime,
          });

          return { type: 'order', order };
        }
      } else if (validated.action === 'CLOSE_ALL') {
        const command = this.convertToCloseAllCommand(validated);
        if (command) {
          const responseTime = Date.now() - startTime;
          metrics.successfulParses++;
          metrics.averageResponseTime =
            (metrics.averageResponseTime * (metrics.successfulParses - 1) + responseTime) /
            metrics.successfulParses;

          logger.info('LLM fallback parser succeeded (CLOSE_ALL)', {
            channel: this.channel,
            action: validated.action,
            symbol: validated.symbol,
            side: validated.side,
            confidence: validated.confidence,
            responseTime,
          });

          return { type: 'management', command };
        }
      } else if (validated.action === 'SET_TP' || validated.action === 'SET_SL' || validated.action === 'ADJUST_ENTRY') {
        // These actions are not yet fully supported by the manager system
        // but we can log them for future implementation
        logger.warn('LLM returned management action not yet fully supported', {
          channel: this.channel,
          action: validated.action,
          symbol: validated.symbol,
        });
        metrics.validationFailures++;
        return null;
      }

      logger.warn('LLM returned unsupported action type', {
        channel: this.channel,
        action: validated.action,
      });
      metrics.validationFailures++;
      return null;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      metrics.lastError = errorMessage;

      if (errorMessage.includes('timeout')) {
        metrics.timeouts++;
        logger.error('LLM request timeout', {
          channel: this.channel,
          error: errorMessage,
        });
      } else if (errorMessage.includes('Rate limit')) {
        metrics.rateLimitHits++;
        logger.warn('LLM rate limit exceeded', {
          channel: this.channel,
        });
      } else {
        metrics.llmErrors++;
        logger.error('LLM fallback parser error', {
          channel: this.channel,
          error: errorMessage,
        });
      }

      return null;
    }
  }

  /**
   * Convert LLM OPEN action to ParsedOrder
   */
  private convertToParsedOrder(llmOutput: LLMOpenAction): ParsedOrder | null {
    try {
      // Additional logical validation
      if (llmOutput.quantity <= 0) {
        logger.warn('Invalid quantity in LLM output', { quantity: llmOutput.quantity });
        return null;
      }

      // Validate price
      const entryPrice =
        llmOutput.price === 'MARKET' ? 0 : llmOutput.price; // 0 indicates market order
      if (entryPrice < 0) {
        logger.warn('Invalid entry price in LLM output', { price: llmOutput.price });
        return null;
      }

      // Validate stop loss
      if (llmOutput.sl <= 0) {
        logger.warn('Invalid stop loss in LLM output', { sl: llmOutput.sl });
        return null;
      }

      // Validate take profits
      if (llmOutput.tps.length === 0) {
        logger.warn('No take profits in LLM output');
        return null;
      }

      // Validate symbol format (should be like BTCUSDT, ETHUSDT, etc.)
      if (!/^[A-Z0-9]+USDT?$/.test(llmOutput.symbol)) {
        logger.warn('Invalid symbol format in LLM output', { symbol: llmOutput.symbol });
        return null;
      }

      // Sort take profits based on side
      const sortedTPs =
        llmOutput.side === 'LONG'
          ? [...llmOutput.tps].sort((a, b) => a - b)
          : [...llmOutput.tps].sort((a, b) => b - a);

      return {
        tradingPair: llmOutput.symbol,
        leverage: llmOutput.leverage || 1,
        entryPrice,
        stopLoss: llmOutput.sl,
        takeProfits: sortedTPs,
        signalType: llmOutput.side.toLowerCase() as 'long' | 'short',
      };
    } catch (error) {
      logger.error('Error converting LLM output to ParsedOrder', {
        error: error instanceof Error ? error.message : String(error),
        llmOutput,
      });
      return null;
    }
  }

  /**
   * Convert LLM CLOSE_ALL action to ParsedManagementCommand
   */
  private convertToCloseAllCommand(llmOutput: LLMCloseAllAction): ParsedManagementCommand | null {
    try {
      // Validate symbol format
      if (!/^[A-Z0-9]+USDT?$/.test(llmOutput.symbol)) {
        logger.warn('Invalid symbol format in LLM output', { symbol: llmOutput.symbol });
        return null;
      }

      // Convert side to management command type
      if (llmOutput.side === 'LONG') {
        return {
          type: 'close_all_longs',
          tradingPair: llmOutput.symbol,
        };
      } else if (llmOutput.side === 'SHORT') {
        return {
          type: 'close_all_shorts',
          tradingPair: llmOutput.symbol,
        };
      } else {
        // If side is not specified or invalid, close all trades
        return {
          type: 'close_all_trades',
          tradingPair: llmOutput.symbol,
        };
      }
    } catch (error) {
      logger.error('Error converting LLM output to management command', {
        error: error instanceof Error ? error.message : String(error),
        llmOutput,
      });
      return null;
    }
  }

  /**
   * Disable the parser (e.g., if service is down)
   */
  disable(): void {
    this.enabled = false;
    logger.warn('LLM fallback parser disabled', { channel: this.channel });
  }

  /**
   * Enable the parser
   */
  enable(): void {
    this.enabled = true;
    logger.info('LLM fallback parser enabled', { channel: this.channel });
  }
}

/**
 * Create a parser function compatible with the parser registry
 * This is a wrapper that creates an LLMFallbackParser instance
 */
export function createLLMFallbackParser(
  config: OllamaConfig & { channel?: string } = {}
): (content: string) => ParsedOrder | null {
  const parser = new LLMFallbackParser(config);

  // Return a synchronous function that returns null
  // The actual parsing is async, so this is a limitation
  // In practice, this should be called from an async context
  return (content: string): ParsedOrder | null => {
    // This is a synchronous interface, but LLM parsing is async
    // We'll need to handle this differently in the orchestrator
    logger.warn('LLM fallback parser called synchronously - this is not supported');
    return null;
  };
}

/**
 * Async version of the parser function
 */
export async function parseWithLLMFallback(
  content: string,
  config: OllamaConfig & { channel?: string } = {}
): Promise<LLMParserResult> {
  const parser = new LLMFallbackParser(config);
  return parser.parse(content);
}

