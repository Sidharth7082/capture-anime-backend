// ============================================================================
// Minimal AniList GraphQL client with rate-limit awareness.
//
// AniList throttles at ~90 requests/minute sustained (bursts of 2/s) and
// answers HTTP 429 with a Retry-After header. This client:
//   * spaces requests at least `minIntervalMs` apart (default 400ms),
//   * backs off on 429/5xx up to `maxRetries` times,
//   * sends the personal access token when ANILIST_ACCESS_TOKEN is set
//     (authenticated requests get a much higher quota).
// ============================================================================

const DEFAULT_ENDPOINT = 'https://graphql.anilist.co';

export class AniListClient {
  constructor({
    endpoint = process.env.ANILIST_ENDPOINT || DEFAULT_ENDPOINT,
    accessToken = process.env.ANILIST_ACCESS_TOKEN,
    minIntervalMs = 400,
    maxRetries = 5,
    timeoutMs = 60_000,
  } = {}) {
    this.endpoint = endpoint;
    this.accessToken = accessToken;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this._lastFinishedAt = 0;
    this.requestCount = 0;
  }

  async _throttle() {
    // Space from the previous request's COMPLETION (not its start): a slow
    // response would otherwise let the next request fire immediately,
    // bursting past AniList's per-second/per-minute quotas.
    const wait = this._lastFinishedAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  /**
   * Executes a GraphQL query. Resolves with `data`, throws on GraphQL errors
   * or when retries are exhausted.
   */
  async query(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      await this._throttle();
      this.requestCount += 1;

      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'anime-stream-platform-importer/1.0 (https://github.com/)',
      };
      if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

      let response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        this._lastFinishedAt = Date.now();
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this._backoff(attempt, `network error: ${err.message}`);
          continue;
        }
        throw new Error(`AniList request failed: ${err.message}`);
      }

      if (response.status === 429) {
        const retryAfterSec = Number(response.headers.get('retry-after')) || 5;
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
          continue;
        }
        throw new Error('AniList rate limit exceeded (429) after retries');
      }

      if (response.status === 200) {
        const body = await response.json();
        if (body.errors?.length) {
          const first = body.errors[0];
          throw new Error(`AniList GraphQL error: ${first.message}`);
        }
        return body.data;
      }

      if (response.status >= 500 && attempt < this.maxRetries) {
        await this._backoff(attempt, `HTTP ${response.status}`);
        continue;
      }

      // Non-200, non-retryable: surface the API's error message if present.
      let detail = '';
      try {
        const body = await response.json();
        detail = body.errors?.[0]?.message ? `: ${body.errors[0].message}` : '';
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`AniList returned HTTP ${response.status}${detail}`);
    }
  }

  async _backoff(attempt, reason) {
    const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s ...
    console.warn(`[anilist] ${reason}; retrying in ${delayMs}ms (attempt ${attempt + 1})`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
