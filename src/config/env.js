// ============================================================================
// Environment configuration — validated once at startup with Zod.
// The process exits with a clear error if a required variable is missing or
// malformed, instead of failing later at request time.
// ============================================================================

import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Secrets must be strong: at least 32 chars (256-bit) for HS256.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().min(1).default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().min(1).default('30d'),

  CORS_ORIGIN: z.string().default('*'), // comma-separated list, or * for all
  TRUST_PROXY: z.string().default('false'), // 'false' | 'true' | number of hops

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
  LOG_FILE: z.string().optional(),

  CACHE_TTL_MS: z.coerce.number().int().min(0).default(60_000), // 0 disables
  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

/** Parses a jwt-style duration ('15m', '30d', '1h') into milliseconds. */
export function parseDuration(value) {
  const match = /^(\d+)\s*(s|m|h|d|w)?$/i.exec(String(value).trim());
  if (!match) throw new Error(`Invalid duration: "${value}"`);
  const amount = Number(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return amount * multipliers[unit];
}

/** Express 'trust proxy' setting: false | true | hop count. */
export function trustProxySetting() {
  const value = env.TRUST_PROXY.toLowerCase();
  if (value === 'false') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  return Number.isFinite(hops) && hops >= 0 ? hops : false;
}
