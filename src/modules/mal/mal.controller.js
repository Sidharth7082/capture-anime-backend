// MAL HTTP handlers. The OAuth connect/callback pair is unauthenticated
// (browser redirect flow); everything else requires the backend JWT.
import { asyncHandler } from '../../lib/async-handler.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';
import { cookieIsSecure } from '../../lib/cookies.js';

export function createMalController(malService) {
  const userId = (req) => req.user.sub;

  // Same flags as the auth refresh cookie (shared cookieIsSecure()), so an
  // http:// LAN deployment can't send a Secure cookie browsers refuse to
  // store. clearCookie must mirror path/secure/sameSite or the deletion is
  // ignored.
  const malStateCookieOptions = {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: cookieIsSecure(),
    path: '/api/mal',
  };
  const setMalStateCookie = (res, state) =>
    res.cookie('mal_state', state, { ...malStateCookieOptions, maxAge: 10 * 60 * 1000 });
  const clearMalStateCookie = (res) => res.clearCookie('mal_state', malStateCookieOptions);

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
      setMalStateCookie(res, state);
      res.json({ authorizeUrl });
    }),

    /** MAL redirects here with ?code=&state= (or ?error= on denial). */
    callback: asyncHandler(async (req, res) => {
      const { code, state, error } = req.query;
      // Every terminal path clears the state cookie — an orphaned cookie is
      // useless to an attacker but lingers up to 10 min if never deleted.
      if (error || !code || !state) {
        clearMalStateCookie(res);
        return res.redirect(`${env.FRONTEND_URL}/profile#mal=${error ? 'denied' : 'error'}`);
      }
      // The state in the URL must match the signed cookie set by /connect.
      // Reject when missing or mismatched — see the CSRF note in connect().
      if (!req.signedCookies.mal_state || req.signedCookies.mal_state !== state) {
        clearMalStateCookie(res);
        return res.redirect(`${env.FRONTEND_URL}/profile#mal=error`);
      }
      try {
        await malService.handleCallback({ code, state });
        clearMalStateCookie(res);
        res.redirect(`${env.FRONTEND_URL}/profile#mal=connected`);
      } catch (err) {
        // 4xx (expired/unknown state, dead session) => 'expired'; 5xx or
        // network errors (MAL down) => 'error', so the UI doesn't tell users
        // to tear down and re-link during a MAL outage.
        const reason = err instanceof ApiError && err.status < 500 ? 'expired' : 'error';
        clearMalStateCookie(res);
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
