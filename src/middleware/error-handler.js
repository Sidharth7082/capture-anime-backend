// Central error handler. Maps known error types to clean JSON responses and
// logs unexpected (500) errors without leaking internals.
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { redactSensitiveQuery } from '../lib/redact.js';

// PostgreSQL error codes -> HTTP status
const PG_STATUS = {
  23505: 409, // unique_violation
  23503: 400, // foreign_key_violation (referenced row missing)
  23514: 400, // check_violation
  23502: 400, // not_null_violation
  '22P02': 400, // invalid_text_representation (e.g. bad enum value)
};

const PG_MESSAGE = {
  23505: 'Resource already exists',
  23503: 'Referenced resource does not exist',
  23514: 'Value violates a database constraint',
  23502: 'A required value is missing',
  '22P02': 'Invalid value provided',
};

function isPgError(err) {
  return typeof err?.code === 'string' && /^\d{5}$/.test(err.code);
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = err.status ?? 500;
  let code = err.code ?? 'INTERNAL_ERROR';
  let message = err.message ?? 'Internal server error';
  let details = err.details;

  if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Invalid request payload';
    details = err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
  } else if (isPgError(err)) {
    status = PG_STATUS[err.code] ?? 400;
    code = 'DATABASE_ERROR';
    message = PG_MESSAGE[err.code] ?? 'Database error';
  }

  if (status >= 500) {
    logger.error(`[${req.method} ${redactSensitiveQuery(req.originalUrl)}] ${err.stack || err.message}`);
    // Sanitize 5xx messages unless the error explicitly opted in to exposing
    // a safe diagnostic (e.g. missing env var names on an authed endpoint).
    if (!err.expose) {
      message = 'Internal server error';
      code = 'INTERNAL_ERROR';
      details = undefined;
    }
  } else {
    logger.warn(`[${req.method} ${redactSensitiveQuery(req.originalUrl)}] ${status} ${code}: ${message}`);
  }

  const body = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}
