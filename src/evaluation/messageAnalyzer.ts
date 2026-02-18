/**
 * Message Analyzer
 * 
 * Uses Ollama to analyze messages and identify signal vs management formats.
 * Extracts unique patterns for parser development.
 */

import { DatabaseManager, Message, SignalFormatRecord } from '../db/schema.js';
import { createOllamaClient, OllamaClient, OllamaConfig } from '../utils/llmClient.js';
import { logger } from '../utils/logger.js';
import { extractAndParseJSON } from '../utils/jsonExtractor.js';

export interface MessageClassification {
  type: 'signal' | 'management' | 'trade_progress_update' | 'other';
  confidence: number;
  reasoning?: string;
}

export interface SignalFormat {
  id: number;
  channel: string;
  format_pattern: string; // Example message content
  format_hash: string; // Hash of the format for deduplication
  classification: 'signal' | 'management' | 'trade_progress_update';
  example_count: number; // Number of messages with this format
  first_seen: string;
  last_seen: string;
  extracted_fields?: string; // JSON object with extracted fields if available
  created_at: string;
}

/**
 * Format reply chain messages with sequence indicators
 * Limits the chain to prevent prompt bloat while preserving recent context
 */
function formatReplyChain(replyChain: Message[], maxMessages: number = 5, maxMessageLength: number = 600): string {
  if (replyChain.length === 0) {
    return '';
  }

  // Keep only the most recent messages (most relevant for context)
  const recentMessages = replyChain.slice(-maxMessages);

  const formatted = recentMessages.map((msg, index) => {
    const sequence = replyChain.length - recentMessages.length + index + 1;
    const timestamp = new Date(msg.date).toISOString();
    // Truncate individual messages if they're too long
    const content = msg.content.length > maxMessageLength 
      ? msg.content.substring(0, maxMessageLength) + '...'
      : msg.content;
    return `[Message ${sequence} - ${timestamp}]\n${content}`;
  }).join('\n\n---\n\n');

  // Add indicator if messages were truncated
  if (replyChain.length > maxMessages) {
    return `[Showing ${maxMessages} most recent of ${replyChain.length} messages]\n\n${formatted}`;
  }

  return formatted;
}

/**
 * Analyze a single message to classify it
 * If the message is a reply, includes the full reply chain for context
 */
export async function classifyMessage(
  message: Message,
  ollamaClient: OllamaClient,
  channel: string,
  db?: DatabaseManager
): Promise<MessageClassification> {
  // Fetch reply chain if this is a reply
  let replyChainText = '';
  if (message.reply_to_message_id && db) {
    try {
      const replyChain = await db.getMessageReplyChain(message.message_id, channel);
      if (replyChain.length > 0) {
        replyChainText = `\n\n**Previous Messages in Reply Chain:**\n${formatReplyChain(replyChain)}\n\n---\n\n**Current Message:**`;
      }
    } catch (error) {
      logger.warn('Failed to fetch reply chain', {
        messageId: message.message_id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const prompt = `Analyze the following Telegram message from a crypto trading channel and classify it.
${replyChainText}
Message: "${message.content}"

Classify the message as one of:
- "signal": A new trading signal with entry price, stop loss, take profits, trading pair, etc. Examples: "Entry: 100-105, Targets: 110-120, Stop: 95", "#BTC/USDT Long Entry: 50000"

- "management": An actionable management command like closing positions, adjusting stop loss, moving stop loss to entry, etc. Examples: "Close all positions", "Move SL to entry", "Take profit now"

- "trade_progress_update": An informational update about trade progress. These are NOT actionable commands. Examples:
  * "Target 1 hit" or "First Target ✅" or "TP1 hit"
  * "Second Target ✅" or "TP2 hit" or "Target 2 hit"
  * "Third Target ✅" or "TP3 hit" or "Target 3 hit"
  * "All Target ✅" or "All targets hit" or "All TP hit"
  * "Profit: +$500" or "Current PNL: +10%"
  * "Trade is in profit" or "Position is green"
  * Any message that reports on the status/progress of an existing trade without being a new signal or management command

- "other": Not a signal, management command, or trade update (announcements, general chat, market analysis without signals, etc.)

IMPORTANT: Messages that report target hits, profit updates, or trade status should be classified as "trade_progress_update", not "signal" or "management".

Respond with ONLY a valid JSON object in this exact format (no markdown, no code blocks, no extra text):
{
  "type": "signal",
  "confidence": 0.85,
  "reasoning": "brief explanation"
}

The JSON must be valid and complete. Do not include any other text before or after the JSON object.`;

  try {
    const response = await ollamaClient.generate(prompt, channel);
    
    // Use the robust JSON extractor utility
    const classification = extractAndParseJSON<MessageClassification>(response);
    
    if (!classification) {
      logger.warn('Failed to extract or parse JSON from LLM response', { 
        response: response.substring(0, 200),
        message: message.content.substring(0, 200)
      });
      return { type: 'other', confidence: 0 };
    }
    
    // Validate classification
    if (!['signal', 'management', 'trade_progress_update', 'other'].includes(classification.type)) {
      logger.warn('Invalid classification type', { 
        classification,
        message: message.content.substring(0, 200)
      });
      return { type: 'other', confidence: 0 };
    }

    // Ensure confidence is a valid number
    if (typeof classification.confidence !== 'number' || 
        classification.confidence < 0 || 
        classification.confidence > 1) {
      logger.warn('Invalid confidence value', { 
        confidence: classification.confidence,
        message: message.content.substring(0, 200)
      });
      classification.confidence = 0.5; // Default to medium confidence
    }

    return classification;
  } catch (error) {
    logger.error('Failed to classify message', {
      error: error instanceof Error ? error.message : String(error),
      message: message.content.substring(0, 200)
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
    // Replace time patterns first (e.g., "1 day 8 hrs 1 min" -> "{TIME}")
    // Handle patterns with days first (most specific to least specific)
    // Note: "day" and "days" are both matched with "days?" pattern
    .replace(/\d+\s*days?\s*\d+\s*hrs?\s*\d+\s*min\s*\d+\s*sec/gi, '{TIME}') // days, hours, minutes, seconds
    .replace(/\d+\s*days?\s*\d+\s*hrs?\s*\d+\s*mins?/gi, '{TIME}') // days, hours, minutes
    .replace(/\d+\s*days?\s*\d+\s*hrs?/gi, '{TIME}') // days, hours
    .replace(/\d+\s*days?\s*\d+\s*mins?/gi, '{TIME}') // days, minutes
    // Handle patterns without days
    .replace(/\d+\s*hr\s*\d+\s*min\s*\d+\s*sec/gi, '{TIME}') // hours, minutes, seconds
    .replace(/\d+\s*hr\s*\d+\s*mins?/gi, '{TIME}') // hours, minutes
    .replace(/\d+\s*hr\s*\d+\s*sec/gi, '{TIME}') // hours, seconds
    .replace(/\d+\s*hrs?/gi, '{TIME}') // just hours
    .replace(/\d+\s*mins?/gi, '{TIME}') // just minutes
    // Replace percentages with placeholder (before numbers to avoid conflicts)
    .replace(/\d+\.?\d*\s*%/g, '{PERCENT}')
    // Replace trading pairs with placeholder (before general number replacement)
    // Match pairs like #STG, BTC/USDT, etc. (minimum 2 chars to avoid matching single numbers)
    .replace(/#?[A-Z0-9]{2,}\/?[A-Z0-9]*/gi, '{PAIR}')
    // Replace emoji sequences FIRST (before numbers) to catch keycap emojis like 1️⃣2️⃣3️⃣
    // Keycap emojis contain digits, so we need to match them before number replacement
    // Match: base char + optional variation selector + combining keycap, or any emoji range
    .replace(/[\u0023-\u0039]\uFE0F?\u20E3/gu, '{EMOJI}') // Keycap sequences (0-9, #)
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]+/gu, '{EMOJI}') // Other emojis
    // Collapse multiple consecutive {EMOJI} placeholders (with optional spaces) into one
    .replace(/\{EMOJI\}(\s*\{EMOJI\})*/g, '{EMOJI}')
    // Replace remaining numbers with placeholder (after emojis are handled)
    .replace(/\d+\.?\d*/g, '{NUMBER}')
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
  ollamaConfig?: OllamaConfig,
  messageIds?: string[],
  logInterval: number = 25
): Promise<{
  totalMessages: number;
  signalsFound: number;
  managementFound: number;
  tradeProgressUpdatesFound: number;
  uniqueFormats: number;
}> {
  logger.info('Starting message analysis', { channel, messageIds: messageIds?.length || 'all' });

  // Use a larger model for better classification accuracy
  // llama3.2:1b is very small and may struggle with nuanced classification
  // Recommended models (in order of preference):
  //   - llama3.1:8b or llama3.2:11b (if available) - best for classification
  //   - llama3.2:3b - good middle ground if resources are limited
  //   - llama3.1:70b - largest but requires significant resources
  const modelToUse = ollamaConfig?.model || process.env.OLLAMA_MODEL || 'llama3.1:8b';
  
  if (modelToUse === 'llama3.2:1b') {
    logger.warn('Using llama3.2:1b model - this small model may struggle with nuanced classification. Consider using llama3.1:8b, llama3.2:11b, or llama3.2:3b for better trade_progress_update detection.');
  }

  const ollamaClient = createOllamaClient({
    baseUrl: ollamaConfig?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: modelToUse,
    timeout: ollamaConfig?.timeout || 60000, // Increased to 60s for larger models
    maxRetries: ollamaConfig?.maxRetries || 2,
    maxInputLength: ollamaConfig?.maxInputLength || 8000, // Increased from default 2000
    rateLimit: ollamaConfig?.rateLimit,
  });

  // Check if Ollama is available
  const isAvailable = await ollamaClient.healthCheck();
  if (!isAvailable) {
    throw new Error('Ollama service is not available. Please ensure Ollama is running.');
  }

  // Get messages - either specific IDs or all unanalyzed messages
  let messages: Message[];
  if (messageIds && messageIds.length > 0) {
    // Fetch specific messages by ID (filter out already analyzed ones)
    const fetchedMessages: Message[] = [];
    for (const messageId of messageIds) {
      try {
        const message = await db.getMessageByMessageId(messageId, channel);
        if (message && (!message.analyzed)) {
          fetchedMessages.push(message);
        } else if (message?.analyzed) {
          logger.debug('Message already analyzed, skipping', { messageId, channel });
        } else {
          logger.warn('Message not found', { messageId, channel });
        }
      } catch (error) {
        logger.error('Error fetching message', {
          messageId,
          channel,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    messages = fetchedMessages;
    logger.info('Messages to analyze (by ID)', { channel, requested: messageIds.length, found: messages.length });
  } else {
    // Get all unanalyzed messages for this channel
    messages = await db.getUnanalyzedMessages(channel);
    logger.info('Messages to analyze', { channel, count: messages.length });
  }

  if (messages.length === 0) {
    logger.warn('No messages found for analysis', { channel });
    return {
      totalMessages: 0,
      signalsFound: 0,
      managementFound: 0,
      tradeProgressUpdatesFound: 0,
      uniqueFormats: 0,
    };
  }

  // Load existing formats for this channel to avoid unnecessary Ollama calls
  const existingFormats = await db.getSignalFormats(channel);
  const existingFormatMap = new Map<string, 'signal' | 'management'>();
  for (const format of existingFormats) {
    if (format.classification === 'signal' || format.classification === 'management') {
      existingFormatMap.set(format.format_hash, format.classification);
    }
  }
  logger.info('Loaded existing formats', { channel, count: existingFormatMap.size });

  // Track formats
  const formatMap = new Map<string, {
    pattern: string;
    classification: 'signal' | 'management';
    examples: string[];
    firstSeen: string;
    lastSeen: string;
    saved: boolean; // Track if format has been persisted to database
  }>();

  let signalsFound = 0;
  let managementFound = 0;
  let tradeProgressUpdatesFound = 0;
  let processed = 0;
  let skippedOllama = 0;
  let savedFormats = 0;

  // Helper function to persist a format to the database
  const saveFormatToDatabase = async (hash: string, format: {
    pattern: string;
    classification: 'signal' | 'management';
    examples: string[];
    firstSeen: string;
    lastSeen: string;
  }): Promise<void> => {
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
      logger.error('Error saving format to database', {
        channel,
        hash,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  // Process messages in batches to avoid overwhelming the LLM
  const batchSize = 10;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    
    for (const message of batch) {
      try {
        // Extract format pattern first to check if we can skip Ollama
        const pattern = extractFormatPattern(message.content);
        const hash = hashFormatPattern(pattern);
        
        // Check if this format already exists in our loaded format map
        let classification: MessageClassification | null = null;
        const existingClassification = existingFormatMap.get(hash);
        
        if (existingClassification) {
          // If format exists and is signal or management, use it and skip Ollama
          classification = {
            type: existingClassification,
            confidence: 1.0, // High confidence since we've seen this format before
            reasoning: 'Matched existing format pattern'
          };
          skippedOllama++;
          logger.debug('Skipped Ollama - matched existing format', {
            channel,
            messageId: message.message_id,
            formatHash: hash,
            classification: classification.type
          });
        }
        
        // If no existing format match, classify with Ollama
        if (!classification) {
          classification = await classifyMessage(
            message,
            ollamaClient,
            channel,
            db
          );
        }

        // Log classification for debugging (especially trade_progress_update)
        if (classification.type === 'trade_progress_update' || 
            (classification.type === 'other' && message.content.match(/(target|tp|profit|hit|✅)/i))) {
          logger.debug('Message classification', {
            channel,
            messageId: message.message_id,
            content: message.content.substring(0, 200),
            classification: classification.type,
            confidence: classification.confidence,
            reasoning: classification.reasoning
          });
        }

        // Track actionable types (signal and management) as formats
        // Trade progress updates are informational and don't need format tracking
        if (classification.type === 'signal' || classification.type === 'management') {
          // Update format map
          if (!formatMap.has(hash)) {
            const newFormat = {
              pattern,
              classification: classification.type,
              examples: [message.content],
              firstSeen: message.date,
              lastSeen: message.date,
              saved: false,
            };
            formatMap.set(hash, newFormat);
            // Persist new format to database immediately
            await saveFormatToDatabase(hash, newFormat);
            newFormat.saved = true;
          } else {
            const format = formatMap.get(hash)!;
            format.examples.push(message.content);
            if (message.date < format.firstSeen) {
              format.firstSeen = message.date;
            }
            if (message.date > format.lastSeen) {
              format.lastSeen = message.date;
            }
            // Update existing format in database (example_count and last_seen may have changed)
            await saveFormatToDatabase(hash, format);
            format.saved = true;
          }

          if (classification.type === 'signal') {
            signalsFound++;
          } else {
            managementFound++;
          }
        } else if (classification.type === 'trade_progress_update') {
          tradeProgressUpdatesFound++;
        }

        // Mark message as analyzed after processing
        try {
          await db.markMessageAnalyzed(message.id);
        } catch (error) {
          logger.error('Error marking message as analyzed', {
            channel,
            messageId: message.message_id,
            id: message.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        processed++;
        const remaining = messages.length - processed;
        // Log progress periodically
        if (processed % logInterval === 0 || remaining === 0) {
          logger.info('Analysis progress', {
            channel,
            processed,
            total: messages.length,
            remaining,
            signalsFound,
            managementFound,
            uniqueFormats: formatMap.size,
            skippedOllama
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

  logger.info('Message analysis completed', {
    channel,
    totalMessages: messages.length,
    signalsFound,
    managementFound,
    tradeProgressUpdatesFound,
    uniqueFormats: formatMap.size,
    savedFormats,
    skippedOllama,
    ollamaRequests: messages.length - skippedOllama
  });

  return {
    totalMessages: messages.length,
    signalsFound,
    managementFound,
    tradeProgressUpdatesFound,
    uniqueFormats: formatMap.size,
  };
}

