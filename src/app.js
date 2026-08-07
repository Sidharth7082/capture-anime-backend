// Express application assembly. Everything is injected so tests can swap in
// fakes; createApp returns a plain app ready for supertest or listen().
import { readFileSync } from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';

import { env, trustProxySetting } from './config/env.js';
import { TtlCache } from './lib/cache.js';
import { logger } from './lib/logger.js';
import { pool } from './db/pool.js';

import { requestLogger } from './middleware/request-logger.js';
import { notFound } from './middleware/not-found.js';
import { errorHandler } from './middleware/error-handler.js';

import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createAnimeRouter, createEpisodesRouter } from './modules/anime/anime.routes.js';
import { createUserRouter } from './modules/user/user.routes.js';
import { createWatchRouter } from './modules/watch/watch.routes.js';
import { createMalRouter } from './modules/mal/mal.routes.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createAnimeRepository } from './modules/anime/anime.repository.js';
import { createAnimeService } from './modules/anime/anime.service.js';
import { createUserRepository } from './modules/user/user.repository.js';
import { createUserService } from './modules/user/user.service.js';
import { createWatchService } from './modules/watch/watch.service.js';
import { createMalRepository } from './modules/mal/mal.repository.js';
import { MalService } from './modules/mal/mal.service.js';
import { AnivexaService } from './services/anivexa.js';

const openapiSpec = YAML.parse(
  readFileSync(new URL('./openapi.yaml', import.meta.url), 'utf8'),
);

function corsOrigin() {
  const origins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.includes('*')) {
    // Credentials (httpOnly refresh cookie) + reflecting any origin would let
    // any website read authenticated responses — never acceptable in prod.
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'CORS_ORIGIN=* is not allowed in production (credentials are enabled). ' +
          'Set an explicit comma-separated origin allowlist.',
      );
    }
    return true; // reflect any origin in development only
  }
  return origins;
}

/**
 * @param {object} deps
 * @param {object} deps.authService
 * @param {object} deps.animeService
 * @param {object} deps.userService
 * @param {object} [deps.watchService]
 * @param {object} [deps.malService]
 * @param {TtlCache} deps.cache
 * @param {object} [deps.authLimiter]
 */
export function createApp({ authService, animeService, userService, watchService, malService, cache, authLimiter, cacheTtlMs = env.CACHE_TTL_MS } = {}) {
  const app = express();

  app.set('trust proxy', trustProxySetting());
  app.disable('x-powered-by');

  // --- global middleware ---------------------------------------------------
  // This service is HTTP-only (home LAN, no TLS termination in front yet).
  // Helmet's default HSTS + `upgrade-insecure-requests` would force browsers
  // to fetch subresources over HTTPS, failing on a plain-HTTP server with
  // ERR_CONNECTION_CLOSED. Disable both; keep the rest of the strict headers.
  app.use(
    helmet({
      strictTransportSecurity: false,
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );
  app.use(cors({ origin: corsOrigin(), credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  // Signed cookies: unsigned cookies keep working via req.cookies (refresh
  // token), signed ones (MAL OAuth PKCE state) land in req.signedCookies.
  app.use(cookieParser(env.COOKIE_SECRET ?? env.JWT_ACCESS_SECRET));
  app.use(requestLogger);

  const globalLimiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: env.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
  });
  app.use('/api', globalLimiter);

  // --- health ---------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', uptime: process.uptime() });
    } catch {
      res.status(503).json({ status: 'degraded', uptime: process.uptime() });
    }
  });

  // --- routers --------------------------------------------------------------
  const effectiveAuthLimiter =
    authLimiter ??
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.AUTH_RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts' } }),
    });

  // Auth responses carry tokens — serving them compressed would set up the
  // BREACH attack precondition, so /api/auth bypasses compression.
  const refreshLimiter =
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.REFRESH_RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many refresh attempts' } }),
    });
  app.use(
    '/api/auth',
    createAuthRouter({
      authService,
      authLimiter: effectiveAuthLimiter,
      refreshLimiter,
    }),
  );

  app.use(compression());
  app.use('/api/anime', createAnimeRouter({ animeService, cache, cacheTtlMs }));
  app.use('/api/episodes', createEpisodesRouter({ animeService, cache, cacheTtlMs }));
  app.use('/api/user', createUserRouter({ userService }));
  if (watchService) {
    app.use('/api/watch', createWatchRouter({ watchService, cache, cacheTtlMs }));
  }
  if (malService) {
    app.use('/api/mal', createMalRouter({ malService }));
  }

  // --- OpenAPI ---------------------------------------------------------------
  // Exposes the full API surface — disabled by default in production unless
  // explicitly enabled with SWAGGER_ENABLED=true.
  const swaggerEnabled =
    env.SWAGGER_ENABLED !== undefined
      ? env.SWAGGER_ENABLED === 'true'
      : env.NODE_ENV !== 'production';
  if (swaggerEnabled) {
    // Swagger UI's bundle uses `new Function` internally, which the global
    // helmet CSP (`script-src 'self'` without `'unsafe-eval'`) blocks, causing
    // a blank page. Relax CSP for /api-docs only — the rest of the API keeps
    // the strict policy.
    app.use('/api-docs', (_req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';" +
          "frame-ancestors 'self';img-src 'self' data:;object-src 'none';" +
          "script-src 'self' 'unsafe-eval';script-src-attr 'none';" +
          "style-src 'self' https: 'unsafe-inline'",
      );
      next();
    });
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
      customSiteTitle: 'Anime Platform API',
    }));
    app.get('/api-docs.json', (_req, res) => res.json(openapiSpec));
  }

  // --- errors ----------------------------------------------------------------
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

/** Production wiring: real repositories over the shared pool. */
export function createProductionApp() {
  const cache = new TtlCache({ ttlMs: env.CACHE_TTL_MS, maxEntries: env.CACHE_MAX_ENTRIES });

  const authRepository = createAuthRepository(pool);
  const animeRepository = createAnimeRepository(pool);
  const userRepository = createUserRepository(pool);
  const malRepository = createMalRepository(pool);

  const authService = createAuthService({ repository: authRepository });
  const animeService = createAnimeService({ repository: animeRepository });
  const userService = createUserService({ repository: userRepository });
  const watchService = createWatchService({ animeRepository, anivexa: new AnivexaService() });
  const malService = new MalService({ repository: malRepository });

  return createApp({ authService, animeService, userService, watchService, malService, cache });
}
