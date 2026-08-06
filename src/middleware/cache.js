// Response caching middleware for idempotent GET endpoints.
// On a hit it replays the stored JSON with an X-Cache: HIT header; on a miss
// it records the response (only 2xx) and sets X-Cache: MISS.
export function cacheResponse(cache, { ttlMs } = {}) {
  return (req, res, next) => {
    if (ttlMs <= 0 || cache.ttlMs <= 0) return next();

    const key = `${req.method}:${req.originalUrl}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      res.set('X-Cache', 'HIT');
      return res.status(hit.status).json(hit.body);
    }

    res.set('X-Cache', 'MISS');
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        cache.set(key, { status: res.statusCode, body }, ttlMs);
      }
      return originalJson(body);
    };
    next();
  };
}
