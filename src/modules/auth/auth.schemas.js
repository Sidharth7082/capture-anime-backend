// Auth request/response schemas.
import { z } from 'zod';

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(72);

export const registerSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(32)
    .regex(/^[A-Za-z0-9_]+$/, 'Username may only contain letters, digits and underscores'),
  email: z.string().email('Invalid email address').max(254),
  password: passwordSchema,
});

// Login accepts either an email or a username in `identifier`.
export const loginSchema = z.object({
  identifier: z.string().min(1).max(254),
  password: z.string().min(1).max(72),
});

// Refresh token may arrive in the request body or the httpOnly cookie.
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const logoutSchema = refreshTokenSchema;
