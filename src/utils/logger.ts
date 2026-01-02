import winston from 'winston';
import { Loggly } from 'winston-loggly-bulk';

const transports: (winston.transports.FileTransportInstance | Loggly | winston.transports.ConsoleTransportInstance)[] = [
  new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
  new winston.transports.File({ filename: 'logs/combined.log' }),
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

if (!process.env.LOGGLY_TOKEN || !process.env.LOGGLY_SUBDOMAIN) {
  console.error(`LOGGLY_TOKEN and LOGGLY_SUBDOMAIN must be set, got ...${process.env.LOGGLY_TOKEN?.slice(-4) ?? '<no token>' } and ...${process.env.LOGGLY_SUBDOMAIN?.slice(-4) ?? '<no subdomain>' }`);
} else {
  transports.push(new Loggly({
    token: process.env.LOGGLY_TOKEN!,
    subdomain: process.env.LOGGLY_SUBDOMAIN!,
    tags: ['tigger-bot', process.env.LOGGLY_SOURCE_TAG || ''],
    json: true,
  }));
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'tigger-bot' },
  transports
});
