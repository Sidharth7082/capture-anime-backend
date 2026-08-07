/**
 * Typesense client wrapper (optional search index).
 *
 * The importer will eventually mirror the anime catalog into Typesense so the
 * frontend can search it. This module only wires up the client — indexing
 * logic lands together with the importer steps. When `enabled` is false every
 * method no-ops, so the rest of the pipeline can treat Typesense as optional.
 */
import Typesense from "typesense";
import type { CollectionFieldSchema } from "typesense/lib/Typesense/Collection.js";
import type { NormalizedAnime, Sink } from "./pipeline/types.js";

export interface TypesenseConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  collection: string;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export interface TypesenseClient {
  readonly enabled: boolean;
  readonly collection: string;
  /** Connectivity check against the configured collection. */
  ping(): Promise<boolean>;
  /** Collection metadata (num_documents) — null when disabled or missing. */
  retrieveCollection(): Promise<{ num_documents?: number } | null>;
  /** Pipeline sink that mirrors normalized rows into the index. */
  createSink(): Sink<NormalizedAnime>;
  close(): Promise<void>;
}

export class NoopTypesense implements TypesenseClient {
  readonly enabled = false;
  readonly collection: string;
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;

  constructor(config: TypesenseConfig) {
    this.collection = config.collection;
    this.logger = config.logger ?? console;
  }

  async ping(): Promise<boolean> {
    this.logger.warn("[typesense] disabled — skipping connectivity check");
    return false;
  }

  createSink(): Sink<NormalizedAnime> {
    return createNoopSink(this.logger);
  }

  async retrieveCollection(): Promise<{ num_documents?: number } | null> {
    return null;
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

export class RealTypesense implements TypesenseClient {
  readonly enabled = true;
  readonly collection: string;
  private readonly client: Typesense.Client;
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;

  constructor(config: TypesenseConfig) {
    this.collection = config.collection;
    this.logger = config.logger ?? console;
    this.client = new Typesense.Client({
      nodes: [{ host: hostOf(config.url), port: portOf(config.url), protocol: protocolOf(config.url) }],
      apiKey: config.apiKey,
      connectionTimeoutSeconds: 5,
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.health.retrieve();
      return true;
    } catch (err) {
      this.logger.warn(`[typesense] health check failed: ${String(err)}`);
      return false;
    }
  }

  createSink(): Sink<NormalizedAnime> {
    return new TypesenseAnimeSink(this.client, this.collection, this.logger);
  }

  async retrieveCollection(): Promise<{ num_documents?: number } | null> {
    try {
      return await this.client.collections(this.collection).retrieve();
    } catch (err) {
      this.logger.warn(`[typesense] collection "${this.collection}" not found: ${String(err)}`);
      return null;
    }
  }

  async close(): Promise<void> {
    // typesense client keeps no long-lived sockets that need explicit release
  }
}

/** Build the right client based on `enabled`. */
export function createTypesense(config: TypesenseConfig): TypesenseClient {
  return config.enabled ? new RealTypesense(config) : new NoopTypesense(config);
}

/**
 * Pipeline sink — no-op until Typesense is enabled. Kept as the default so
 * the runner's contract is exercised end to end.
 */
export function createNoopSink(logger?: Pick<Console, "debug" | "info" | "warn" | "error">): Sink<unknown> {
  return {
    async ingest(rows) {
      logger?.debug?.(`[sink] no-op (Typesense disabled): ${rows.length} rows`);
    },
  };
}

// --- Typesense anime collection ---------------------------------------------

/** Typesense field list for the anime collection. `id` is implicit. */
export const ANIME_COLLECTION_FIELDS: CollectionFieldSchema[] = [
  { name: "mal_id", type: "int32" },
  { name: "title_romaji", type: "string" },
  { name: "title_english", type: "string" },
  { name: "title_native", type: "string" },
  { name: "synopsis", type: "string" },
  { name: "genres", type: "string[]", facet: true },
  { name: "themes", type: "string[]", facet: true },
  { name: "demographics", type: "string[]", facet: true },
  { name: "studios", type: "string[]", facet: true },
  { name: "producers", type: "string[]", facet: true },
  { name: "licensors", type: "string[]", facet: true },
  { name: "season", type: "string", facet: true },
  { name: "season_year", type: "int32", facet: true },
  { name: "format", type: "string", facet: true },
  { name: "status", type: "string", facet: true },
  { name: "score", type: "int32" },
  { name: "popularity", type: "int32" },
  { name: "favourites", type: "int32" },
  { name: "episodes", type: "int32" },
  { name: "is_adult", type: "bool" },
  { name: "cover_image_large", type: "string" },
  { name: "start_date", type: "string" },
  { name: "end_date", type: "string" },
];

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .trim();
}

/** Map a normalized anime row to a Typesense document (upsert key = mal_id). */
export function toAnimeDocument(row: NormalizedAnime): Record<string, unknown> {
  return {
    id: `anime:${row.idMal}`,
    mal_id: row.idMal,
    title_romaji: row.titleRomaji ?? "",
    title_english: row.titleEnglish ?? "",
    title_native: row.titleNative ?? "",
    synopsis: stripHtml(row.description ?? ""),
    genres: row.genres.map((g) => g.name),
    themes: row.themes.map((g) => g.name),
    demographics: row.demographics.map((g) => g.name),
    studios: row.studios.map((g) => g.name),
    producers: row.producers.map((g) => g.name),
    licensors: row.licensors.map((g) => g.name),
    season: row.season ?? "",
    season_year: row.seasonYear ?? 0,
    format: row.format ?? "",
    status: row.status ?? "",
    score: row.averageScore ?? 0,
    popularity: row.popularity ?? 0,
    favourites: row.favourites ?? 0,
    episodes: row.episodes ?? 0,
    is_adult: row.isAdult,
    cover_image_large: row.coverImageLarge ?? "",
    start_date: row.startDate ?? "",
    end_date: row.endDate ?? "",
  };
}

export class TypesenseAnimeSink implements Sink<NormalizedAnime> {
  private ensured = false;

  constructor(
    private readonly client: Typesense.Client,
    private readonly collection: string,
    private readonly logger: Pick<Console, "warn" | "error" | "info">,
  ) {}

  async ingest(rows: NormalizedAnime[]): Promise<void> {
    if (rows.length === 0) return;
    await this.ensureCollection();
    const docs = rows.map(toAnimeDocument);
    const results = await this.client.collections(this.collection).documents().import(docs, { action: "upsert" });
    const failed = Array.isArray(results) ? results.filter((r) => !r.success).length : 0;
    if (failed > 0) {
      this.logger.warn(`[typesense] ${failed}/${docs.length} documents failed to index`);
    } else {
      this.logger.info(`[typesense] indexed ${docs.length} documents (${this.collection})`);
    }
  }

  /** Create the collection on first use if it does not exist. */
  private async ensureCollection(): Promise<void> {
    if (this.ensured) return;
    try {
      await this.client.collections(this.collection).retrieve();
    } catch {
      await this.client.collections().create({
        name: this.collection,
        fields: ANIME_COLLECTION_FIELDS,
        default_sorting_field: "popularity",
      });
      this.logger.info(`[typesense] created collection "${this.collection}"`);
    }
    this.ensured = true;
  }
}
// --- tiny URL helpers (keeps the typesense dep config simple) ---------------

function hostOf(url: string): string {
  return new URL(url).hostname;
}
function portOf(url: string): number {
  return Number(new URL(url).port || 8108);
}
function protocolOf(url: string): "http" | "https" {
  return new URL(url).protocol === "https:" ? "https" : "http";
}
