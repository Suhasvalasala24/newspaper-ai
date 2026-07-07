'use strict';

/**
 * Simple in-memory per-IP rate limiter.
 * Default: 60 requests per hour per IP.
 * No external dependencies.
 *
 * Usage in server.js:
 *   const { rateLimiter } = require('./middleware/rate-limiter');
 *   app.use('/api', rateLimiter);
 */

const requests = new Map(); // ip → { count: number, resetAt: number }

const MAX_REQUESTS = 5000; // raised: bulk ingest sends 100+ requests per load
const WINDOW_MS    = 60 * 60 * 1000; // 1 hour

function rateLimiter(req, res, next) {
  const ip  = req.ip
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || 'unknown';

  // Skip rate limiting for localhost — this is a local dev server
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') return next();
  const now = Date.now();
  let rec   = requests.get(ip);

  if (!rec || now > rec.resetAt) {
    rec = { count: 1, resetAt: now + WINDOW_MS };
    requests.set(ip, rec);
    return next();
  }

  rec.count++;
  if (rec.count > MAX_REQUESTS) {
    const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
    res.set('Retry-After', retryAfter);
    return res.status(429).json({
      error:      'Rate limit exceeded',
      retryAfter: `${retryAfter}s`,
      message:    `Max ${MAX_REQUESTS} requests per hour per IP`,
    });
  }

  next();
}

// Garbage-collect stale entries every 15 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of requests) {
    if (now > rec.resetAt) requests.delete(ip);
  }
}, 15 * 60 * 1000).unref(); // .unref() so it doesn't keep Node alive if server exits

module.exports = { rateLimiter };
