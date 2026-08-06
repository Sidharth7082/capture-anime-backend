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
