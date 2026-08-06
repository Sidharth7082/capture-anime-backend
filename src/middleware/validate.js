// Zod request validation. Validates params/query/body against the route's
// schema and replaces them with the parsed (coerced) values.
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';

export function validate(schemas = {}) {
  return (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(
          new ApiError(
            400,
            'VALIDATION_ERROR',
            'Invalid request payload',
            err.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          ),
        );
      }
      next(err);
    }
  };
}
