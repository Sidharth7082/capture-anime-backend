// Auth request/response schemas.
import { z } from 'zod';

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72)
  // bcrypt truncates at 72 BYTES, so enforce the byte limit explicitly
  // (multi-byte UTF-8 characters would otherwise be silently cut).
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
    message: 'Password must be at most 72 bytes (bcrypt limit)',
  });

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
  // bcrypt truncates at 72 BYTES (same rule as register): a login password
  // capped only at 72 characters would verify successfully for any value
  // sharing the first 72 bytes with the real password.
  password: z
    .string()
    .min(1)
    .max(72)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
      message: 'Password must be at most 72 bytes (bcrypt limit)',
    }),
});

// Refresh token may arrive in the request body or the httpOnly cookie.
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});

export const logoutSchema = refreshTokenSchema;
