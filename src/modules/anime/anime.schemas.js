// Anime request/response schemas.
import { z } from 'zod';

export const SORTS = [
  'popularity_desc',
  'popularity_asc',
  'score_desc',
  'score_asc',
  'recent_desc',
  'start_date_desc',
  'title_asc',
  'title_desc',
];

export const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const listAnimeQuery = z.object({
  ...paginationSchema,
  status: z.enum(['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS']).optional(),
  format: z.enum(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']).optional(),
  season: z.enum(['WINTER', 'SPRING', 'SUMMER', 'FALL']).optional(),
  year: z.coerce.number().int().min(1917).max(2100).optional(),
  sort: z.enum(SORTS).default('popularity_desc'),
  includeAdult: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const idParams = z.object({
  id: z.coerce.number().int().positive(),
});

export const animeIdParams = z.object({
  animeId: z.coerce.number().int().positive(),
});

export const searchQuery = z.object({
  ...paginationSchema,
  q: z.string().trim().min(1, 'q is required').max(100),
});

export const rankedQuery = z.object({
  ...paginationSchema,
  includeAdult: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const relationQuery = z.object({
  ...paginationSchema,
  sort: z.enum(SORTS).default('popularity_desc'),
});

export const episodesQuery = z.object(paginationSchema);
