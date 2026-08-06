// User endpoints schemas.
import { z } from 'zod';

export const favoritesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const addFavoriteBody = z
  .object({
    animeId: z.coerce.number().int().positive().optional(),
    characterId: z.coerce.number().int().positive().optional(),
    staffId: z.coerce.number().int().positive().optional(),
  })
  .refine((body) => [body.animeId, body.characterId, body.staffId].filter(Boolean).length === 1, {
    message: 'Exactly one of animeId, characterId or staffId is required',
  });

export const favoriteIdParams = z.object({
  id: z.coerce.number().int().positive(),
});

export const historyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  animeId: z.coerce.number().int().positive().optional(),
});
