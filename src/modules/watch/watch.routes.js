import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../../middleware/validate.js';
import { cacheResponse } from '../../middleware/cache.js';
import { createWatchController } from './watch.controller.js';
import { watchParams, watchQuery, prefetchParams, prefetchQuery } from './watch.schemas.js';

export function createWatchRouter({ watchService, cache, cacheTtlMs }) {
  const router = Router();
  const controller = createWatchController(watchService);
  // Stream results are cached 30 min (configurable via ANIVEXA_CACHE_TTL_MS) so
  // repeated requests for the same episode don't hammer the streaming API.
  const cached = cacheResponse(cache, { ttlMs: Math.min(cacheTtlMs, 30 * 60_000) });

  // prefetch spawns count × providers background probes against the upstream
  // streaming API (whose own cache is often disabled), so it gets its own
  // much tighter limit than the global API limiter.
  const prefetchLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many prefetch requests' } }),
  });

  // Must be registered before /:animeId/:episode so "prefetch" is not
  // treated as an episode number.
  router.get(
    '/:animeId/prefetch',
    prefetchLimiter,
    validate({ params: prefetchParams, query: prefetchQuery }),
    controller.prefetch,
  );

  router.get(
    '/:animeId/:episode',
    cached,
    validate({ params: watchParams, query: watchQuery }),
    controller.watch,
  );

  return router;
}
