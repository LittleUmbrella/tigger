/**
 * Message Analyzer
 * 
 * Uses Ollama to analyze messages and identify signal vs management formats.
 * Extracts unique patterns for parser development.
 */

import { DatabaseManager, Message, SignalFormatRecord } from '../db/schema.js';
import { OllamaClient } from '../utils/llmClient.js';
import { logger } from '../utils/logger.js';

export interface MessageClassification {
  type: 'signal' | 'management' | 'other';
  confidence: number;
  reasoning?: string;
}

export interface SignalFormat {
  id: number;
  channel: string;
  format_pattern: string; // Example message content
  format_hash: string; // Hash of the format for deduplication
  classification: 'signal' | 'management';
  example_count: number; // Number of messages with this format
  first_seen: string;
  last_seen: string;
  extracted_fields?: string; // JSON object with extracted fields if available
  created_at: string;
}

/**
 * Analyze a single message to classify it
 */
export async function classifyMessage(
  message: string,
  ollamaClient: OllamaClient,
  channel: string
): Promise<MessageClassification> {
  const prompt = `Analyze the following Telegram message from a crypto trading channel and classify it.

Message: "${message}"

Classify the message as one of:
- "signal": A trading signal with entry price, stop loss, take profits, trading pair, etc.
- "management": A management command like closing positions, adjusting stop loss, etc.
- "other": Not a signal or management command (announcements, updates, etc.)

Respond with ONLY a JSON object in this exact format:
{
  "type": "signal" | "management" | "other",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

Do not include any other text, only the JSON object.`;

  try {
    const response = await ollamaClient.generate(prompt, channel);
    
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('Failed to extract JSON from LLM response', { response });
      return { type: 'other', confidence: 0 };
    }

    const classification = JSON.parse(jsonMatch[0]) as MessageClassification;
    
    // Validate classification
    if (!['signal', 'management', 'other'].includes(classification.type)) {
      logger.warn('Invalid classification type', { classification });
      return { type: 'other', confidence: 0 };
    }

    return classification;
  } catch (error) {
    logger.error('Failed to classify message', {
      error: error instanceof Error ? error.message : String(error),
      message: message.substring(0, 100)
    });
    return { type: 'other', confidence: 0 };
  }
}

/**
 * Extract format pattern from a message
 * Normalizes the message to create a pattern that can match similar messages
 */
export function extractFormatPattern(message: string): string {
  // Normalize the message to create a pattern
  let pattern = message
    // Replace numbers with placeholders
    .replace(/\d+\.?\d*/g, '{NUMBER}')
    // Replace trading pairs with placeholder
    .replace(/#?[A-Z0-9]+\/?[A-Z0-9]*/gi, '{PAIR}')
    // Replace percentages with placeholder
    .replace(/\d+\.?\d*%/g, '{PERCENT}')
    // Replace emojis with placeholder
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '{EMOJI}')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();

  return pattern;
}

/**
 * Create a hash of the format pattern for deduplication
 */
export function hashFormatPattern(pattern: string): string {
  // Simple hash function (could use crypto if needed)
  let hash = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Analyze all messages in a channel and extract unique formats
 */
export async function analyzeChannelMessages(
  db: DatabaseManager,
  channel: string,
  ollamaConfig?: {
    baseUrl?: string;
    model?: string;
    timeout?: number;
    maxRetries?: number;
    rateLimit?: {
      perChannel?: number;
      perMinute?: number;
    };
  }
): Promise<{
  totalMessages: number;
  signalsFound: number;
  managementFound: number;
  uniqueFormats: number;
}> {
  logger.info('Starting message analysis', { channel });

  const ollamaClient = new OllamaClient(ollamaConfig || {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2:1b',
    timeout: 30000,
    maxRetries: 2,
  });

  // Check if Ollama is available
  const isAvailable = await ollamaClient.healthCheck();
  if (!isAvailable) {
    throw new Error('Ollama service is not available. Please ensure Ollama is running.');
  }

  // Get all messages for this channel
  const messages = await db.getUnparsedMessages(channel);
  logger.info('Messages to analyze', { channel, count: messages.length });

  if (messages.length === 0) {
    logger.warn('No messages found for analysis', { channel });
    return {
      totalMessages: 0,
      signalsFound: 0,
      managementFound: 0,
      uniqueFormats: 0,
    };
  }

  // Track formats
  const formatMap = new Map<string, {
    pattern: string;
    classification: 'signal' | 'management';
    examples: string[];
    firstSeen: string;
    lastSeen: string;
  }>();

  let signalsFound = 0;
  let managementFound = 0;
  let processed = 0;

  // Process messages in batches to avoid overwhelming the LLM
  const batchSize = 10;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    
    for (const message of batch) {
      try {
        // Classify message
        const classification = await classifyMessage(
          message.content,
          ollamaClient,
          channel
        );

        if (classification.type === 'signal' || classification.type === 'management') {
          // Extract format pattern
          const pattern = extractFormatPattern(message.content);
          const hash = hashFormatPattern(pattern);

          // Update format map
          if (!formatMap.has(hash)) {
            formatMap.set(hash, {
              pattern,
              classification: classification.type,
              examples: [message.content],
              firstSeen: message.date,
              lastSeen: message.date,
            });
          } else {
            const format = formatMap.get(hash)!;
            format.examples.push(message.content);
            if (message.date < format.firstSeen) {
              format.firstSeen = message.date;
            }
            if (message.date > format.lastSeen) {
              format.lastSeen = message.date;
            }
          }

          if (classification.type === 'signal') {
            signalsFound++;
          } else {
            managementFound++;
          }
        }

        processed++;
        if (processed % 50 === 0) {
          logger.info('Analysis progress', {
            channel,
            processed,
            total: messages.length,
            signalsFound,
            managementFound,
            uniqueFormats: formatMap.size
          });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error('Error analyzing message', {
          channel,
          messageId: message.message_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Longer delay between batches
    if (i + batchSize < messages.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Save formats to database
  let savedFormats = 0;
  for (const [hash, format] of formatMap.entries()) {
    try {
      // Check if format already exists
      const existing = await db.getSignalFormats(channel, hash);
      if (existing.length > 0) {
        // Update existing format
        await db.updateSignalFormat(existing[0].id, {
          example_count: format.examples.length,
          last_seen: format.lastSeen,
        });
      } else {
        // Insert new format
        await db.insertSignalFormat({
          channel,
          format_pattern: format.examples[0], // Use first example as the pattern
          format_hash: hash,
          classification: format.classification,
          example_count: format.examples.length,
          first_seen: format.firstSeen,
          last_seen: format.lastSeen,
        });
        savedFormats++;
      }
    } catch (error) {
      logger.error('Error saving format', {
        channel,
        hash,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  logger.info('Message analysis completed', {
    channel,
    totalMessages: messages.length,
    signalsFound,
    managementFound,
    uniqueFormats: formatMap.size,
    savedFormats
  });

  return {
    totalMessages: messages.length,
    signalsFound,
    managementFound,
    uniqueFormats: formatMap.size,
  };
}

