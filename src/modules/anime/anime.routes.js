// Anime routes — all read-only, all cacheable.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { cacheResponse } from '../../middleware/cache.js';
import { createAnimeController } from './anime.controller.js';
import {
  listAnimeQuery,
  idParams,
  animeIdParams,
  searchQuery,
  rankedQuery,
  relationQuery,
  episodesQuery,
} from './anime.schemas.js';

export function createAnimeRouter({ animeService, cache, cacheTtlMs }) {
  const router = Router();
  const controller = createAnimeController(animeService);
  const cached = cacheResponse(cache, { ttlMs: cacheTtlMs });

  router.get('/', cached, validate({ query: listAnimeQuery }), controller.list);
  router.get('/trending', cached, validate({ query: rankedQuery }), controller.trending);
  router.get('/popular', cached, validate({ query: rankedQuery }), controller.popular);
  router.get('/recent', cached, validate({ query: rankedQuery }), controller.recent);
  router.get('/search', cached, validate({ query: searchQuery }), controller.search);
  router.get('/genre/:id', cached, validate({ params: idParams, query: relationQuery }), controller.byGenre);
  router.get('/studio/:id', cached, validate({ params: idParams, query: relationQuery }), controller.byStudio);
  router.get('/:id', cached, validate({ params: idParams }), controller.getById);

  return router;
}

export function createEpisodesRouter({ animeService, cache, cacheTtlMs }) {
  const router = Router();
  const controller = createAnimeController(animeService);
  const cached = cacheResponse(cache, { ttlMs: cacheTtlMs });

  router.get('/:animeId', cached, validate({ params: animeIdParams, query: episodesQuery }), controller.episodes);

  return router;
}
