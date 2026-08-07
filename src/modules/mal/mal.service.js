// ============================================================================
// MyAnimeList OAuth2 + list sync service.
//
// Security model:
//   - PKCE (S256) authorization-code flow; the code verifier, state and the
//     owning backend user id travel in a SIGNED httpOnly cookie (see
//     mal.routes.js) — never in the URL.
//   - Tokens are stored ENCRYPTED at rest (AES-256-GCM, see lib/crypto.js)
//     and only exist in plaintext here, briefly, while talking to MAL.
//     They are never returned to the frontend.
//   - Expired access tokens are refreshed automatically (lazy, on demand)
//     using the stored refresh token; a dead session yields a clear 401 so
//     the client can re-run the connect flow.
// ============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { encryptSecret, decryptSecret } from '../../lib/crypto.js';

const AUTHORIZE_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const API_BASE = 'https://api.myanimelist.net/v2';
const LIST_FIELDS = 'list_status{status,score,num_episodes_watched,is_rewatching,rewatch_count,updated_at}';
const VERIFIER_LENGTH = 64; // 64 bytes -> 86 base64url chars (43-128 allowed)

function b64url(buf) {
  return buf.toString('base64url');
}

/** Deterministic PKCE pair (exported for tests). */
export function createPkcePair() {
  const verifier = b64url(randomBytes(VERIFIER_LENGTH));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export class MalService {
  /**
   * @param {object} deps
   * @param {object} deps.repository    mal repository
   * @param {Function} [deps.fetchImpl] fetch-compatible (tests inject a fake)
   */
  constructor({ repository, fetchImpl = globalThis.fetch }) {
    this.repository = repository;
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  /** True when both the public client id and the token encryption key exist. */
  get configured() {
    return Boolean(env.MAL_CLIENT_ID && env.MAL_TOKEN_ENCRYPTION_KEY);
  }

  /**
   * Diagnostics: which required MAL vars are missing from the process env.
   * @returns {{ configured: boolean, missing: string[] }}
   */
  configStatus() {
    const missing = [];
    if (!env.MAL_CLIENT_ID) missing.push('MAL_CLIENT_ID');
    if (!env.MAL_TOKEN_ENCRYPTION_KEY) missing.push('MAL_TOKEN_ENCRYPTION_KEY');
    return { configured: missing.length === 0, missing };
  }

  #requireConfigured() {
    if (!env.MAL_CLIENT_ID) {
      throw ApiError.serviceUnavailable('MyAnimeList is not configured (MAL_CLIENT_ID).');
    }
    if (!env.MAL_TOKEN_ENCRYPTION_KEY) {
      throw ApiError.serviceUnavailable(
        'MyAnimeList token encryption is not configured (MAL_TOKEN_ENCRYPTION_KEY).',
      );
    }
  }

  // --- OAuth flow -----------------------------------------------------------

  /**
   * Start: persist the PKCE pair server-side and build the MAL authorize URL.
   * @param {string} userId backend user the resulting tokens will belong to
   */
  async buildAuthorizeUrl(userId) {
    this.#requireConfigured();
    const { verifier, challenge } = createPkcePair();
    const state = b64url(randomBytes(32));
    await this.repository.insertPending({
      state,
      codeVerifier: verifier,
      userId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.MAL_CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    return { authorizeUrl: `${AUTHORIZE_URL}?${params}`, state };
  }

  /**
   * Callback: consume the server-side pending state, exchange the code,
   * fetch the profile, store encrypted tokens.
   * @param {object} query { code, state } from MAL
   */
  async handleCallback({ code, state }) {
    this.#requireConfigured();
    const pending = await this.repository.consumePending(state);
    if (!pending) {
      throw ApiError.badRequest('OAuth state expired or unknown — retry connecting.');
    }

    const form = new URLSearchParams({
      client_id: env.MAL_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      code_verifier: pending.codeVerifier,
    });
    if (env.MAL_CLIENT_SECRET) form.set('client_secret', env.MAL_CLIENT_SECRET);

    const tokens = await this.#tokenRequest(form);
    const me = await this.#api('/users/@me', { token: tokens.accessToken, retry: false });

    const expiresAt = new Date(Date.now() + (tokens.expiresIn ?? 0) * 1000);
    await this.repository.upsertAccount({
      userId: pending.userId,
      malId: me.id,
      malUsername: me.name,
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      tokenExpiresAt: expiresAt,
      scopes: 'read write',
    });
    logger.info(`[mal] linked MAL account ${me.name} (${me.id}) for ${pending.userId}`);
    return { malUser: { id: me.id, name: me.name, picture: me.picture ?? null } };
  }

  // --- account --------------------------------------------------------------

  async getMe(userId) {
    const account = await this.repository.findAccountByUser(userId);
    if (!account) return { connected: false, user: null };
    return {
      connected: true,
      user: {
        id: account.malId,
        name: account.malUsername,
        picture: null,
        tokenExpiresAt: account.tokenExpiresAt,
      },
    };
  }

  async disconnect(userId) {
    await this.repository.deleteAccount(userId);
    logger.info(`[mal] disconnected MAL account for ${userId}`);
    return { success: true };
  }

  // --- token handling (lazy refresh) ----------------------------------------

  async #tokenRequest(form) {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(env.MAL_API_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Keep the HTTP status (malStatus) so callers can distinguish MAL's
      // own auth rejection (400/401) from a MAL outage (5xx) — the former
      // means the session is dead, the latter must NOT force a re-link.
      const detail =
        typeof body.error === 'string'
          ? body.error
          : body.error?.message ?? body.error_description ?? `HTTP ${res.status}`;
      const err = new ApiError(
        503,
        'MAL_UNAVAILABLE',
        `MyAnimeList token request failed (${res.status})`,
        detail,
      );
      err.malStatus = res.status;
      throw err;
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresIn: Number(body.expires_in ?? 0),
    };
  }

  /** Refresh the stored pair; throws 401 when the refresh token is dead. */
  async #refreshAccountTokens(account) {
    if (!account.refreshTokenEnc) {
      throw ApiError.unauthorized('MyAnimeList session expired — reconnect your account.');
    }
    const form = new URLSearchParams({
      client_id: env.MAL_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: decryptSecret(account.refreshTokenEnc),
    });
    if (env.MAL_CLIENT_SECRET) form.set('client_secret', env.MAL_CLIENT_SECRET);

    let tokens;
    try {
      tokens = await this.#tokenRequest(form);
    } catch (err) {
      // Only MAL's own auth rejection (400 invalid_grant / 401) means the
      // session is dead — a MAL 5xx or network timeout must NOT make users
      // tear down and re-link.
      if (err.malStatus === 400 || err.malStatus === 401) {
        throw ApiError.unauthorized('MyAnimeList session expired — reconnect your account.');
      }
      throw err;
    }
    const expiresAt = new Date(Date.now() + (tokens.expiresIn ?? 0) * 1000);
    await this.repository.upsertAccount({
      userId: account.userId,
      malId: account.malId,
      malUsername: account.malUsername,
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : account.refreshTokenEnc,
      tokenExpiresAt: expiresAt,
      scopes: account.scopes ?? '',
    });
    return tokens.accessToken;
  }

  // In-flight refresh per user, so two requests near expiry can't each
  // refresh (MAL rotates refresh tokens — the second one would fail and log
  // the user out). Shared by #refreshFor and ensureAccessToken.
  #refreshInflight = new Map();

  async #refreshFor(userId) {
    const inflight = this.#refreshInflight.get(userId);
    if (inflight) return inflight;
    const promise = (async () => {
      const account = await this.repository.findAccountByUser(userId);
      if (!account) return null;
      return this.#refreshAccountTokens(account);
    })().finally(() => this.#refreshInflight.delete(userId));
    this.#refreshInflight.set(userId, promise);
    return promise;
  }

  /** Plaintext access token for the user, refreshing first if needed. */
  async ensureAccessToken(userId) {
    this.#requireConfigured();
    const account = await this.repository.findAccountByUser(userId);
    if (!account) throw ApiError.unauthorized('No MyAnimeList account linked.');
    const expiresAt = new Date(account.tokenExpiresAt).getTime();
    if (Date.now() > expiresAt - 60_000) {
      // Single-flighted with #refreshFor so concurrent requests share one
      // refresh instead of racing each other.
      const refreshed = await this.#refreshFor(userId);
      if (!refreshed) throw ApiError.unauthorized('No MyAnimeList account linked.');
      return refreshed;
    }
    return decryptSecret(account.accessTokenEnc);
  }

  /** Authenticated MAL API call; retries once after a forced refresh on 401. */
  async #api(path, { method = 'GET', token, form = null, refresh = null, retry = true, okStatuses = null } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method,
      headers,
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(env.MAL_API_TIMEOUT_MS),
    });
    if (res.status === 401 && retry && refresh) {
      const fresh = await refresh();
      if (fresh) {
        return this.#api(path, { method, token: fresh, form, refresh, retry: false, okStatuses });
      }
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !(okStatuses && okStatuses.includes(res.status))) {
      // A 401 after a fresh token (or without a refresh closure) means the
      // MAL session is dead — surface it as such instead of a proxy error.
      if (res.status === 401) {
        throw ApiError.unauthorized('MyAnimeList session expired — reconnect your account.');
      }
      const detail =
        typeof body.error === 'string' ? body.error : body.error?.message ?? 'unknown error';
      throw ApiError.badGateway(
        `MyAnimeList API ${method} ${path} failed (${res.status}): ${detail}`,
      );
    }
    return body;
  }

  // --- list sync ------------------------------------------------------------

  /** Paginated local entries for the user (joined with the local catalog). */
  async listEntries(userId, { status = null, page = 1, limit = 20 }) {
    return this.repository.listEntries(userId, { status, limit, offset: (page - 1) * limit });
  }

  /** Pull the full MAL list and upsert it locally. Prunes rows MAL no longer has. */
  async syncList(userId) {
    this.#requireConfigured();
    const token = await this.ensureAccessToken(userId);
    const refresh = () => this.#refreshFor(userId);

    const malIds = [];
    let matched = 0;
    let offset = 0;
    const PAGE = 1000;

    // Fetch every page first — only prune local rows after a complete fetch.
    const pages = [];
    for (;;) {
      const q = new URLSearchParams({
        fields: LIST_FIELDS,
        limit: String(PAGE),
        offset: String(offset),
        nsfw: 'true',
      });
      const body = await this.#api(`/users/@me/animelist?${q}`, { token, refresh });
      pages.push(body.data ?? []);
      if (!body.paging?.next) break;
      offset += PAGE;
      if (pages.length > 20) {
        // Safety valve: 20k entries is beyond any real list.
        throw ApiError.badGateway('MyAnimeList sync exceeded the safety limit.');
      }
    }

    for (const page of pages) {
      for (const item of page) {
        const entry = this.#normalizeListItem(item);
        malIds.push(entry.malAnimeId);
        const animeId = await this.repository.findAnimeIdByMalId(entry.malAnimeId);
        if (animeId != null) matched += 1;
        await this.repository.upsertEntry(userId, { ...entry, animeId });
      }
    }

    const removed = await this.repository.deleteEntriesExcept(userId, malIds);
    logger.info(`[mal] synced ${malIds.length} entries for ${userId} (${matched} matched, ${removed} removed)`);
    return { synced: malIds.length, matched, removed };
  }

  #normalizeListItem(item) {
    const node = item.node ?? {};
    const ls = item.list_status ?? {};
    return {
      malAnimeId: node.id,
      status: ls.status ?? 'plan_to_watch',
      score: Number(ls.score ?? 0),
      episodesWatched: Number(ls.num_episodes_watched ?? 0),
      isRewatching: Boolean(ls.is_rewatching ?? false),
      rewatchCount: Number(ls.rewatch_count ?? 0),
      updatedAt: ls.updated_at ? new Date(ls.updated_at) : new Date(),
    };
  }

  // --- per-entry operations -------------------------------------------------

  async updateEntry(userId, malAnimeId, patch) {
    const token = await this.ensureAccessToken(userId);
    const refresh = () => this.#refreshFor(userId);
    const form = new URLSearchParams();
    if (patch.status != null) form.set('status', patch.status);
    if (patch.score != null) form.set('score', String(patch.score));
    if (patch.episodesWatched != null) form.set('num_watched_episodes', String(patch.episodesWatched));
    if (patch.isRewatching != null) form.set('is_rewatching', patch.isRewatching ? 'true' : 'false');
    if (patch.rewatchCount != null) form.set('num_times_rewatched', String(patch.rewatchCount));

    const ls = await this.#api(`/anime/${malAnimeId}/my_list_status`, { method: 'PATCH', token, form, refresh });
    const animeId = await this.repository.findAnimeIdByMalId(malAnimeId);
    await this.repository.upsertEntry(userId, {
      malAnimeId,
      animeId,
      status: ls.status ?? patch.status ?? 'plan_to_watch',
      score: Number(ls.score ?? patch.score ?? 0),
      episodesWatched: Number(ls.num_episodes_watched ?? patch.episodesWatched ?? 0),
      isRewatching: Boolean(ls.is_rewatching ?? patch.isRewatching ?? false),
      rewatchCount: Number(ls.rewatch_count ?? patch.rewatchCount ?? 0),
      updatedAt: ls.updated_at ? new Date(ls.updated_at) : new Date(),
    });
    // upsertEntry only RETURNs id/malAnimeId/animeId; re-select the full row
    // so add/update responses match the MalListEntry shape the frontend uses
    // (status, score, episodesWatched, …) instead of a partial object whose
    // missing `status` breaks the optimistic cache write.
    const entry = await this.repository.findEntry(userId, malAnimeId);
    return { malAnimeId, entry };
  }

  /** Add an anime to the MAL list (PATCH with status creates the entry). */
  async addEntry(userId, { malAnimeId, status, score, episodesWatched }) {
    return this.updateEntry(userId, malAnimeId, {
      status,
      score,
      episodesWatched,
      isRewatching: false,
      rewatchCount: 0,
    });
  }

  async removeEntry(userId, malAnimeId) {
    const token = await this.ensureAccessToken(userId);
    const refresh = () => this.#refreshFor(userId);
    // Route through #api so a 401 triggers the refresh-and-retry path like
    // every other MAL write (previously this bypassed it entirely). 404 = the
    // entry is already gone — idempotent remove, not an error.
    await this.#api(`/anime/${malAnimeId}/my_list_status`, {
      method: 'DELETE',
      token,
      refresh,
      okStatuses: [404],
    });
    await this.repository.deleteEntry(userId, malAnimeId);
    return { success: true };
  }

  /**
   * Auto-progress: called by the player when an episode is watched. Only
   * touches MAL when the anime has a local entry; silently no-ops otherwise.
   */
  async updateProgress(userId, animeId, episodeNumber) {
    const entry = await this.repository.findEntryByAnimeId(userId, animeId);
    if (!entry) return { updated: false, reason: 'not_on_mal_list' };
    await this.updateEntry(userId, entry.malAnimeId, {
      episodesWatched: Math.max(entry.episodesWatched, episodeNumber),
    });
    return { updated: true };
  }
}
