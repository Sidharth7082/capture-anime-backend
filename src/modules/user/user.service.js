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
  };
}
