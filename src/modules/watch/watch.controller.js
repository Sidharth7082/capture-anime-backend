import { asyncHandler } from '../../lib/async-handler.js';

export function createWatchController(watchService) {
  return {
    watch: asyncHandler(async (req, res) => {
      const { animeId, episode } = req.params;
      const { provider, audio } = req.query;
      const result = await watchService.watch(animeId, episode, { provider, audio });
      res.json(result);
    }),

    prefetch: asyncHandler(async (req, res) => {
      const { animeId } = req.params;
      const count = req.query.count ? Number(req.query.count) : undefined;
      const result = await watchService.prefetch(animeId, count);
      res.json(result);
    }),
  };
}
