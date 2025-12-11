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

/**
 * Rate limiter for LLM calls
 */
class LLMRateLimiter {
  private channelCounts: Map<string, number[]> = new Map();
  private globalCounts: number[] = [];
  private perChannelLimit: number;
  private perMinuteLimit: number;

  constructor(perChannelLimit: number = 10, perMinuteLimit: number = 30) {
    this.perChannelLimit = perChannelLimit;
    this.perMinuteLimit = perMinuteLimit;
  }

  /**
   * Check if a request is allowed and record it
   */
  checkAndRecord(channel: string): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Clean old entries
    this.cleanOldEntries(oneMinuteAgo);

    // Check channel limit
    const channelCounts = this.channelCounts.get(channel) || [];
    if (channelCounts.length >= this.perChannelLimit) {
      return false;
    }

    // Check global limit
    if (this.globalCounts.length >= this.perMinuteLimit) {
      return false;
    }

    // Record the request
    channelCounts.push(now);
    this.channelCounts.set(channel, channelCounts);
    this.globalCounts.push(now);

    return true;
  }

  private cleanOldEntries(threshold: number): void {
    // Clean channel counts
    const channels = Array.from(this.channelCounts.keys());
    for (const channel of channels) {
      const counts = this.channelCounts.get(channel);
      if (counts) {
        const filtered = counts.filter((time) => time > threshold);
        if (filtered.length === 0) {
          this.channelCounts.delete(channel);
        } else {
          this.channelCounts.set(channel, filtered);
        }
      }
    }

    // Clean global counts
    this.globalCounts = this.globalCounts.filter((time) => time > threshold);
  }
}

/**
 * Ollama client with retry and timeout support
 */
export class OllamaClient {
  private baseUrl: string;
  private model: string;
  private timeout: number;
  private maxRetries: number;
  private rateLimiter: LLMRateLimiter | null = null;

  constructor(config: OllamaConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model || 'llama3.2:1b';
    this.timeout = config.timeout || 30000;
    this.maxRetries = config.maxRetries || 2;

    if (config.rateLimit) {
      this.rateLimiter = new LLMRateLimiter(
        config.rateLimit.perChannel || 10,
        config.rateLimit.perMinute || 30
      );
    }
  }

  /**
   * Generate a response from the LLM
   */
  async generate(prompt: string, channel: string = 'default'): Promise<string> {
    // Check rate limits
    if (this.rateLimiter && !this.rateLimiter.checkAndRecord(channel)) {
      throw new Error('Rate limit exceeded. Please try again later.');
    }

    // Sanitize input
    const sanitizedPrompt = this.sanitizeInput(prompt);
    if (!sanitizedPrompt) {
      throw new Error('Input too long or invalid');
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.makeRequest(sanitizedPrompt);
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < this.maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
          logger.warn('LLM request failed, retrying', {
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            delay,
            error: lastError.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('LLM request failed after retries');
  }

  private async makeRequest(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { response?: string };
      return data.response || '';
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`LLM request timeout after ${this.timeout}ms`);
      }
      
      throw error;
    }
  }

  private sanitizeInput(input: string): string | null {
    // Limit message length to prevent token bloat
    const MAX_LENGTH = 2000;
    if (input.length > MAX_LENGTH) {
      logger.warn('Input too long, truncating', { originalLength: input.length, maxLength: MAX_LENGTH });
      return input.substring(0, MAX_LENGTH);
    }

    // Basic sanitization - remove null bytes and other control characters
    return input.replace(/\0/g, '').trim() || null;
  }

  /**
   * Check if the Ollama service is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout for health check
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

