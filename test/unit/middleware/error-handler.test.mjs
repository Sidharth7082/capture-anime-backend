import '../../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from '../../../src/middleware/error-handler.js';
import { ApiError } from '../../../src/lib/errors.js';
import { ZodError } from 'zod';

function capture() {
  let captured;
  const res = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      captured = { status: this.statusCode, body };
      return this;
    },
  };
  return { res, result: () => captured };
}

const req = { method: 'GET', originalUrl: '/x' };

test('ApiError maps to its status and code', () => {
  const { res, result } = capture();
  errorHandler(ApiError.notFound('Anime 5 not found'), req, res, () => {});
  assert.equal(result().status, 404);
  assert.equal(result().body.error.code, 'NOT_FOUND');
  assert.equal(result().body.error.message, 'Anime 5 not found');
});

test('ZodError maps to 400 VALIDATION_ERROR', () => {
  const schema = new ZodError([{ path: ['email'], message: 'Invalid email', code: 'invalid_string' }]);
  const { res, result } = capture();
  errorHandler(schema, req, res, () => {});
  assert.equal(result().status, 400);
  assert.equal(result().body.error.code, 'VALIDATION_ERROR');
  assert.equal(result().body.error.details[0].path, 'email');
});

test('PostgreSQL unique violation maps to 409', () => {
  const pgError = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'users_email_lower_uidx' });
  const { res, result } = capture();
  errorHandler(pgError, req, res, () => {});
  assert.equal(result().status, 409);
  assert.equal(result().body.error.code, 'DATABASE_ERROR');
});

test('PostgreSQL FK violation maps to 400', () => {
  const pgError = Object.assign(new Error('fk'), { code: '23503' });
  const { res, result } = capture();
  errorHandler(pgError, req, res, () => {});
  assert.equal(result().status, 400);
});

test('unknown error maps to 500 without leaking internals', () => {
  const { res, result } = capture();
  errorHandler(new Error('secret db credentials leaked'), req, res, () => {});
  assert.equal(result().status, 500);
  assert.equal(result().body.error.code, 'INTERNAL_ERROR');
  assert.equal(result().body.error.message, 'Internal server error');
  assert.equal(result().body.error.details, undefined);
});
