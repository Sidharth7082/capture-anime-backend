// ============================================================================
// Anivexa streaming provider client.
//
// Talks only to the self-hosted Anivexa API (ANIVEXA_API_URL); the frontend
// never calls Anivexa directly. Responses are cached briefly to reduce
// upstream load, and providers fail over in the configured order so a single
// broken provider never breaks playback.
// ============================================================================

import { env } from '../config/env.js';
import { TtlCache } from '../lib/cache.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const DEFAULT_PROVIDERS = ['reanime', 'anikoto', 'animegg', 'anineko', 'anidbapp', 'kaa'];

// The response shape we promise the rest of the app / the API consumers.
export const WATCH_KEYS = ['provider', 'episode', 'audio', 'streams', 'subtitles', 'servers'];

export class AnivexaService {
  /**
   * @param {object} [deps]
   * @param {string} [deps.baseUrl]       override for tests
   * @param {string[]} [deps.providers]   provider order (failover chain)
   * @param {TtlCache} [deps.cache]       episodes/watch cache
   * @param {(path:string, signal?:AbortSignal)=>Promise<unknown>} [deps.fetchJson]
   */
  constructor({
    baseUrl = env.ANIVEXA_API_URL,
    providers = env.ANIVEXA_PROVIDERS.split(',').map((p) => p.trim()).filter(Boolean),
    cache = new TtlCache({ ttlMs: env.ANIVEXA_CACHE_TTL_MS, maxEntries: 200 }),
    fetchJson,
  } = {}) {
    this.baseUrl = baseUrl?.replace(/\/+$/, '');
    this.providers = providers.length > 0 ? providers : DEFAULT_PROVIDERS;
    this.cache = cache;
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

  #cacheGet(key) {
    return this.cache.get(key);
  }

  #cacheSet(key, value) {
    this.cache.set(key, value);
  }

  /**
   * Fetch and cache the episode lists for an AniList id across the configured
   * providers: { <provider>: { meta, sub: [], dub: [] } }.
   * Providers are queried in parallel (each with its own timeout) so a slow
   * provider can't stall the others; erroring providers are dropped, not fatal.
   */
  async getEpisodes(anilistId) {
    if (!this.configured) throw this.#notConfigured();
    const key = `anivexa:episodes:${anilistId}`;
    const cached = this.#cacheGet(key);
    if (cached) return cached;

    const results = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          const body = await this.fetchJson(`/episodes/${provider}/${anilistId}`);
          return { provider, body };
        } catch (error) {
          logger.warn(`[anivexa] episodes fetch failed for provider ${provider} (${anilistId}): ${error.message}`);
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
      result[provider] = {
        meta: slot.meta ?? {},
        sub,
        dub,
      };
    }

    if (Object.keys(result).length === 0) {
      throw new ApiError(404, 'STREAM_UNAVAILABLE', `No provider has episodes for AniList id ${anilistId}`);
    }

    this.#cacheSet(key, result);
    return result;
  }

  /**
   * Resolve a watch stream for one episode. Without an explicit provider the
   * configured providers are tried in order and the first one that returns
   * usable streams wins.
   *
   * @returns {Promise<{provider:string, episode:number, audio:string, streams:object[], subtitles:object[], servers:string[]}>}
   */
  async getWatch(anilistId, episode, { provider, audio = 'sub' } = {}) {
    if (!this.configured) throw this.#notConfigured();
    if (audio !== 'sub' && audio !== 'dub') audio = 'sub';

    const providers = provider ? [provider] : this.providers;
    const episodes = await this.getEpisodes(anilistId);

    let lastError = null;
    for (const prov of providers) {
      const slot = episodes[prov];
      if (!slot) continue;
      const audioList = audio === 'dub' ? slot.dub : slot.sub;
      const ep = audioList.find((e) => Number(e.number) === Number(episode));
      if (!ep || !ep.id) continue;

      const cacheKey = `anivexa:watch:${anilistId}:${episode}:${prov}:${audio}`;
      const cached = this.#cacheGet(cacheKey);
      if (cached) return cached;

      try {
        const raw = await this.fetchJson(`/${ep.id}`);
        const normalized = this.#normalizeWatch(raw, prov, episode, audio);
        if (normalized.streams.length === 0) {
          throw new ApiError(502, 'STREAM_UNAVAILABLE', `Provider ${prov} returned no streams`);
        }
        this.#cacheSet(cacheKey, normalized);
        return normalized;
      } catch (error) {
        lastError = error;
        logger.warn(`[anivexa] provider ${prov} failed for ${anilistId} ep ${episode}: ${error.message}`);
        continue;
      }
    }

    if (lastError instanceof ApiError && lastError.status === 502) {
      throw new ApiError(502, 'ANIVEXA_UNAVAILABLE', 'All streaming providers failed to return streams');
    }
    throw new ApiError(404, 'STREAM_UNAVAILABLE', `Episode ${episode} not available from any provider`);
  }

  /** Map the raw Anivexa watch payload into the app's stable response shape. */
  #normalizeWatch(raw, provider, episode, audio) {
    const streams = Array.isArray(raw?.streams) ? raw.streams : [];
    const subtitles = Array.isArray(raw?.subtitles) ? raw.subtitles : [];
    const servers = [
      ...new Set(
        streams.map((s) => s?.server).filter(Boolean),
      ),
    ];
    return {
      provider,
      episode: Number(raw?.episode ?? episode),
      audio,
      streams,
      subtitles,
      servers,
    };
  }

  #notConfigured() {
    return new ApiError(
      503,
      'STREAMING_NOT_CONFIGURED',
      'Streaming is not configured: set ANIVEXA_API_URL to enable the Anivexa provider',
    );
  }
}
