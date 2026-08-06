import '../helpers/env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagination, buildPaginationMeta } from '../../src/lib/pagination.js';

test('parsePagination defaults', () => {
  assert.deepEqual(parsePagination({}), { page: 1, limit: 20, offset: 0 });
});

test('parsePagination honors explicit values', () => {
  assert.deepEqual(parsePagination({ page: '3', limit: '10' }), { page: 3, limit: 10, offset: 20 });
});

test('parsePagination clamps garbage and oversize', () => {
  assert.deepEqual(parsePagination({ page: 'abc', limit: '9999' }), { page: 1, limit: 100, offset: 0 });
  assert.deepEqual(parsePagination({ page: '0', limit: '-5' }), { page: 1, limit: 20, offset: 0 });
});

test('parsePagination custom defaults', () => {
  assert.deepEqual(parsePagination({}, { defaultLimit: 50, maxLimit: 50 }), { page: 1, limit: 50, offset: 0 });
});

test('buildPaginationMeta', () => {
  const meta = buildPaginationMeta({ page: 2, limit: 20, total: 250 });
  assert.equal(meta.totalPages, 13);
  assert.equal(meta.hasNextPage, true);
  assert.equal(meta.total, 250);
});

test('buildPaginationMeta empty and last page', () => {
  assert.equal(buildPaginationMeta({ page: 1, limit: 20, total: 0 }).totalPages, 0);
  assert.equal(buildPaginationMeta({ page: 13, limit: 20, total: 250 }).hasNextPage, false);
});
