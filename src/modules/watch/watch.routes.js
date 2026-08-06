import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { cacheResponse } from '../../middleware/cache.js';
import { createWatchController } from './watch.controller.js';
import { watchParams, watchQuery } from './watch.schemas.js';

export function createWatchRouter({ watchService, cache, cacheTtlMs }) {
  const router = Router();
  const controller = createWatchController(watchService);
  // Short-TTL cache (the Anivexa service adds its own upstream cache too) so
  // repeated requests for the same episode don't hammer the streaming API.
  const cached = cacheResponse(cache, { ttlMs: Math.min(cacheTtlMs, 60_000) });

  router.get(
    '/:animeId/:episode',
    cached,
    validate({ params: watchParams, query: watchQuery }),
    controller.watch,
  );

  return router;
}
