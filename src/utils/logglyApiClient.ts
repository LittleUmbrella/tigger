/**
 * Loggly API Client (for reading/searching logs via API)
 * 
 * This client is for INVESTIGATIONS - reading/searching logs via Loggly API.
 * 
 * IMPORTANT: This is SEPARATE from logging:
 * - Logging (writing logs): winston-loggly-bulk uses LOGGLY_TOKEN
 * - API Calls (reading/searching): This client uses LOGGLY_API_TOKEN
 * 
 * These are completely separate tokens with different purposes.
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
  daysBack?: number; // Number of days to search back (default: 5, max: 30)
  windowHours?: number; // Hours per search window (default: 6 for faster searches)
}

export interface LogglyLogEntry {
  timestamp: string;
  [key: string]: any;
}

export interface LogglySearchResponse {
  total_events?: number;
  page?: number;
  events?: LogglyLogEntry[];
  rsid?: {
    status: 'PENDING' | 'COMPLETE';
    id: string;
    date_from: number;
    date_to: number;
    elapsed_time?: number;
  };
}

export class LogglyApiClient {
  private subdomain: string;
  private token: string;
  private username?: string;
  private baseUrl: string;

  constructor(subdomain: string, token: string, username?: string) {
    this.subdomain = subdomain;
    this.token = token;
    this.username = username;
    this.baseUrl = `https://${subdomain}.loggly.com/apiv2`;
  }

  /**
   * Search logs using Loggly API
   * Loggly API v2 supports multiple auth methods:
   * 1. Customer token in query parameter (legacy)
   * 2. Basic Auth with username:token (recommended)
   * 
   * If no time range is specified, searches back 5 days in 24-hour windows.
   */
  async search(options: LogglySearchOptions): Promise<LogglySearchResponse> {
    const { 
      query, 
      from, 
      until, 
      size = 100, 
      order = 'desc',
      daysBack = 5,
      windowHours = 6
    } = options;

    // If no time range specified, search back daysBack days in windows
    if (!from && !until) {
      return this.searchInWindows(query, daysBack, windowHours, size, order);
    }

    // Build query parameters for single window search
    const params = new URLSearchParams({
      q: query,
      size: size.toString(),
      order,
    });

    if (from) {
      params.append('from', from);
    }
    if (until) {
      params.append('until', until);
    }

    const url = `${this.baseUrl}/search?${params.toString()}`;

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      
      // Use Bearer token authentication (required for API tokens)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      };
      
      // If username is provided, use Basic Auth instead (for account-based auth)
      if (this.username) {
        const auth = Buffer.from(`${this.username}:${this.token}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }
      
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers,
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            let errorMsg = `Loggly API error: ${res.statusCode}`;
            try {
              const errorData = JSON.parse(data);
              errorMsg += ` - ${errorData.message || data}`;
            } catch {
              errorMsg += ` - ${data}`;
            }
            if (res.statusCode === 401) {
              errorMsg += '\n\nPossible issues:';
              errorMsg += '\n- Invalid or expired API token';
              errorMsg += '\n- Token may require account username/email for Basic Auth';
              errorMsg += '\n- Check Loggly dashboard: Settings → Source Setup → Customer Tokens';
              errorMsg += '\n- Or Settings → Account → API Keys';
            }
            reject(new Error(errorMsg));
            return;
          }

          try {
            const response = JSON.parse(data);
            
            // If response has rsid with PENDING status, poll for results
            if (response.rsid && response.rsid.status === 'PENDING') {
              // Poll for results using the rsid
              this.pollSearchResults(response.rsid.id)
                .then(resolve)
                .catch(reject);
              return;
            }
            
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
   * Poll for search results using rsid
   */
  private async pollSearchResults(rsid: string, maxAttempts: number = 10, delayMs: number = 2000): Promise<LogglySearchResponse> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
      // Use /events endpoint for polling, not /search
      // /search?rsid=... creates a new search, /events?rsid=... returns results
      const url = `${this.baseUrl}/events?rsid=${rsid}`;
      
      const result = await new Promise<LogglySearchResponse>((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`,
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
              // If we have events, return them even if status is PENDING
              if (response.events && response.events.length > 0) {
                resolve(response);
                return;
              }
              if (response.rsid && response.rsid.status === 'PENDING') {
                // Still pending, will retry
                reject(new Error('PENDING'));
                return;
              }
              // If status is COMPLETE or we have results, return them
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
      }).catch(error => {
        if (error.message === 'PENDING') {
          return null; // Signal to retry
        }
        throw error;
      });

      if (result) {
        return result;
      }
    }

    throw new Error(`Search timed out after ${maxAttempts} attempts`);
  }

  /**
   * Search logs in time windows, iterating backwards
   */
  private async searchInWindows(
    query: string,
    daysBack: number,
    windowHours: number,
    size: number,
    order: 'asc' | 'desc'
  ): Promise<LogglySearchResponse> {
    const now = new Date();
    const windowMs = windowHours * 60 * 60 * 1000;
    const allEvents: LogglyLogEntry[] = [];
    let totalEvents = 0;

    // Iterate backwards from now, one window at a time
    for (let day = 0; day < daysBack; day++) {
      const untilTime = new Date(now.getTime() - day * windowMs);
      const fromTime = new Date(untilTime.getTime() - windowMs);

      try {
        const result = await this.searchSingleWindow({
          query,
          from: fromTime.toISOString(),
          until: untilTime.toISOString(),
          size,
          order,
        });

        if (result.events && result.events.length > 0) {
          allEvents.push(...result.events);
          totalEvents += result.total_events || result.events.length;
        }

        // If we got fewer results than requested, we've likely found everything in this window
        // Continue to next window to be thorough
      } catch (error) {
        // Log error but continue with next window
        // Timeouts are common with Loggly - continue searching other windows
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!errorMsg.includes('timed out')) {
          console.warn(`Search failed for window ${fromTime.toISOString()} to ${untilTime.toISOString()}:`, errorMsg);
        }
        // Continue to next window even on timeout
      }
    }

    // Sort events by timestamp
    allEvents.sort((a, b) => {
      const timeA = new Date(a.timestamp || a.event?.timestamp || 0).getTime();
      const timeB = new Date(b.timestamp || b.event?.timestamp || 0).getTime();
      return order === 'desc' ? timeB - timeA : timeA - timeB;
    });

    // Limit to requested size
    const limitedEvents = allEvents.slice(0, size);

    return {
      total_events: totalEvents,
      page: 0,
      events: limitedEvents,
    };
  }

  /**
   * Search a single time window
   */
  private async searchSingleWindow(options: {
    query: string;
    from: string;
    until: string;
    size: number;
    order: 'asc' | 'desc';
  }): Promise<LogglySearchResponse> {
    const { query, from, until, size, order } = options;

    // Build query parameters
    const params = new URLSearchParams({
      q: query,
      size: size.toString(),
      order,
      from,
      until,
    });

    const url = `${this.baseUrl}/search?${params.toString()}`;

    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      
      // Use Bearer token authentication (required for API tokens)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      };
      
      // If username is provided, use Basic Auth instead (for account-based auth)
      if (this.username) {
        const auth = Buffer.from(`${this.username}:${this.token}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }
      
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers,
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            let errorMsg = `Loggly API error: ${res.statusCode}`;
            try {
              const errorData = JSON.parse(data);
              errorMsg += ` - ${errorData.message || data}`;
            } catch {
              errorMsg += ` - ${data}`;
            }
            reject(new Error(errorMsg));
            return;
          }

          try {
            const response = JSON.parse(data);
            
            // If response has rsid with PENDING status, poll for results
            if (response.rsid && response.rsid.status === 'PENDING') {
              // Poll for results using the rsid
              this.pollSearchResults(response.rsid.id)
                .then(resolve)
                .catch(reject);
              return;
            }
            
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
  async searchByMessageId(messageId: number, channel: string, timeRange?: { from: string; until: string }, daysBack?: number): Promise<LogglySearchResponse> {
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
 * Create a Loggly API client for reading/searching logs via API
 * 
 * IMPORTANT: This is ONLY for API calls (reading/searching logs), NOT for logging.
 * 
 * Logging vs API Calls:
 * - Logging (writing): winston-loggly-bulk uses LOGGLY_TOKEN
 * - API Calls (reading): This client uses LOGGLY_API_TOKEN
 * 
 * These are completely separate tokens with different purposes.
 * 
 * Supports LOGGLY_USERNAME for Basic Auth (if required by your Loggly account)
 */
export function createLogglyApiClient(): LogglyApiClient | null {
  const subdomain = process.env.LOGGLY_SUBDOMAIN;
  // MUST use API token - do NOT use LOGGLY_TOKEN (that's for logging via winston)
  const token = process.env.LOGGLY_API_TOKEN;
  const username = process.env.LOGGLY_USERNAME;

  if (!subdomain || !token) {
    return null;
  }

  return new LogglyApiClient(subdomain, token, username);
}

