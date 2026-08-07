/**
 * Source fetchers. Each source implements the Fetcher contract; the runner
 * treats them identically (pagination + hasNextPage).
 */
import type { JikanClient } from "../jikan.js";
import type { FetchedPage, Fetcher } from "./types.js";
import type { JikanAnime } from "./normalizers.js";

interface JikanPage<T> {
  data?: T[];
  pagination?: { has_next_page?: boolean };
}

/** Fetches Jikan's `/v4/anime` catalogue page by page. */
export class JikanAnimeFetcher implements Fetcher<JikanAnime> {
  readonly source = "jikan-anime";

  constructor(private readonly jikan: JikanClient) {}

  async fetchPage(page: number): Promise<FetchedPage<JikanAnime>> {
    const res = await this.jikan.getJson<JikanPage<JikanAnime>>("/v4/anime", { page });
    return {
      items: res.data ?? [],
      hasNextPage: res.pagination?.has_next_page ?? false,
    };
  }
}

export function createJikanAnimeFetcher(jikan: JikanClient): JikanAnimeFetcher {
  return new JikanAnimeFetcher(jikan);
}

// --- Stage 4 enrichment fetcher ---------------------------------------------

import type { JikanEnrichmentBundle } from "./normalizers.js";

export interface AnimeRowRef {
  id: number;
  idMal: number;
}

export interface JikanEnrichFetcherOptions {
  /** Jikan client — only getJson is used (structural, easy to fake in tests). */
  jikan: Pick<JikanClient, "getJson">;
  /** Lists the catalog to enrich (normally SELECT id, id_mal FROM anime). */
  listAnime: () => Promise<AnimeRowRef[]>;
  /** How many anime to process per page (each = 6 detail requests). */
  batchSize?: number;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export const ENRICH_ENDPOINTS = [
  "characters",
  "staff",
  "relations",
  "recommendations",
  "pictures",
  "videos",
] as const;

export type EnrichEndpoint = (typeof ENRICH_ENDPOINTS)[number];

/**
 * Fetches the six detail endpoints for a batch of anime (one item per anime).
 * Per-endpoint failures are isolated: a bundle carries `failed_endpoints` so
 * a partially-failed anime still enriches the endpoints that succeeded, while
 * a fully-failed anime is rejected by the validator and counted as a failure.
 */
export function createJikanEnrichFetcher(options: JikanEnrichFetcherOptions): Fetcher<JikanEnrichmentBundle> {
  const logger = options.logger ?? console;
  const batchSize = options.batchSize ?? 10;
  let ids: AnimeRowRef[] | null = null;

  const listAnime = async (): Promise<AnimeRowRef[]> => {
    ids ??= await options.listAnime();
    return ids;
  };

  const fetchEndpoints = async (idMal: number): Promise<JikanEnrichmentBundle> => {
    const failed: string[] = [];
    const payloads = await Promise.allSettled(
      ENRICH_ENDPOINTS.map((endpoint) =>
        options.jikan.getJson<{ data: unknown }>(`/v4/anime/${idMal}/${endpoint}`),
      ),
    );
    const bundle: JikanEnrichmentBundle = { mal_id: idMal, failed_endpoints: [] };
    const record = bundle as unknown as Record<string, unknown>;
    ENRICH_ENDPOINTS.forEach((endpoint, index) => {
      const result = payloads[index];
      if (result === undefined) return;
      if (result.status === "fulfilled") {
        record[endpoint] = result.value.data;
      } else {
        failed.push(endpoint);
        logger.warn(`[enrich] anime ${idMal}: ${endpoint} failed: ${String(result.reason)}`);
      }
    });
    bundle.failed_endpoints = failed;
    return bundle;
  };

  return {
    source: "jikan-enrich",
    async fetchPage(page: number): Promise<FetchedPage<JikanEnrichmentBundle>> {
      const all = await listAnime();
      const start = (page - 1) * batchSize;
      const slice = all.slice(start, start + batchSize);
      const items = await Promise.all(slice.map((ref) => fetchEndpoints(ref.idMal)));
      return { items, hasNextPage: start + batchSize < all.length };
    },
  };
}
