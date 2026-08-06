// Auth HTTP handlers. Thin layer: parse input, call the service, shape output.
// The refresh token is also set as an httpOnly cookie so browser clients can
// authenticate without storing it in JS.
import { asyncHandler } from '../../lib/async-handler.js';
import { refreshTokenLifetimeMs } from '../../lib/jwt.js';

function refreshTokenFrom(req) {
  return req.body.refreshToken ?? req.cookies?.refresh_token ?? null;
}

function setRefreshCookie(res, token, maxAgeMs) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: maxAgeMs,
  });
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
      await authService.logout(refreshTokenFrom(req));
      res.clearCookie('refresh_token', { path: '/api/auth' });
      res.json({ success: true });
    }),
  };
}
