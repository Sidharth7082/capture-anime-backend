/**
 * Row validator — safety net between the normalizer and the database.
 *
 * Enforces the platform `anime` table contract (types + CHECK constraints)
 * so a malformed row is counted as a failure with a reason instead of
 * crashing the run or violating a DB constraint.
 */
import { z } from "zod";
import type { NormalizedAnime, NormalizedAnimeEnrichment, ValidationResult } from "./types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const metadataRefSchema = z.object({
  malId: z.number().int().positive(),
  name: z.string().min(1),
});

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
  genres: z.array(metadataRefSchema),
  themes: z.array(metadataRefSchema),
  demographics: z.array(metadataRefSchema),
  studios: z.array(metadataRefSchema),
  producers: z.array(metadataRefSchema),
  licensors: z.array(metadataRefSchema),
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

// --- Stage 4 enrichment schema ----------------------------------------------

export const enrichmentSchema = z.object({
  idMal: z.number().int().positive(),
  failedEndpoints: z.array(z.string()),
  characters: z.array(
    z.object({
      malId: z.number().int().positive(),
      name: z.string().min(1),
      nameKanji: z.string().nullable(),
      imageUrl: z.string().nullable(),
      role: z.enum(["MAIN", "SUPPORTING", "BACKGROUND"]),
      sortOrder: z.number().int().min(0),
      voiceActors: z.array(
        z.object({
          malId: z.number().int().positive(),
          name: z.string().min(1),
          imageUrl: z.string().nullable(),
          language: z.string().nullable(),
        }),
      ),
    }),
  ),
  staff: z.array(
    z.object({
      malId: z.number().int().positive(),
      name: z.string().min(1),
      imageUrl: z.string().nullable(),
      positions: z.array(z.string()),
    }),
  ),
  relations: z.array(
    z.object({
      malId: z.number().int().positive(),
      mediaType: z.string().min(1),
      name: z.string().min(1),
      relation: z.string().min(1),
    }),
  ),
  recommendations: z.array(
    z.object({
      malId: z.number().int().positive(),
      title: z.string().min(1),
      votes: z.number().int().min(0),
    }),
  ),
  pictures: z.array(
    z.object({
      imageUrl: z.string().min(1),
      largeImageUrl: z.string().nullable(),
      webpUrl: z.string().nullable(),
    }),
  ),
  videos: z.array(
    z.object({
      kind: z.enum(["promo", "episode"]),
      title: z.string().min(1),
      youtubeId: z.string().nullable(),
      url: z.string().nullable(),
      embedUrl: z.string().nullable(),
      thumbnailLarge: z.string().nullable(),
      episodeNumber: z.number().int().positive().nullable(),
    }),
  ),
});

const ENRICH_ENDPOINTS = ["characters", "staff", "relations", "recommendations", "pictures", "videos"] as const;

/** Validate an enrichment bundle; all-endpoints-failed rows are rejected. */
export const validateAnimeEnrichment: Validator<NormalizedAnimeEnrichment> = (row) => {
  if (row.failedEndpoints.length === ENRICH_ENDPOINTS.length) {
    return { ok: false, reason: `all endpoints failed for anime ${row.idMal}: ${row.failedEndpoints.join(", ")}` };
  }
  const parsed = enrichmentSchema.safeParse(row);
  if (parsed.success) return { ok: true, row: parsed.data };
  const reason = parsed.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { ok: false, reason };
};
