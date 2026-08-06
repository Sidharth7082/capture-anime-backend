import { Router } from 'express';
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

  // Must be registered before /:animeId/:episode so "prefetch" is not
  // treated as an episode number.
  router.get(
    '/:animeId/prefetch',
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
