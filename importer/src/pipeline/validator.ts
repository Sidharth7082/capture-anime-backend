/**
 * Row validator — safety net between the normalizer and the database.
 *
 * Enforces the platform `anime` table contract (types + CHECK constraints)
 * so a malformed row is counted as a failure with a reason instead of
 * crashing the run or violating a DB constraint.
 */
import { z } from "zod";
import type { NormalizedAnime, ValidationResult } from "./types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const animeRowSchema = z.object({
  idMal: z.number().int().positive(),
  titleRomaji: z.string().nullable(),
  titleEnglish: z.string().nullable(),
  titleNative: z.string().nullable(),
  synonyms: z.array(z.string()),
  description: z.string().nullable(),
  format: z.string().nullable(), // enum value checked by the DB; null is fine
  status: z.string().nullable(),
  episodes: z.number().int().min(0).nullable(),
  durationMinutes: z.number().int().min(0).nullable(),
  startDate: z.string().regex(DATE_RE).nullable(),
  endDate: z.string().regex(DATE_RE).nullable(),
  season: z.enum(["WINTER", "SPRING", "SUMMER", "FALL"]).nullable(),
  seasonYear: z.number().int().min(1917).max(2100).nullable(),
  averageScore: z.number().int().min(0).max(100).nullable(),
  meanScore: z.number().int().min(0).max(100).nullable(),
  popularity: z.number().int().min(0).nullable(),
  favourites: z.number().int().min(0).nullable(),
  source: z.string().nullable(),
  isAdult: z.boolean(),
  coverImageLarge: z.string().nullable(),
  coverImageMedium: z.string().nullable(),
});

export type Validator<T> = (row: T) => ValidationResult<T>;

/** Validate a normalized anime row; returns {ok:true,row} or {ok:false,reason}. */
export const validateAnimeRow: Validator<NormalizedAnime> = (row) => {
  const parsed = animeRowSchema.safeParse(row);
  if (parsed.success) return { ok: true, row: parsed.data };
  const reason = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { ok: false, reason };
};
