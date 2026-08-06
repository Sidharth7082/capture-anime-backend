import '../../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { validate } from '../../../src/middleware/validate.js';
import { z } from 'zod';

function makeApp(schemas) {
  const app = express();
  app.use(express.json());
  app.post('/test', validate(schemas), (req, res) => res.json({ ok: true, body: req.body, query: req.query }));
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message, details: err.details } });
  });
  return app;
}

test('valid body passes through (coerced)', async () => {
  const app = makeApp({
    body: z.object({ page: z.coerce.number().int().positive(), name: z.string().min(1) }),
  });
  const res = await request(app).post('/test').send({ page: '3', name: 'x' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.body, { page: 3, name: 'x' });
});

test('invalid body returns 400 with structured details', async () => {
  const app = makeApp({
    body: z.object({ email: z.string().email() }),
  });
  const res = await request(app).post('/test').send({ email: 'nope' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.equal(res.body.error.details[0].path, 'email');
});

test('missing required field is caught', async () => {
  const app = makeApp({
    body: z.object({ password: z.string().min(8) }),
  });
  const res = await request(app).post('/test').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error.details[0].path, 'password');
});

test('query validation applies too', async () => {
  const app = makeApp({
    query: z.object({ limit: z.coerce.number().int().max(5) }),
  });
  const res = await request(app).post('/test?limit=999').send({});
  assert.equal(res.status, 400);
});
