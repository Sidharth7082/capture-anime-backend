import { z } from 'zod';

export const watchParams = z.object({
  // DB anime id — same space as /api/anime/:id and /api/episodes/:animeId.
  animeId: z.coerce.number().int().positive(),
  episode: z.coerce.number().int().positive(),
});

export const watchQuery = z.object({
  // Provider name; optional — when omitted the configured providers are
  // tried in order and the first working one is used.
  provider: z.string().regex(/^[a-z0-9_-]+$/i).optional(),
  audio: z.enum(['sub', 'dub']).default('sub'),
});

export const prefetchParams = z.object({
  animeId: z.coerce.number().int().positive(),
});

export const prefetchQuery = z.object({
  // Number of episodes to warm (defaults to ANIVEXA_PREFETCH_EPISODES).
  count: z.coerce.number().int().min(0).max(50).optional(),
});
