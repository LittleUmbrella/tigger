/**
 * Loggly API Client
 * 
 * Provides programmatic access to Loggly search API for querying logs.
 * Used by MCP server and investigation scripts.
 */

import https from 'https';
import { URL } from 'url';

export interface LogglySearchOptions {
  query: string;
  from?: string; // ISO 8601 timestamp
  until?: string; // ISO 8601 timestamp
  size?: number; // Number of results (default: 100, max: 10000)
  order?: 'asc' | 'desc'; // Sort order (default: desc)
}

export interface LogglyLogEntry {
  timestamp: string;
  [key: string]: any;
}

export interface LogglySearchResponse {
  total_events: number;
  page: number;
  events: LogglyLogEntry[];
}

export class LogglyClient {
  private subdomain: string;
  private token: string;
  private baseUrl: string;

  constructor(subdomain: string, token: string) {
    this.subdomain = subdomain;
    this.token = token;
    this.baseUrl = `https://${subdomain}.loggly.com/apiv2`;
  }

  /**
   * Search logs using Loggly API
   * Loggly API uses customer token in query parameter, not Bearer auth
   */
  async search(options: LogglySearchOptions): Promise<LogglySearchResponse> {
    const { query, from, until, size = 100, order = 'desc' } = options;

    // Build query parameters
    const params = new URLSearchParams({
      q: query,
      size: size.toString(),
      order,
    });

    // Add customer token (Loggly uses token in query params, not header)
    params.append('token', this.token);

    if (from) {
      params.append('from', from);
    }
    if (until) {
      params.append('until', until);
    }

    const url = `${this.baseUrl}/search?${params.toString()}`;

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Loggly API error: ${res.statusCode} - ${data}`));
            return;
          }

          try {
            const response = JSON.parse(data);
            resolve(response);
          } catch (error) {
            reject(new Error(`Failed to parse Loggly response: ${error}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });
  }

  /**
   * Search logs for a specific message ID
   */
  async searchByMessageId(messageId: number, channel: string, timeRange?: { from: string; until: string }): Promise<LogglySearchResponse> {
    const query = `messageId:${messageId} AND channel:${channel}`;
    return this.search({
      query,
      from: timeRange?.from,
      until: timeRange?.until,
      size: 1000, // Get more results for message-specific searches
    });
  }

  /**
   * Search for errors around a specific timestamp
   */
  async searchErrorsAroundTime(
    timestamp: string,
    windowMinutes: number = 5,
    additionalQuery?: string
  ): Promise<LogglySearchResponse> {
    const fromTime = new Date(new Date(timestamp).getTime() - windowMinutes * 60 * 1000).toISOString();
    const untilTime = new Date(new Date(timestamp).getTime() + windowMinutes * 60 * 1000).toISOString();

    const baseQuery = 'level:error OR "Error" OR "Failed" OR "error"';
    const query = additionalQuery ? `${baseQuery} AND (${additionalQuery})` : baseQuery;

    return this.search({
      query,
      from: fromTime,
      until: untilTime,
      size: 500,
    });
  }

  /**
   * Search for Bybit API errors
   */
  async searchBybitErrors(timeRange?: { from: string; until: string }): Promise<LogglySearchResponse> {
    const query = '"Bybit API" OR "bybit-api" OR "retCode" OR "retMsg"';
    return this.search({
      query,
      from: timeRange?.from,
      until: timeRange?.until,
      size: 500,
    });
  }

  /**
   * Search for order creation failures
   */
  async searchOrderFailures(
    timeRange?: { from: string; until: string },
    accountName?: string
  ): Promise<LogglySearchResponse> {
    let query = '"Failed to create order" OR "Error initiating trade" OR "order creation failed"';
    if (accountName) {
      query += ` AND account_name:${accountName}`;
    }
    return this.search({
      query,
      from: timeRange?.from,
      until: timeRange?.until,
      size: 500,
    });
  }
}

/**
 * Create a Loggly client from environment variables
 * Uses LOGGLY_API_TOKEN if available (for search), otherwise falls back to LOGGLY_TOKEN
 */
export function createLogglyClient(): LogglyClient | null {
  const subdomain = process.env.LOGGLY_SUBDOMAIN;
  // Prefer API token for search, fall back to logging token
  const token = process.env.LOGGLY_API_TOKEN || process.env.LOGGLY_TOKEN;

  if (!subdomain || !token) {
    return null;
  }

  return new LogglyClient(subdomain, token);
}

