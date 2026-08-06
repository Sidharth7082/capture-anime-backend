// Anime HTTP handlers (thin).
import { asyncHandler } from '../../lib/async-handler.js';

export function createAnimeController(animeService) {
  return {
    list: asyncHandler(async (req, res) => res.json(await animeService.list(req.query))),
    getById: asyncHandler(async (req, res) =>
      res.json(await animeService.getById(req.params.id)),
    ),
    trending: asyncHandler(async (req, res) => res.json(await animeService.trending(req.query))),
    popular: asyncHandler(async (req, res) => res.json(await animeService.popular(req.query))),
    recent: asyncHandler(async (req, res) => res.json(await animeService.recent(req.query))),
    search: asyncHandler(async (req, res) => res.json(await animeService.search(req.query))),
    byGenre: asyncHandler(async (req, res) =>
      res.json(await animeService.byGenre(req.params.id, req.query)),
    ),
    byStudio: asyncHandler(async (req, res) =>
      res.json(await animeService.byStudio(req.params.id, req.query)),
    ),
    episodes: asyncHandler(async (req, res) =>
      res.json(await animeService.episodes(req.params.animeId, req.query)),
    ),
  };
}
