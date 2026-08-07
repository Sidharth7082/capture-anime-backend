// ============================================================================
// Anivexa streaming provider client.
//
// Talks only to the self-hosted Anivexa API (ANIVEXA_API_URL); the frontend
// never calls Anivexa directly. Optimized for low stream-start latency:
//   - watch URLs are constructed directly (watch/<prov>/<id>/sub/<prov>-<ep>)
//     so the slow per-provider episode-list round trip is skipped on the hot
//     path (episode lists are still used for prefetch + as a fallback)
//   - providers are probed in PARALLEL batches and the first working stream
//     wins; per-provider response times feed an EMA ranking so the fastest
//     provider stays first
//   - results are cached 30–60 min, and stale-but-recent results are served
//     immediately while the cache refreshes in the background (SWR)
//   - timing is logged per stage (lookup / episodes / provider / total)
// ============================================================================

import { env } from '../config/env.js';
import { TtlCache } from '../lib/cache.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const DEFAULT_PROVIDERS = ['reanime', 'anikoto', 'animegg', 'anineko', 'anidbapp', 'kaa'];

// How long a stale (expired) watch result stays eligible for SWR serving.
const SWR_GRACE_MS = 2 * 60 * 60 * 1000;

// Upper bound for the staleWatch map (one entry per anime/ep/provider/audio +
// auto) so a long-running process doesn't leak memory unbounded.
const MAX_STALE_ENTRIES = 2000;

export class AnivexaService {
  /**
   * @param {object} [deps]
   * @param {string} [deps.baseUrl]
   * @param {string[]} [deps.providers]      provider order (initial failover order)
   * @param {number} [deps.cacheTtlMs]       episode/watch cache TTL
   * @param {number} [deps.maxParallel]      watch probes per parallel batch
   * @param {TtlCache} [deps.cache]
   * @param {(path:string, signal?:AbortSignal)=>Promise<unknown>} [deps.fetchJson]
   */
  constructor({
    baseUrl = env.ANIVEXA_API_URL,
    providers = env.ANIVEXA_PROVIDERS.split(',').map((p) => p.trim()).filter(Boolean),
    cacheTtlMs = env.ANIVEXA_CACHE_TTL_MS,
    maxParallel = env.ANIVEXA_MAX_PARALLEL,
    cache = new TtlCache({ ttlMs: cacheTtlMs, maxEntries: 400 }),
    fetchJson,
  } = {}) {
    this.baseUrl = baseUrl?.replace(/\/+$/, '');
    this.providers = providers.length > 0 ? providers : DEFAULT_PROVIDERS;
    this.cacheTtlMs = cacheTtlMs;
    this.maxParallel = Math.max(1, maxParallel);
    this.cache = cache;
    // Per-provider measured latency (EMA). Sorted fastest-first for probing.
    this.providerLatency = new Map();
    // Expired watch values kept for stale-while-revalidate.
    this.staleWatch = new Map();
    this.refreshing = new Set();
    this.fetchJson =
      fetchJson ?? ((path, signal) => this.#fetchUpstream(path, signal));
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  async #fetchUpstream(path, signal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.ANIVEXA_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) {
        throw new ApiError(502, 'ANIVEXA_UNAVAILABLE', `Anivexa returned HTTP ${res.status} for ${path}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  #recordLatency(provider, ms, ok) {
    // EMA (α = 0.3) — failures count as a long time so they sink in ranking.
    const effective = ok ? ms : ms + 30_000;
    const prev = this.providerLatency.get(provider);
    this.providerLatency.set(provider, prev == null ? effective : 0.7 * prev + 0.3 * effective);
  }

  /** Providers ordered fastest-first (measured), then config order (unmeasured). */
  orderedProviders() {
    const measured = this.providers
      .filter((p) => this.providerLatency.has(p))
      .sort((a, b) => this.providerLatency.get(a) - this.providerLatency.get(b));
    const unmeasured = this.providers.filter((p) => !this.providerLatency.has(p));
    return [...measured, ...unmeasured];
  }

  /** Construct the Anivexa watch path directly (skips the episode-list round trip). */
  #watchPath(provider, anilistId, audio, episode) {
    return `/watch/${provider}/${anilistId}/${audio}/${provider}-${episode}`;
  }

  #watchKey(anilistId, episode, provider, audio) {
    return `watch:${anilistId}:${episode}:${provider}:${audio}`;
  }

  #cacheGet(key) {
    return this.cache.get(key);
  }

  #cacheSet(key, value) {
    this.cache.set(key, value);
  }

  #cacheHitLog(key, stage) {
    logger.debug(`[anivexa] cache hit ${key} (${stage})`);
  }

  #notConfigured() {
    return new ApiError(
      503,
      'STREAMING_NOT_CONFIGURED',
      'Streaming is not configured: set ANIVEXA_API_URL to enable the Anivexa provider',
    );
  }

  /**
   * Fetch and cache the episode lists for an AniList id across the configured
   * providers: { <provider>: { meta, sub: [], dub: [] } }.
   * Providers are queried in parallel; erroring providers are dropped.
   */
  async getEpisodes(anilistId) {
    if (!this.configured) throw this.#notConfigured();
    const key = `anivexa:episodes:${anilistId}`;
    const cached = this.#cacheGet(key);
    if (cached) {
      this.#cacheHitLog(key, 'episodes');
      return cached;
    }

    const t0 = performance.now();
    const results = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          const body = await this.fetchJson(`/episodes/${provider}/${anilistId}`);
          return { provider, body };
        } catch (error) {
          logger.debug(`[anivexa] episodes fetch failed for provider ${provider} (${anilistId}): ${error.message}`);
          return { provider, body: null };
        }
      }),
    );

    const result = {};
    for (const { provider, body } of results) {
      const slot = body?.[provider];
      if (!slot || typeof slot !== 'object' || !slot.episodes) continue;
      const episodes = slot.episodes;
      const sub = Array.isArray(episodes.sub) ? episodes.sub : [];
      const dub = Array.isArray(episodes.dub) ? episodes.dub : [];
      if (sub.length === 0 && dub.length === 0) continue;
      result[provider] = { meta: slot.meta ?? {}, sub, dub };
    }

    if (Object.keys(result).length === 0) {
      throw new ApiError(404, 'STREAM_UNAVAILABLE', `No provider has episodes for AniList id ${anilistId}`);
    }

    this.#cacheSet(key, result);
    logger.info(`[anivexa] episodes resolved for ${anilistId} in ${(performance.now() - t0).toFixed(0)}ms (${Object.keys(result).length} providers)`);
    return result;
  }

  /**
   * Resolve a watch stream for one episode.
   * 1. cache-first across providers (fresh, then stale-while-revalidate)
   * 2. parallel probe of the fastest providers, first working stream wins
   * 3. fallback: resolve real ids from the episode lists and retry once
   */
  async getWatch(anilistId, episode, { provider, audio = 'sub' } = {}) {
    if (!this.configured) throw this.#notConfigured();
    if (audio !== 'sub' && audio !== 'dub') audio = 'sub';

    // 1) Cache-first pass (fresh + SWR) across the ranked provider order.
    if (!provider) {
      const order = this.orderedProviders();
      const tCache = performance.now();
      for (const p of order) {
        const key = this.#watchKey(anilistId, episode, p, audio);
        const fresh = this.#cacheGet(key);
        if (fresh) {
          this.#cacheHitLog(key, 'watch');
          logger.info(`[anivexa] watch cache hit in ${(performance.now() - tCache).toFixed(0)}ms (${p})`);
          return fresh;
        }
        const stale = this.staleWatch.get(key);
        if (stale && Date.now() - stale._at < SWR_GRACE_MS && !this.refreshing.has(key)) {
          this.refreshing.add(key);
          this.#resolveAndCache(key, anilistId, episode, { provider: p, audio })
            .catch((err) => logger.warn(`[anivexa] background refresh failed ${key}: ${err.message}`))
            .finally(() => this.refreshing.delete(key));
          logger.info(`[anivexa] watch stale-while-revalidate (${p}) in ${(performance.now() - tCache).toFixed(0)}ms`);
          return stale;
        }
      }
    } else {
      const key = this.#watchKey(anilistId, episode, provider, audio);
      const fresh = this.#cacheGet(key);
      if (fresh) { this.#cacheHitLog(key, 'watch'); return fresh; }
      const stale = this.staleWatch.get(key);
      if (stale && Date.now() - stale._at < SWR_GRACE_MS && !this.refreshing.has(key)) {
        this.refreshing.add(key);
        this.#resolveAndCache(key, anilistId, episode, { provider, audio })
          .catch(() => {})
          .finally(() => this.refreshing.delete(key));
        return stale;
      }
    }

    const tTotal = performance.now();
    const resolved = await this.#resolveAndCache(
      provider ? this.#watchKey(anilistId, episode, provider, audio) : null,
      anilistId,
      episode,
      { provider, audio },
    );
    logger.info(`[anivexa] watch total ${(performance.now() - tTotal).toFixed(0)}ms (${resolved.provider})`);
    return resolved;
  }

  /** Probe providers (parallel batches) and cache the first working result. */
  async #resolveAndCache(key, anilistId, episode, { provider, audio }) {
    const candidates = provider
      ? [{ provider, audio, episode, path: this.#watchPath(provider, anilistId, audio, episode) }]
      : this.orderedProviders().map((p) => ({
          provider: p,
          audio,
          episode,
          path: this.#watchPath(p, anilistId, audio, episode),
        }));

    let sawError = false;
    let normalized = await this.#probeBatches(candidates, (err) => { sawError = true; });
    if (!normalized) {
      // Fallback: real ids from the (cached) episode lists, one retry per provider.
      try {
        logger.debug(`[anivexa] direct watch paths failed for ${anilistId} ep ${episode} — resolving ids from episode lists`);
        const episodes = await this.getEpisodes(anilistId);
        const fallbackCandidates = [];
        for (const p of this.orderedProviders()) {
          const slot = episodes[p];
          if (!slot) continue;
          // Track the audio actually used: when a dub is requested but the
          // provider has no dub list, the fallback serves the sub stream and
          // must be labeled sub, not dub.
          const wantDub = audio === 'dub' && slot.dub.length > 0;
          const list = wantDub ? slot.dub : slot.sub;
          const ep = list.find((e) => Number(e.number) === Number(episode));
          if (ep?.id) {
            fallbackCandidates.push({ provider: p, audio: wantDub ? 'dub' : 'sub', episode, path: `/${ep.id}` });
          }
        }
        normalized = await this.#probeBatches(fallbackCandidates, () => { sawError = true; });
      } catch (error) {
        // Episode-list resolution failed too (e.g. upstream down) — prefer the
        // provider-level error code over the episode-list 404.
        if (sawError) {
          throw new ApiError(502, 'ANIVEXA_UNAVAILABLE', 'All streaming providers failed to return streams');
        }
        throw error;
      }
    }

    if (!normalized) {
      // 502 when providers were attempted but failed upstream; 404 when the
      // episode simply doesn't exist anywhere.
      if (sawError) {
        throw new ApiError(502, 'ANIVEXA_UNAVAILABLE', 'All streaming providers failed to return streams');
      }
      throw new ApiError(404, 'STREAM_UNAVAILABLE', `Episode ${episode} not available from any provider`);
    }

    const resolvedKey = key ?? this.#watchKey(anilistId, episode, normalized.provider, audio);
    const withMeta = { ...normalized, _at: Date.now() };
    this.#cacheSet(resolvedKey, withMeta);
    this.#stalePut(resolvedKey, withMeta);
    // Also store under the auto key so later auto requests hit instantly.
    if (!provider) {
      const autoKey = `watch:${anilistId}:${episode}:auto:${audio}`;
      this.#cacheSet(autoKey, withMeta);
      this.#stalePut(autoKey, withMeta);
    }
    return normalized;
  }

  /** Bounded write to the stale map (insertion order = age). */
  #stalePut(key, value) {
    this.staleWatch.set(key, value);
    while (this.staleWatch.size > MAX_STALE_ENTRIES) {
      const oldest = this.staleWatch.keys().next().value;
      if (oldest === undefined) break;
      this.staleWatch.delete(oldest);
    }
  }

  /** Probe provider batches in parallel; return the first working result. */
  async #probeBatches(candidates, onError) {
    for (let i = 0; i < candidates.length; i += this.maxParallel) {
      const batch = candidates.slice(i, i + this.maxParallel);
      const winner = await Promise.any(
        batch.map(async (c) => {
          const t0 = performance.now();
          try {
            const raw = await this.fetchJson(c.path);
            const normalized = this.#normalizeWatch(raw, c.provider, c.episode, c.audio);
            if (normalized.streams.length === 0) {
              // The upstream returned no streams (e.g. its catch-all info JSON
              // for a path that doesn't exist) — that's a missing episode, not
              // a provider outage: signal 404 and don't mark the provider as
              // failed (which would turn the response into a 502).
              throw new ApiError(404, 'STREAM_UNAVAILABLE', `Provider ${c.provider} returned no streams`);
            }
            this.#recordLatency(c.provider, performance.now() - t0, true);
            logger.debug(`[anivexa] provider ${c.provider} resolved in ${(performance.now() - t0).toFixed(0)}ms`);
            return normalized;
          } catch (error) {
            this.#recordLatency(c.provider, performance.now() - t0, false);
            logger.debug(`[anivexa] provider ${c.provider} failed in ${(performance.now() - t0).toFixed(0)}ms: ${error.message}`);
            if (!(error instanceof ApiError && error.status === 404)) onError?.(error);
            throw error;
          }
        }),
      ).catch(() => null);
      if (winner) return winner;
    }
    return null;
  }

  /**
   * Warm the cache for the first `count` episodes of an anime so the first
   * play is instant. Watch URLs are constructible directly, so this returns
   * immediately and resolves episodes 1..count in the background.
   */
  async prefetch(anilistId, count = env.ANIVEXA_PREFETCH_EPISODES) {
    if (!this.configured) throw this.#notConfigured();
    const t0 = performance.now();
    for (let ep = 1; ep <= count; ep++) {
      this.getWatch(anilistId, ep, { audio: 'sub' }).catch(() => {});
    }
    logger.info(`[anivexa] prefetch queued ${count} episodes (${anilistId}) in ${(performance.now() - t0).toFixed(0)}ms`);
    return { provider: 'auto', prefetched: count, total: count };
  }

  /** Map the raw Anivexa watch payload into the app's stable response shape. */
  #normalizeWatch(raw, provider, episode, audio) {
    const streams = Array.isArray(raw?.streams) ? raw.streams : [];
    const subtitles = Array.isArray(raw?.subtitles) ? raw.subtitles : [];
    const servers = [...new Set(streams.map((s) => s?.server).filter(Boolean))];
    return {
      provider,
      episode: Number(raw?.episode ?? episode),
      audio,
      streams,
      subtitles,
      servers,
    };
  }
}
