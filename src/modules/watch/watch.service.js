// Watch module service: resolves the DB anime id to its AniList id and asks
// the Anivexa provider service for streamable episodes. This module never
// touches the anime metadata tables — it only reads the id mapping.
import { ApiError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export function createWatchService({ animeRepository, anivexa }) {
  return {
    /**
     * Streams for one episode of an anime (by DB anime id).
     * Falls back across configured providers when no explicit one is given.
     */
    async watch(animeId, episode, { provider, audio } = {}) {
      const t0 = performance.now();
      const anilistId = await animeRepository.findAnilistId(animeId);
      if (anilistId == null) {
        throw ApiError.notFound(`Anime ${animeId} not found`);
      }
      logger.info(`[watch] id lookup ${animeId}->${anilistId} in ${(performance.now() - t0).toFixed(0)}ms`);
      return anivexa.getWatch(anilistId, episode, { provider, audio });
    },

    /** Warm the stream cache for the first episodes of an anime (prefetch). */
    async prefetch(animeId, count) {
      const anilistId = await animeRepository.findAnilistId(animeId);
      if (anilistId == null) {
        throw ApiError.notFound(`Anime ${animeId} not found`);
      }
      return anivexa.prefetch(anilistId, count);
    },
  };
}
