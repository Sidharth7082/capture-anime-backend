// Test environment defaults. Import this FIRST in every test file so
// src/config/env.js validates against a known-good configuration.
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'error';
process.env.DATABASE_URL ??= 'postgres://test@127.0.0.1:5432/test_db';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef0123456789abcdef';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdef0123456789abcdef';
process.env.CACHE_TTL_MS ??= '0';
process.env.MAL_CLIENT_ID ??= 'test-mal-client-id';
process.env.MAL_TOKEN_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef';
process.env.FRONTEND_URL ??= 'http://localhost:5173';
