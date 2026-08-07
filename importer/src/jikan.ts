/**
 * Jikan API client (v4 REST).
 *
 * Talks only to the configured local Jikan instance. This module is pure
 * infrastructure: an axios instance with sane defaults (timeout, retries,
 * typed JSON envelope helpers). Endpoint-specific fetching lives in
 * `importer.ts` and will be added step by step.
 */
import axios, { AxiosError, type AxiosInstance } from "axios";

export interface JikanConfig {
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  logger?: Pick<Console, "warn" | "error" | "info">;
}

/** Jikan's standard list envelope: `{ data: [...], pagination: {...} }`. */
export interface JikanPage<T> {
  data: T[];
  pagination?: {
    last_visible_page: number;
    has_next_page: boolean;
    current_page?: number;
    items?: { count?: number; total?: number; per_page?: number };
  };
}

export class JikanError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string,
  ) {
    super(message);
    this.name = "JikanError";
  }
}

export class JikanClient {
  private readonly http: AxiosInstance;
  private readonly retries: number;
  private readonly logger: Pick<Console, "warn" | "error" | "info">;

  constructor(config: JikanConfig) {
    this.retries = Math.max(0, config.retries ?? 3);
    this.logger = config.logger ?? console;
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs ?? 15_000,
      headers: { Accept: "application/json" },
      // Jikan throttles aggressively; a per-request adapter hook keeps the
      // importer polite. Real rate-limiting lands with the importer logic.
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  /** Base URL (useful for logging and health checks). */
  get baseUrl(): string {
    return this.http.defaults.baseURL ?? "";
  }

  /** True when the Jikan server answers `GET /` (or a configured path). */
  async ping(): Promise<boolean> {
    try {
      const res = await this.getJson<unknown>("/");
      return res !== null;
    } catch {
      return false;
    }
  }

  /**
   * Generic GET with retry/backoff. Returns the parsed JSON body.
   * NOTE: no importer-specific endpoints yet — those arrive with importer.ts.
   */
  async getJson<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const res = await this.http.get<T>(path, { params });
        return res.data;
      } catch (err) {
        lastError = err;
        if (axios.isAxiosError<{ message?: string }>(err)) {
          const status = err.response?.status;
          // 4xx errors are deterministic — no point retrying.
          if (status != null && status >= 400 && status < 500) {
            throw new JikanError(
              err.response?.data?.message ?? `Jikan ${path} failed (${status})`,
              status,
              path,
            );
          }
          if (status === 429) {
            this.logger.warn(`[jikan] rate limited on ${path}, backing off (attempt ${attempt + 1})`);
            await delay(backoffMs(attempt));
            continue;
          }
        }
        if (attempt < this.retries) {
          await delay(backoffMs(attempt));
        }
      }
    }
    throw new JikanError(`Jikan ${path} failed after ${this.retries + 1} attempts: ${String(lastError)}`, undefined, path);
  }
}

/** Convenience factory (keeps consumers free of axios details). */
export function createJikanClient(config: JikanConfig): JikanClient {
  return new JikanClient(config);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return 250 * 2 ** Math.min(attempt, 5);
}

export type { AxiosError };
