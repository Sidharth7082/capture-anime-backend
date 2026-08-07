// Per-request access logging: method, path, status, duration.
import { logger } from '../lib/logger.js';
import { redactSensitiveQuery } from '../lib/redact.js';

export function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(
      `${req.method} ${redactSensitiveQuery(req.originalUrl)} -> ${res.statusCode} ${durationMs.toFixed(1)}ms`,
    );
  });
  next();
}
