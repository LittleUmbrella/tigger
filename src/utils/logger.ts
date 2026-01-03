import winston, { format } from 'winston';
import { Loggly } from 'winston-loggly-bulk';
import redact from 'fast-redact';

// Keys or paths to redact fully
const redactPaths = ['password', 'token', 'key', 'secret', 'user.password', 'auth.token'];

// Create a redactor function from fast-redact
// Without serialize: true, redactor expects an object and returns a mutated object
const redactor = redact({
  paths: redactPaths,
  censor: '[REDACTED]',
  serialize: false
});

// Regex patterns to redact sensitive strings anywhere in string fields
const sensitivePatterns = [
  // Bybit API keys: typically 19-40 alphanumeric characters
  // Must contain at least one number, one uppercase, and one lowercase character
  /\b(?=.*[0-9])(?=.*[A-Z])(?=.*[a-z])[A-Za-z0-9]{19,40}\b/g,
  // Bybit API secrets: typically 32-64 alphanumeric characters
  // Must contain at least one number, one uppercase, and one lowercase character
  /\b(?=.*[0-9])(?=.*[A-Z])(?=.*[a-z])[A-Za-z0-9]{32,64}\b/g
];

// Recursive function to apply regex replacements on all strings
function redactStrings(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    let redactedStr = obj;
    for (const pattern of sensitivePatterns) {
      redactedStr = redactedStr.replace(pattern, '[REDACTED]');
    }
    return redactedStr;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactStrings);
  }

  if (typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const key in obj) {
      result[key] = redactStrings(obj[key]);
    }
    return result;
  }

  return obj;
}

// Custom Winston format using fast-redact and additional regex redaction
const redactFormat = format((info) => {
  // Always return info, even if redaction fails
  // This ensures logs are never lost due to formatting errors
  if (!info || typeof info !== 'object') {
    return info;
  }

  try {
    // First, redact keys using fast-redact
    try {
      // Create a plain object copy for redaction (handles circular refs)
      const plainObject = JSON.parse(JSON.stringify(info));
      // Redact the plain object (mutates in place)
      redactor(plainObject);
      // Apply regex redaction to the redacted object
      const regexRedacted = redactStrings(plainObject);
      // Copy redacted values back to info, preserving Winston's structure
      Object.keys(regexRedacted).forEach(key => {
        if (key in info && typeof key === 'string') {
          try {
            info[key] = regexRedacted[key];
          } catch {
            // Ignore individual key assignment errors
          }
        }
      });
    } catch (error) {
      // If serialization fails, just apply regex redaction directly to info
      // This is a fallback that won't redact paths but will still catch API keys/secrets in strings
      try {
        const regexRedacted = redactStrings(info);
        Object.keys(regexRedacted).forEach(key => {
          if (key in info && typeof key === 'string') {
            try {
              info[key] = regexRedacted[key];
            } catch {
              // Ignore individual key assignment errors
            }
          }
        });
      } catch {
        // If regex redaction also fails, continue with original info
      }
    }
  } catch (error) {
    // If everything fails, return info as-is to ensure the log is not lost
    // Logging here would cause infinite recursion, so we silently fail
  }

  // Always return the info object so Winston can continue processing
  // Winston format functions must return TransformableInfo or false
  return info;
});

const transports: (winston.transports.FileTransportInstance | Loggly | winston.transports.ConsoleTransportInstance)[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf((info: any) => {
        const { timestamp, level, message, ...meta } = info;
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} [${level}]: ${message} ${metaStr}`;
      })
    )
  })
];

if (process.env.NODE_ENV !== 'production') {
  transports.push(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
  transports.push(new winston.transports.File({ filename: 'logs/combined.log' }));
}

if (!process.env.LOGGLY_TOKEN || !process.env.LOGGLY_SUBDOMAIN) {
  console.error(`LOGGLY_TOKEN and LOGGLY_SUBDOMAIN must be set, got ...${process.env.LOGGLY_TOKEN?.slice(-4) ?? '<no token>' } and ...${process.env.LOGGLY_SUBDOMAIN?.slice(-4) ?? '<no subdomain>' }`);
} else {
  if (process.env.LOGGLY_ENABLED === 'true') {
    console.info(`LOGGLY_ENABLED is set to true, adding Loggly transport with ...${process.env.LOGGLY_TOKEN?.slice(-4) ?? '<no token>' } and ...${process.env.LOGGLY_SUBDOMAIN?.slice(-4) ?? '<no subdomain>' } and tags [tigger-bot, ${process.env.LOGGLY_SOURCE_TAG || 'unknown source'}]`);
    transports.push(new Loggly({
      token: process.env.LOGGLY_TOKEN!,
      subdomain: process.env.LOGGLY_SUBDOMAIN!,
      tags: ['tigger-bot', process.env.LOGGLY_SOURCE_TAG || 'unknown source'],
      json: true,
    }));
  } else {
    console.warn('LOGGLY_ENABLED is not set to true, skipping Loggly transport');
  }
}

// Create logger with error handling to ensure logs are never lost
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    redactFormat(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'tigger-bot' },
  transports,
  // Handle exceptions and rejections to prevent log loss
  exceptionHandlers: transports,
  rejectionHandlers: transports
});
