// 404 for unmatched routes.
import { ApiError } from '../lib/errors.js';

export function notFound(req, _res, next) {
  next(new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));
}
