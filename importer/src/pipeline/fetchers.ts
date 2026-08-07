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
