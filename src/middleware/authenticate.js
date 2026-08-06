// JWT access-token authentication. Populates req.user on success.
import { verifyAccessToken } from '../lib/jwt.js';
import { ApiError } from '../lib/errors.js';
import { asyncHandler } from '../lib/async-handler.js';

export const authenticate = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw ApiError.unauthorized('Missing bearer token');
  req.user = verifyAccessToken(token);
  next();
});
