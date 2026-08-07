// MAL HTTP handlers. The OAuth connect/callback pair is unauthenticated
// (browser redirect flow); everything else requires the backend JWT.
import { asyncHandler } from '../../lib/async-handler.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';

export function createMalController(malService) {
  const userId = (req) => req.user.sub;

  return {
    /**
     * Start OAuth. JWT-protected: the SPA fetches this with its Bearer token
     * and receives the MAL authorize URL as JSON — the browser never
     * navigates here directly (a plain <a href> would 401). The PKCE
     * verifier + user id were persisted server-side keyed by `state`.
     */
    connect: asyncHandler(async (req, res) => {
      const status = malService.configStatus();
      if (!status.configured) {
        throw ApiError.serviceUnavailable(
          `MyAnimeList is not configured: missing ${status.missing.join(', ')}. ` +
            'Set them in the server .env and restart the process.',
          undefined,
          true, // expose — safe diagnostic on an authenticated endpoint
        );
      }
      const { authorizeUrl, state } = await malService.buildAuthorizeUrl(req.user.sub);
      // Bind the OAuth state to THIS browser: the callback (a top-level
      // navigation from MAL) must present the same signed cookie, otherwise
      // anyone who obtains an authorizeUrl (e.g. tricking a victim into
      // completing a flow started under the attacker's account) could link
      // the victim's MAL tokens to the attacker's backend user — an
      // account-linking CSRF. Note: same-site on LAN deployments; behind a
      // cross-site frontend the browser must accept third-party cookies.
      res.cookie('mal_state', state, {
        httpOnly: true,
        signed: true,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production' && env.COOKIE_SECURE !== 'false',
        path: '/api/mal',
        maxAge: 10 * 60 * 1000,
      });
      res.json({ authorizeUrl });
    }),

    /** MAL redirects here with ?code=&state= (or ?error= on denial). */
    callback: asyncHandler(async (req, res) => {
      const { code, state, error } = req.query;
      if (error || !code || !state) {
        return res.redirect(`${env.FRONTEND_URL}/profile#mal=${error ? 'denied' : 'error'}`);
      }
      // The state in the URL must match the signed cookie set by /connect.
      // Reject when missing or mismatched — see the CSRF note in connect().
      if (!req.signedCookies.mal_state || req.signedCookies.mal_state !== state) {
        return res.redirect(`${env.FRONTEND_URL}/profile#mal=error`);
      }
      try {
        await malService.handleCallback({ code, state });
        res.clearCookie('mal_state', { path: '/api/mal' });
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
