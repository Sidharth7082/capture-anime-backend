// Watch module service: resolves the DB anime id to its AniList id and asks
// the Anivexa provider service for streamable episodes. This module never
// touches the anime metadata tables — it only reads the id mapping.
import { ApiError } from '../../lib/errors.js';

export function createWatchService({ animeRepository, anivexa }) {
  return {
    /**
     * Streams for one episode of an anime (by DB anime id).
     * Falls back across configured providers when no explicit one is given.
     */
    async watch(animeId, episode, { provider, audio } = {}) {
      const anilistId = await animeRepository.findAnilistId(animeId);
      if (anilistId == null) {
        throw ApiError.notFound(`Anime ${animeId} not found`);
      }
      return anivexa.getWatch(anilistId, episode, { provider, audio });
    },
  };
}
