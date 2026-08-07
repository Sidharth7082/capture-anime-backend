// User business logic.
import { paginate, buildPaginationMeta } from '../../lib/pagination.js';
import { ApiError } from '../../lib/errors.js';

export function createUserService({ repository }) {
  if (!repository) throw new Error('createUserService requires a repository');

  function respond(items, total, { page, limit }) {
    return { data: items, meta: buildPaginationMeta({ page, limit, total }) };
  }

  return {
    async getProfile(userId) {
      const user = await repository.findPublicById(userId);
      if (!user) throw ApiError.notFound('User not found');
      return user;
    },

    async listFavorites(userId, query) {
      const { page, limit, offset } = paginate(query);
      const { items, total } = await repository.listFavorites(userId, { limit, offset });
      return respond(items, total, { page, limit });
    },

    async addFavorite(userId, body) {
      return repository.addFavorite(userId, body);
    },

    async removeFavorite(userId, favoriteId) {
      const deleted = await repository.deleteFavorite(userId, favoriteId);
      if (deleted === 0) throw ApiError.notFound('Favorite not found');
      return { success: true };
    },

    async listHistory(userId, query) {
      const { page, limit, offset } = paginate(query);
      const { items, total } = await repository.listHistory(userId, {
        animeId: query.animeId,
        limit,
        offset,
      });
      return respond(items, total, { page, limit });
    },

    /** Record a watched episode — one row per (user, episode), newest first. */
    async addHistory(userId, { animeId, episode }) {
      const episodeId = await repository.findEpisodeIdByAnimeAndNumber(animeId, episode);
      if (episodeId == null) {
        throw ApiError.notFound(`Episode ${episode} of anime ${animeId} not found`);
      }
      const row = await repository.touchHistory(userId, episodeId, {});
      return { history: row };
    },

    // --- continue watching ------------------------------------------------

    async listContinueWatching(userId, query) {
      const { page, limit, offset } = paginate(query);
      const { items, total } = await repository.listContinueWatching(userId, { limit, offset });
      return respond(items, total, { page, limit });
    },

    /**
     * Save playback progress (called roughly every 10s by the player).
     * When the position reaches the end of the episode, the entry is removed
     * instead (the episode is finished — nothing left to resume).
     */
    async saveContinueWatching(userId, animeId, body) {
      const { episodeNumber, playbackPositionSeconds, durationSeconds } = body;
      // Only treat the position as "finished" for episodes that actually have
      // a meaningful duration — with durationSeconds <= 5 the last-5s window
      // covers the whole episode and every save would delete the resume point.
      const nearEnd =
        durationSeconds != null &&
        durationSeconds >= 5 &&
        playbackPositionSeconds >= durationSeconds - 5;
      if (nearEnd) {
        await repository.deleteContinueWatching(userId, animeId);
        return { animeId, completed: true, removed: true };
      }
      const row = await repository.upsertContinueWatching(userId, {
        animeId,
        episodeNumber,
        playbackPositionSeconds,
        durationSeconds,
      });
      return row;
    },

    async removeContinueWatching(userId, animeId) {
      const deleted = await repository.deleteContinueWatching(userId, animeId);
      if (deleted === 0) throw ApiError.notFound('No resume point for this anime');
      return { success: true };
    },
  };
}
