import { z } from 'zod';

export const malStatus = z.enum(['watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch']);

export const malCallbackQuery = z.object({
  code: z.string().min(1).optional(), // absent when the user denies consent
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

export const malListQuery = z.object({
  status: malStatus.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const malUpdateBody = z
  .object({
    status: malStatus.optional(),
    score: z.coerce.number().int().min(0).max(10).optional(),
    episodesWatched: z.coerce.number().int().min(0).optional(),
    isRewatching: z.boolean().optional(),
    rewatchCount: z.coerce.number().int().min(0).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' });

export const malAddBody = z.object({
  malAnimeId: z.coerce.number().int().positive(),
  status: malStatus,
  score: z.coerce.number().int().min(0).max(10).optional(),
  episodesWatched: z.coerce.number().int().min(0).optional(),
});

export const malProgressBody = z.object({
  animeId: z.coerce.number().int().positive(),
  episodeNumber: z.coerce.number().int().positive(),
});

export const malAnimeIdParams = z.object({
  malAnimeId: z.coerce.number().int().positive(),
});
