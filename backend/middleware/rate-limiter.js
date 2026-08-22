'use strict';

/**
 * rate-limiter.js — Multi-layer DDoS / abuse protection (zero external deps)
 *
 * Layers applied by server.js:
 *
 *   1. globalCircuitBreaker  — applied first, server-wide. Rejects everyone when
 *                              total server traffic exceeds a per-minute ceiling.
 *                              Protects against distributed floods that stay under
 *                              per-IP limits by using many IPs.
 *
 *   2. ipBlocklist           — checked second. Permanently blocked IPs get 403.
 *                              Auto-block after sustained abuse. Admin can add IPs via
 *                              blockIp(). Persists only for the server's uptime.
 *
 *   3. rateLimiter           — 300 req/hr per IP on all /api routes. Hourly reset.
 *                              Catches slow, sustained crawling.
 *
 *   4. burstLimiter          — 60 req/min per IP (=1 req/sec sustained). Sliding
 *                              1-minute window. Stops burst floods from a single IP
 *                              before they exhaust the hourly budget.
 *
 *   5. aiRateLimiter         — 30 req/min per IP on /api/ai. Each call is a paid
 *                              LLM inference — tighter budget than everything else.
 *
 *   6. ttsLimiter            — 15 req/min per IP on /api/tts routes. Sarvam API
 *                              has its own per-minute quota; this prevents a single
 *                              user from exhausting it.
 *
 *   7. scrapeLimiter         — 1 manual scrape per 10 min per IP on /api/scrape-sakshi.
 *                              Scraping is CPU+network intensive; accidental double-
 *                              clicks or scripts shouldn't trigger concurrent scrapes.
 *
 * Auto-block: any IP that hits the burst limit 3 times in an hour is auto-blocked
 *             for 24 hours. Clears itself; no manual intervention needed.
 *
 * All maps are garbage-collected every 15 minutes to prevent memory growth.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function getIp(req) {
  // req.ip is set by express when trust proxy is on (preferred).
  // Fallback chain: X-Forwarded-For first IP → socket address → 'unknown'.
  const ip = req.ip
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  // Normalise IPv4-mapped IPv6 "::ffff:1.2.3.4" → "1.2.3.4" for blocklist matching.
  return ip.replace(/^::ffff:/, '');
}

function isLocal(ip) {
  return ip === '::1' || ip === '127.0.0.1' || ip === 'localhost' || ip === 'unknown';
}

function retryResponse(res, resetAt, label = 'Rate limit exceeded') {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ error: label, retryAfter: `${retryAfter}s` });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Global circuit breaker — server-wide total request cap
// ─────────────────────────────────────────────────────────────────────────────
// If the entire server receives more than GLOBAL_MAX requests in one minute,
// every new request (except localhost) is rejected with 503 until load drops.
// This protects against distributed floods where each individual IP stays under
// per-IP limits.

const GLOBAL_MAX      = 2000;  // total requests per minute across ALL IPs
const GLOBAL_WINDOW   = 60 * 1000;
let   globalCount     = 0;
let   globalWindowEnd = Date.now() + GLOBAL_WINDOW;

function globalCircuitBreaker(req, res, next) {
  const now = Date.now();
  if (now > globalWindowEnd) {
    globalCount     = 0;
    globalWindowEnd = now + GLOBAL_WINDOW;
  }
  globalCount++;
  if (!isLocal(getIp(req)) && globalCount > GLOBAL_MAX) {
    res.set('Retry-After', '60');
    return res.status(503).json({
      error: 'Server temporarily overloaded. Please try again in 60 seconds.',
    });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. IP blocklist
// ─────────────────────────────────────────────────────────────────────────────

// blockedIps: Map<ip, { until: number, reason: string }>
const blockedIps = new Map();

// Auto-block tracker: Map<ip, { burstViolations: number, firstViolation: number }>
const abuseTracker = new Map();
const ABUSE_THRESHOLD       = 3;   // violations before auto-block
const ABUSE_WINDOW_MS       = 60 * 60 * 1000;  // 1 hour tracking window
const AUTO_BLOCK_DURATION   = 24 * 60 * 60 * 1000; // 24h auto-block

function blockIp(ip, durationMs = AUTO_BLOCK_DURATION, reason = 'manual') {
  blockedIps.set(ip, { until: Date.now() + durationMs, reason });
  console.warn(`[NewsAI Security] 🚫 IP blocked: ${ip} | reason=${reason} | duration=${durationMs / 3600000}h`);
}

function unblockIp(ip) {
  blockedIps.delete(ip);
  abuseTracker.delete(ip);
}

function recordAbuse(ip) {
  const now  = Date.now();
  let   rec  = abuseTracker.get(ip);
  if (!rec || now - rec.firstViolation > ABUSE_WINDOW_MS) {
    rec = { burstViolations: 0, firstViolation: now };
  }
  rec.burstViolations++;
  abuseTracker.set(ip, rec);
  if (rec.burstViolations >= ABUSE_THRESHOLD) {
    blockIp(ip, AUTO_BLOCK_DURATION, `auto:${rec.burstViolations}_burst_violations`);
    abuseTracker.delete(ip);
  }
}

function ipBlocklistMiddleware(req, res, next) {
  const ip  = getIp(req);
  if (isLocal(ip)) return next();
  const rec = blockedIps.get(ip);
  if (rec) {
    if (Date.now() < rec.until) {
      const secsLeft = Math.ceil((rec.until - Date.now()) / 1000);
      return res.status(403).json({
        error: 'Access denied.',
        retryAfter: `${secsLeft}s`,
      });
    }
    // Block expired — clean up
    blockedIps.delete(ip);
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Per-IP hourly rate limiter — baseline protection
// ─────────────────────────────────────────────────────────────────────────────
// Max 300 requests per hour per IP. Ingest routes may need more calls during
// initial load; if that becomes an issue, bump MAX_REQUESTS or exempt /api/ingest.

const hourlyMap  = new Map();   // ip → { count, resetAt }
const MAX_REQUESTS = 300;
const HOURLY_WINDOW = 60 * 60 * 1000;

function rateLimiter(req, res, next) {
  const ip  = getIp(req);
  if (isLocal(ip)) return next();
  const now = Date.now();
  let   rec = hourlyMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 1, resetAt: now + HOURLY_WINDOW };
    hourlyMap.set(ip, rec);
    return next();
  }
  rec.count++;
  if (rec.count > MAX_REQUESTS) {
    recordAbuse(ip);
    return retryResponse(res, rec.resetAt, `Hourly limit of ${MAX_REQUESTS} requests exceeded`);
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Burst limiter — short-window flood protection
// ─────────────────────────────────────────────────────────────────────────────
// Max 60 req/min per IP. Stops a single IP from sending 300 requests in one
// second (which the hourly limiter alone would allow).

const burstMap     = new Map();
const BURST_MAX    = 60;
const BURST_WINDOW = 60 * 1000;

function burstLimiter(req, res, next) {
  const ip  = getIp(req);
  if (isLocal(ip)) return next();
  const now = Date.now();
  let   rec = burstMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 1, resetAt: now + BURST_WINDOW };
    burstMap.set(ip, rec);
    return next();
  }
  rec.count++;
  if (rec.count > BURST_MAX) {
    recordAbuse(ip);
    return retryResponse(res, rec.resetAt, `Burst limit exceeded — max ${BURST_MAX} requests per minute`);
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. AI rate limiter — tight limit for expensive LLM calls
// ─────────────────────────────────────────────────────────────────────────────

const aiMap     = new Map();
const AI_MAX    = 30;
const AI_WINDOW = 60 * 1000;

function aiRateLimiter(req, res, next) {
  const ip  = getIp(req);
  if (isLocal(ip)) return next();
  const now = Date.now();
  let   rec = aiMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 1, resetAt: now + AI_WINDOW };
    aiMap.set(ip, rec);
    return next();
  }
  rec.count++;
  if (rec.count > AI_MAX) {
    return retryResponse(res, rec.resetAt, `AI limit: max ${AI_MAX} AI requests per minute per IP`);
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. TTS rate limiter — Sarvam API quota protection
// ─────────────────────────────────────────────────────────────────────────────

const ttsMap     = new Map();
const TTS_MAX    = 15;
const TTS_WINDOW = 60 * 1000;

function ttsLimiter(req, res, next) {
  const ip  = getIp(req);
  if (isLocal(ip)) return next();
  const now = Date.now();
  let   rec = ttsMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 1, resetAt: now + TTS_WINDOW };
    ttsMap.set(ip, rec);
    return next();
  }
  rec.count++;
  if (rec.count > TTS_MAX) {
    return retryResponse(res, rec.resetAt, `TTS limit: max ${TTS_MAX} audio requests per minute`);
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Scrape rate limiter — CPU/network-intensive manual trigger
// ─────────────────────────────────────────────────────────────────────────────

const scrapeMap     = new Map();
const SCRAPE_MAX    = 1;
const SCRAPE_WINDOW = 10 * 60 * 1000;  // 10 minutes

function scrapeLimiter(req, res, next) {
  const ip  = getIp(req);
  if (isLocal(ip)) return next();
  const now = Date.now();
  let   rec = scrapeMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 1, resetAt: now + SCRAPE_WINDOW };
    scrapeMap.set(ip, rec);
    return next();
  }
  rec.count++;
  if (rec.count > SCRAPE_MAX) {
    return retryResponse(res, rec.resetAt, 'Manual scrape already running — wait 10 minutes between triggers');
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Suspicious User-Agent filter
// ─────────────────────────────────────────────────────────────────────────────
// Blocks headless/bot traffic that doesn't pretend to be a browser.
// Won't stop determined attackers (they can set any UA) but blocks naive scripts.

const BLOCKED_UA_PATTERNS = [
  /^python-requests/i,
  /^curl\//i,
  /^wget\//i,
  /^httpie/i,
  /^go-http-client/i,
  /^java\//i,
  /^axios\//i,
  /^node-fetch\//i,
  /masscan/i,
  /zgrab/i,
  /nmap/i,
  /scanner/i,
  /nikto/i,
  /sqlmap/i,
  /dirbuster/i,
];

// Routes excluded from UA filter (scraper uses node-fetch internally, portals use curl-like tools)
// /api/security — admin operators use curl/httpie to block IPs and check stats; requireAdmin still protects them
const UA_EXEMPT_PATHS = ['/api/ingest', '/api/scrape-sakshi', '/api/poll-xml', '/portal', '/api/security'];

function uaFilter(req, res, next) {
  const path = req.path || '';
  if (UA_EXEMPT_PATHS.some(p => path.startsWith(p))) return next();
  const ua = req.headers['user-agent'] || '';
  if (!ua) {
    // No UA at all — very suspicious for an API that the widget always sends one to
    return res.status(400).json({ error: 'Missing User-Agent header' });
  }
  if (BLOCKED_UA_PATTERNS.some(re => re.test(ua))) {
    return res.status(403).json({ error: 'Automated access not permitted' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Garbage collection — prevent unbounded Map growth
// ─────────────────────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now();
  for (const map of [hourlyMap, burstMap, aiMap, ttsMap, scrapeMap]) {
    for (const [ip, rec] of map) {
      if (now > rec.resetAt) map.delete(ip);
    }
  }
  // Prune expired blocks
  for (const [ip, rec] of blockedIps) {
    if (now > rec.until) blockedIps.delete(ip);
  }
  // Prune stale abuse tracker entries
  for (const [ip, rec] of abuseTracker) {
    if (now - rec.firstViolation > ABUSE_WINDOW_MS) abuseTracker.delete(ip);
  }
}, 15 * 60 * 1000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// Request timeout middleware
// ─────────────────────────────────────────────────────────────────────────────
// Kills connections that take longer than timeoutMs. Prevents slow-loris attacks
// and runaway handlers from tying up workers indefinitely.

function requestTimeout(timeoutMs = 30000) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(503).json({ error: 'Request timed out' });
      }
    }, timeoutMs);
    // Clear the timer once the response is finished (success or error)
    res.on('finish', () => clearTimeout(timer));
    res.on('close',  () => clearTimeout(timer));
    next();
  };
}

module.exports = {
  // Middleware
  globalCircuitBreaker,
  ipBlocklistMiddleware,
  rateLimiter,
  burstLimiter,
  aiRateLimiter,
  ttsLimiter,
  scrapeLimiter,
  uaFilter,
  requestTimeout,
  // Blocklist management
  blockIp,
  unblockIp,
  // Stats (for monitoring)
  getStats: () => ({
    blockedIps:      blockedIps.size,
    trackedIps:      hourlyMap.size,
    burstTracked:    burstMap.size,
    aiTracked:       aiMap.size,
    globalReqPerMin: globalCount,
  }),
};
