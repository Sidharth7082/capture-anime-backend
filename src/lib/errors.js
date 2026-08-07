// Application errors — the error handler maps these to HTTP responses.
export class ApiError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} code    stable machine-readable error code
   * @param {string} message human-readable message
   * @param {unknown} [details] optional structured details (e.g. validation issues)
   * @param {boolean} [expose]   true keeps the message visible on 5xx (the
   *   handler otherwise sanitizes 5xx messages to 'Internal server error').
   *   Use only for genuinely safe diagnostics (e.g. missing env var names on
   *   an authenticated endpoint) — never for internal stack details.
   */
  constructor(status, code, message, details, expose = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
    this.isOperational = true; // expected error, not a bug
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static serviceUnavailable(message = 'Service unavailable', details, expose = false) {
    return new ApiError(503, 'SERVICE_UNAVAILABLE', message, details, expose);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static conflict(message = 'Conflict') {
    return new ApiError(409, 'CONFLICT', message);
  }

  static badGateway(message = 'Bad gateway') {
    return new ApiError(502, 'BAD_GATEWAY', message);
  }
}
