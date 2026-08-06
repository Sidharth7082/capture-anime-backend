// Winston logger. Structured JSON in production, human-readable in dev.
import winston from 'winston';
import { env } from '../config/env.js';

const isProduction = env.NODE_ENV === 'production';

const consoleFormat = isProduction
  ? winston.format.json()
  : winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level}: ${message}${extra}`;
      }),
    );

const transports = [new winston.transports.Console({ format: consoleFormat })];

if (env.LOG_FILE) {
  transports.push(new winston.transports.File({ filename: env.LOG_FILE, format: winston.format.json() }));
}

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.errors({ stack: true }),
  transports,
});
