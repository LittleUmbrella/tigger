/**
 * Command Parser
 * 
 * Parses slash commands like:
 * /trace message:12345 channel:2394142145
 * /investigate message:12345
 * /analyze trade:123
 */

export interface ParsedCommand {
  command: string;
  args: Record<string, string | number>;
  raw: string;
}

/**
 * Parse a slash command string
 * 
 * Examples:
 *   "/trace message:12345 channel:2394142145" 
 *   → { command: "trace", args: { message: 12345, channel: "2394142145" } }
 * 
 *   "/investigate message:12345"
 *   → { command: "investigate", args: { message: 12345 } }
 */
export function parseCommand(input: string): ParsedCommand | null {
  // Remove leading/trailing whitespace
  const trimmed = input.trim();
  
  // Must start with /
  if (!trimmed.startsWith('/')) {
    return null;
  }

  // Remove leading /
  const withoutSlash = trimmed.substring(1);
  
  // Split into command and args
  const parts = withoutSlash.split(/\s+/);
  const command = parts[0];
  
  if (!command) {
    return null;
  }

  // Parse arguments (key:value format)
  const args: Record<string, string | number> = {};
  
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const colonIndex = part.indexOf(':');
    
    if (colonIndex === -1) {
      // No colon, treat as positional arg or flag
      // For now, skip or handle as boolean flag
      continue;
    }
    
    const key = part.substring(0, colonIndex);
    const value = part.substring(colonIndex + 1);
    
    // Keep messageId and channel as strings to avoid precision loss with large integers
    // Other numeric values can be parsed as numbers if needed
    if (key === 'message' || key === 'messageId' || key === 'channel') {
      args[key] = value; // Keep as string
    } else {
      // Try to parse as number if it's numeric (for smaller values like trade IDs)
      const numValue = Number(value);
      args[key] = isNaN(numValue) ? value : numValue;
    }
  }

  return {
    command,
    args,
    raw: trimmed
  };
}

/**
 * Parse command from various input formats
 * Handles both slash commands and natural language
 */
export function parseCommandFlexible(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  
  // Try slash command first
  if (trimmed.startsWith('/')) {
    return parseCommand(trimmed);
  }
  
  // Try to extract command from natural language
  // e.g., "trace message 12345" → /trace message:12345
  const lower = trimmed.toLowerCase();
  
  // Common patterns
  if (lower.startsWith('trace') || lower.includes('trace message')) {
    const messageMatch = trimmed.match(/message[:\s]+(\d+)/i);
    const channelMatch = trimmed.match(/channel[:\s]+(\d+)/i);
    
    if (messageMatch) {
      const args: Record<string, string | number> = {
        message: messageMatch[1] // Keep as string to avoid precision loss
      };
      
      if (channelMatch) {
        args.channel = channelMatch[1]; // Keep as string
      }
      
      return {
        command: 'trace',
        args,
        raw: trimmed
      };
    }
  }
  
  if (lower.startsWith('investigate') || lower.includes('investigate message')) {
    const messageMatch = trimmed.match(/message[:\s]+(\d+)/i);
    
    if (messageMatch) {
      return {
        command: 'investigate',
        args: {
          message: messageMatch[1] // Keep as string to avoid precision loss
        },
        raw: trimmed
      };
    }
  }
  
  if (lower.startsWith('analyze') || lower.includes('analyze trade')) {
    const tradeMatch = trimmed.match(/trade[:\s]+(\d+)/i);
    
    if (tradeMatch) {
      return {
        command: 'analyze',
        args: {
          trade: parseInt(tradeMatch[1])
        },
        raw: trimmed
      };
    }
  }
  
  return null;
}

