// Auth HTTP handlers. Thin layer: parse input, call the service, shape output.
// The refresh token is also set as an httpOnly cookie so browser clients can
// authenticate without storing it in JS.
import { asyncHandler } from '../../lib/async-handler.js';
import { refreshTokenLifetimeMs } from '../../lib/jwt.js';
import { cookieIsSecure } from '../../lib/cookies.js';

function refreshTokenFrom(req) {
  return req.body.refreshToken ?? req.cookies?.refresh_token ?? null;
}

function refreshCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: cookieIsSecure(),
    sameSite: 'lax',
    path: '/api/auth',
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}

function setRefreshCookie(res, token, maxAgeMs) {
  res.cookie('refresh_token', token, refreshCookieOptions(maxAgeMs));
}

function clearRefreshCookie(res) {
  // Mirror the set options (path/secure/sameSite) or browsers ignore the
  // deletion cookie and the token stays on the device.
  res.clearCookie('refresh_token', refreshCookieOptions());
}

export function createAuthController(authService, { now = () => new Date() } = {}) {
  return {
    register: asyncHandler(async (req, res) => {
      const { user, tokens } = await authService.register(req.body);
      setRefreshCookie(res, tokens.refreshToken, refreshTokenLifetimeMs());
      res.status(201).json({ user, tokens });
    }),

    login: asyncHandler(async (req, res) => {
      const { user, tokens } = await authService.login(req.body);
      setRefreshCookie(res, tokens.refreshToken, refreshTokenLifetimeMs());
      res.json({ user, tokens });
    }),

    refresh: asyncHandler(async (req, res) => {
      const { user, tokens } = await authService.refresh(refreshTokenFrom(req));
      setRefreshCookie(res, tokens.refreshToken, refreshTokenLifetimeMs());
      res.json({ user, tokens });
    }),

    logout: asyncHandler(async (req, res) => {
      // Revoke BOTH presented tokens: a client may send a body token while a
      // (possibly older, still-valid) cookie token is also present — leaving
      // one live would keep a server-side session valid after logout.
      await authService.logout([req.body.refreshToken, req.cookies?.refresh_token]);
      clearRefreshCookie(res);
      res.json({ success: true });
    }),
  };
}
