// Redact sensitive query parameters before URLs reach logs. The MAL OAuth
// callback arrives as GET /api/mal/callback?code=...&state=... — both are
// single-use secrets that must not be persisted to log files.
const SENSITIVE_QUERY_KEYS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'password',
  'client_secret',
]);

export function redactSensitiveQuery(url) {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  const params = new URLSearchParams(url.slice(qIndex + 1));
  let redacted = false;
  for (const key of SENSITIVE_QUERY_KEYS) {
    if (params.has(key)) {
      params.set(key, '[redacted]');
      redacted = true;
    }
  }
  return redacted ? `${url.slice(0, qIndex)}?${params.toString()}` : url;
}
