/**
 * AniList GraphQL client (importer-side, TypeScript).
 *
 * AniList throttles at ~90 requests/minute unauthenticated (bursts of 2/s)
 * and answers HTTP 429 with a Retry-After header. This client:
 *   - spaces requests at least `minIntervalMs` apart,
 *   - backs off on 429 (honoring Retry-After) and 5xx with exponential
 *     backoff + jitter,
 *   - sends ANILIST_ACCESS_TOKEN when configured (authenticated quota is
 *     much higher).
 */
import axios, { AxiosError, type AxiosInstance } from "axios";

export interface AniListConfig {
  endpoint?: string;
  accessToken?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

export class AniListError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AniListError";
  }
}

export class AniListClient {
  private readonly http: AxiosInstance;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly logger: Pick<Console, "warn" | "error" | "info">;
  private lastRequestAt = 0;

  constructor(config: AniListConfig = {}) {
    this.minIntervalMs = config.minIntervalMs ?? 450;
    this.maxRetries = Math.max(0, config.maxRetries ?? 5);
    this.logger = config.logger ?? console;
    this.http = axios.create({
      baseURL: config.endpoint ?? "https://graphql.anilist.co",
      timeout: config.timeoutMs ?? 60_000,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}),
      },
    });
  }

  /**
   * Execute a GraphQL query; resolves with `data`. Throws AniListError after
   * retries are exhausted (GraphQL-level errors are surfaced as-is).
   */
  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    // Space requests: AniList rate-limits per second AND per minute.
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await delay(wait);
    this.lastRequestAt = Date.now();

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await this.http.post<{ data?: T; errors?: { message?: string }[] }>("/", {
          query,
          variables,
        });
        const body = res.data;
        if (body.errors && body.errors.length > 0) {
          const msg = body.errors.map((e) => e.message).join("; ");
          throw new AniListError(`AniList GraphQL error: ${msg}`);
        }
        return body.data as T;
      } catch (err) {
        lastError = err;
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          if (status === 429) {
            const retryAfter = parseRetryAfter(err.response?.headers?.["retry-after"]);
            this.logger.warn(`[anilist] rate limited, backing off (attempt ${attempt + 1})`);
            await delay(retryAfter ?? backoffMs(attempt));
            continue;
          }
          if (status != null && status >= 400 && status < 500 && status !== 429) {
            throw new AniListError(`AniList ${status}: ${err.message}`, status);
          }
        }
        if (attempt < this.maxRetries) await delay(backoffMs(attempt));
      }
    }
    throw new AniListError(`AniList query failed after ${this.maxRetries + 1} attempts: ${String(lastError)}`);
  }
}

export function createAniListClient(config: AniListConfig = {}): AniListClient {
  return new AniListClient(config);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** Math.min(attempt, 5);
  return Math.min(60_000, Math.round(base * (0.75 + Math.random() * 0.5)));
}

/** Retry-After may be delta-seconds or an HTTP-date. */
function parseRetryAfter(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, seconds * 1000);
  const date = new Date(value).getTime();
  if (!Number.isNaN(date)) return Math.min(120_000, Math.max(0, date - Date.now()));
  return null;
}

export type { AxiosError };
