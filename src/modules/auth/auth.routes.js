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

export function createAuthRouter({ authService, authLimiter }) {
  const router = Router();
  const controller = createAuthController(authService);

  router.post('/register', authLimiter, validate({ body: registerSchema }), controller.register);
  router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
  router.post('/refresh', authLimiter, validate({ body: refreshTokenSchema }), controller.refresh);
  router.post('/logout', validate({ body: logoutSchema }), controller.logout);

  return router;
}
