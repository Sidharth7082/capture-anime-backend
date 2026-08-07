// Auth routes. Sensitive endpoints get a stricter rate limit.
import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { createAuthController } from './auth.controller.js';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  logoutSchema,
} from './auth.schemas.js';

export function createAuthRouter({ authService, authLimiter, refreshLimiter }) {
  const router = Router();
  const controller = createAuthController(authService);

  router.post('/register', authLimiter, validate({ body: registerSchema }), controller.register);
  router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
  // Refresh fires roughly every access-token lifetime per active tab; a
  // shared bucket with login (10/15min) would 429 real users after a few
  // failed logins. Give it its own, higher limit.
  router.post('/refresh', refreshLimiter ?? authLimiter, validate({ body: refreshTokenSchema }), controller.refresh);
  router.post('/logout', authLimiter, validate({ body: logoutSchema }), controller.logout);

  return router;
}
