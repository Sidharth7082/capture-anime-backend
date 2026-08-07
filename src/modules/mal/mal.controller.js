// MAL HTTP handlers. The OAuth connect/callback pair is unauthenticated
// (browser redirect flow); everything else requires the backend JWT.
import { asyncHandler } from '../../lib/async-handler.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';

const OAUTH_COOKIE = 'mal_oauth';
const OAUTH_COOKIE_MAX_AGE = 10 * 60 * 1000; // 10 minutes to complete OAuth

export function createMalController(malService) {
  const userId = (req) => req.user.sub;

  return {
    /** Start OAuth: set the signed cookie (verifier+state+userId), 302 to MAL. */
    connect: asyncHandler(async (req, res) => {
      if (!malService.configured) {
        throw ApiError.serviceUnavailable('MyAnimeList is not configured on this server.');
      }
      const { url, payload } = malService.buildAuthorizeUrl(req.user.sub);
      res.cookie(OAUTH_COOKIE, payload, {
        httpOnly: true,
        signed: true,
        sameSite: 'lax',
        secure: env.COOKIE_SECURE === undefined ? env.NODE_ENV === 'production' : env.COOKIE_SECURE === 'true',
        maxAge: OAUTH_COOKIE_MAX_AGE,
        path: '/api/mal/callback',
      });
      res.redirect(url);
    }),

    /** MAL redirects here with ?code=&state= (or ?error= on denial). */
    callback: asyncHandler(async (req, res) => {
      const { code, state, error } = req.query;
      const payload = req.signedCookies?.[OAUTH_COOKIE] ?? null;
      res.clearCookie(OAUTH_COOKIE, { path: '/api/mal/callback' });
      if (error || !code || !payload) {
        return res.redirect(`${env.FRONTEND_URL}/profile#mal=${error ? 'denied' : 'error'}`);
      }
      try {
        await malService.handleCallback({ code, state }, payload);
        res.redirect(`${env.FRONTEND_URL}/profile#mal=connected`);
      } catch (err) {
        // Surface the reason via a hash flag so the UI can show a toast.
        const reason = err instanceof ApiError ? 'expired' : 'error';
        res.redirect(`${env.FRONTEND_URL}/profile#mal=${reason}`);
      }
    }),

    me: asyncHandler(async (req, res) => res.json(await malService.getMe(userId(req)))),

    disconnect: asyncHandler(async (req, res) =>
      res.json(await malService.disconnect(userId(req))),
    ),

    sync: asyncHandler(async (req, res) =>
      res.json(await malService.syncList(userId(req))),
    ),

    list: asyncHandler(async (req, res) => {
      const { status, page, limit } = req.query;
      const { items, total } = await malService.listEntries(userId(req), { status, page, limit });
      res.json({
        data: items,
        meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasNextPage: page * limit < total },
      });
    }),

    update: asyncHandler(async (req, res) =>
      res.json(await malService.updateEntry(userId(req), req.params.malAnimeId, req.body)),
    ),

    add: asyncHandler(async (req, res) =>
      res.json(await malService.addEntry(userId(req), req.body)),
    ),

    remove: asyncHandler(async (req, res) =>
      res.json(await malService.removeEntry(userId(req), req.params.malAnimeId)),
    ),

    progress: asyncHandler(async (req, res) =>
      res.json(await malService.updateProgress(userId(req), req.body.animeId, req.body.episodeNumber)),
    ),
  };
}
