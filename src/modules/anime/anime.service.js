// Anime business logic. Repository is injected for testability.
import { paginate, buildPaginationMeta } from '../../lib/pagination.js';
import { ApiError } from '../../lib/errors.js';

const DEFAULT_SORT = 'popularity_desc';

export function createAnimeService({ repository }) {
  if (!repository) throw new Error('createAnimeService requires a repository');

  function respond(items, total, { page, limit }) {
    return { data: items, meta: buildPaginationMeta({ page, limit, total }) };
  }

  async function list(query, sortOverride) {
    const { page, limit, offset } = paginate(query);
    const { items, total } = await repository.listAnime({
      status: query.status,
      format: query.format,
      season: query.season,
      year: query.year,
      includeAdult: query.includeAdult,
      sort: sortOverride ?? query.sort ?? DEFAULT_SORT,
      limit,
      offset,
    });
    return respond(items, total, { page, limit });
  }

  return {
    list(query) {
      return list(query);
    },

    async getById(id) {
      const anime = await repository.findAnimeById(id);
      if (!anime) throw ApiError.notFound(`Anime ${id} not found`);

      const [genres, studios, characters, rating, episodeCount] = await Promise.all([
        repository.findGenresByAnimeId(id),
        repository.findStudiosByAnimeId(id),
        repository.findCharactersByAnimeId(id),
        repository.findRatingStats(id),
        repository.countEpisodes(id),
      ]);

      return {
        ...anime,
        genres,
        studios,
        characters,
        rating,
        episodeCount,
      };
    },

    trending(query) {
      return list(query, 'popularity_desc');
    },

    popular(query) {
      return list(query, 'score_desc');
    },

    recent(query) {
      return list(query, 'recent_desc');
    },

    async search(query) {
      const { page, limit, offset } = paginate(query);
      const { items, total } = await repository.searchAnime({ q: query.q, limit, offset });
      return respond(items, total, { page, limit });
    },

    async byGenre(genreId, query) {
      const genre = await repository.findGenreById(genreId);
      if (!genre) throw ApiError.notFound(`Genre ${genreId} not found`);
      const { page, limit, offset } = paginate(query);
      const { items, total } = await repository.listByGenre(genreId, {
        sort: query.sort ?? DEFAULT_SORT,
        limit,
        offset,
      });
      return { genre, data: items, meta: buildPaginationMeta({ page, limit, total }) };
    },

    async byStudio(studioId, query) {
      const studio = await repository.findStudioById(studioId);
      if (!studio) throw ApiError.notFound(`Studio ${studioId} not found`);
      const { page, limit, offset } = paginate(query);
      const { items, total } = await repository.listByStudio(studioId, {
        sort: query.sort ?? DEFAULT_SORT,
        limit,
        offset,
      });
      return { studio, data: items, meta: buildPaginationMeta({ page, limit, total }) };
    },

    async episodes(animeId, query) {
      if (!(await repository.animeExists(animeId))) {
        throw ApiError.notFound(`Anime ${animeId} not found`);
      }
      const { page, limit, offset } = paginate(query);
      const { items, total } = await repository.listEpisodesByAnime(animeId, { limit, offset });
      return { animeId, data: items, meta: buildPaginationMeta({ page, limit, total }) };
    },
  };
}
