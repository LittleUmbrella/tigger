/**
 * Ollama LLM client wrapper with retry logic, timeout handling, and rate limiting
 */
import { logger } from './logger.js';

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  rateLimit?: {
    perChannel?: number;
    perMinute?: number;
  };
}

interface LLMRateLimiterState {
  channelCounts: Map<string, number[]>;
  globalCounts: number[];
  perChannelLimit: number;
  perMinuteLimit: number;
}

interface LLMRateLimiter {
  checkAndRecord: (channel: string) => boolean;
}

function createLLMRateLimiter(perChannelLimit: number = 10, perMinuteLimit: number = 30): LLMRateLimiter {
  const state: LLMRateLimiterState = {
    channelCounts: new Map(),
    globalCounts: [],
    perChannelLimit,
    perMinuteLimit,
  };

  function cleanOldEntries(threshold: number): void {
    // Clean channel counts
    const channels = Array.from(state.channelCounts.keys());
    for (const channel of channels) {
      const counts = state.channelCounts.get(channel);
      if (counts) {
        const filtered = counts.filter((time) => time > threshold);
        if (filtered.length === 0) {
          state.channelCounts.delete(channel);
        } else {
          state.channelCounts.set(channel, filtered);
        }
      }
    }

    // Clean global counts
    state.globalCounts = state.globalCounts.filter((time) => time > threshold);
  }

  return {
    checkAndRecord: (channel: string): boolean => {
      const now = Date.now();
      const oneMinuteAgo = now - 60000;

      // Clean old entries
      cleanOldEntries(oneMinuteAgo);

      // Check channel limit
      const channelCounts = state.channelCounts.get(channel) || [];
      if (channelCounts.length >= state.perChannelLimit) {
        return false;
      }

      // Check global limit
      if (state.globalCounts.length >= state.perMinuteLimit) {
        return false;
      }

      // Record the request
      channelCounts.push(now);
      state.channelCounts.set(channel, channelCounts);
      state.globalCounts.push(now);

      return true;
    },
  };
}

interface OllamaClientState {
  baseUrl: string;
  model: string;
  timeout: number;
  maxRetries: number;
  rateLimiter: LLMRateLimiter | null;
}

export interface OllamaClient {
  generate: (prompt: string, channel?: string) => Promise<string>;
  healthCheck: () => Promise<boolean>;
}

/**
 * Ollama client with retry and timeout support
 */
export function createOllamaClient(config: OllamaConfig = {}): OllamaClient {
  const state: OllamaClientState = {
    baseUrl: config.baseUrl || 'http://localhost:11434',
    model: config.model || 'llama3.2:1b',
    timeout: config.timeout || 30000,
    maxRetries: config.maxRetries || 2,
    rateLimiter: config.rateLimit
      ? createLLMRateLimiter(config.rateLimit.perChannel || 10, config.rateLimit.perMinute || 30)
      : null,
  };

  async function checkModelExists(): Promise<boolean> {
    try {
      const response = await fetch(`${state.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      
      if (!response.ok) {
        return false;
      }
      
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const models = data.models || [];
      return models.some((m) => m.name === state.model || m.name.startsWith(`${state.model}:`));
    } catch (error) {
      return false;
    }
  }

  async function makeRequest(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), state.timeout);

    try {
      const response = await fetch(`${state.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: state.model,
          prompt,
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Check if it's a 404 - likely means model doesn't exist
        if (response.status === 404) {
          const modelExists = await checkModelExists();
          if (!modelExists) {
            throw new Error(
              `Model "${state.model}" not found. Please pull the model first:\n` +
              `  ollama pull ${state.model}\n` +
              `Or if using Docker:\n` +
              `  docker exec -it tigger-ollama ollama pull ${state.model}`
            );
          }
        }
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { response?: string };
      return data.response || '';
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`LLM request timeout after ${state.timeout}ms`);
      }
      
      throw error;
    }
  }

  function sanitizeInput(input: string): string | null {
    // Limit message length to prevent token bloat
    const MAX_LENGTH = 2000;
    if (input.length > MAX_LENGTH) {
      logger.warn('Input too long, truncating', { originalLength: input.length, maxLength: MAX_LENGTH });
      return input.substring(0, MAX_LENGTH);
    }

    // Basic sanitization - remove null bytes and other control characters
    return input.replace(/\0/g, '').trim() || null;
  }

  return {
    generate: async (prompt: string, channel: string = 'default'): Promise<string> => {
      // Check rate limits
      if (state.rateLimiter && !state.rateLimiter.checkAndRecord(channel)) {
        throw new Error('Rate limit exceeded. Please try again later.');
      }

      // Sanitize input
      const sanitizedPrompt = sanitizeInput(prompt);
      if (!sanitizedPrompt) {
        throw new Error('Input too long or invalid');
      }

      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= state.maxRetries; attempt++) {
        try {
          const response = await makeRequest(sanitizedPrompt);
          return response;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          
          if (attempt < state.maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
            logger.warn('LLM request failed, retrying', {
              attempt: attempt + 1,
              maxRetries: state.maxRetries,
              delay,
              error: lastError.message,
            });
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      throw lastError || new Error('LLM request failed after retries');
    },

    healthCheck: async (): Promise<boolean> => {
      try {
        const response = await fetch(`${state.baseUrl}/api/tags`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000), // 5 second timeout for health check
        });
        return response.ok;
      } catch (error) {
        return false;
      }
    },
  };
}
