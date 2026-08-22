'use strict';

// Load .env before any other require so process.env is populated
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path          = require('path');
const { ingestPdf } = require('./routes/ingest-pdf');
const { scrape }    = require('./routes/scrape');
const { tts, ttsStream, ttsBinaryStream } = require('./routes/tts');
const { ingestArticle, getToday, getBreakingCount, resetToday, loadSample } = require('./routes/ingest');
const { queryArticles, clearQueryCache } = require('./routes/query');
const { embedArticles, embedStatus, runEmbeddingBackground } = require('./routes/embed');
const { translate, translateBatch } = require('./routes/translate');
const { ingestToday, briefingStatus } = require('./routes/ingest-today');
const { chat, listSections }          = require('./routes/chat');
const { recordQuery, getContextHint } = require('./routes/user-context');
const { ingestXML, pollXML, pollStatus, pollFromUrl } = require('./routes/xml-ingest');
const { prefetchTTS, serveCache, cacheStatus, clearAudioCache, runPrefetchBackground } = require('./routes/tts-prefetch');
const { getCacheStatus: geminiCacheStatus, getCacheId, clearCache: clearGeminiCache, refreshCache: refreshGeminiCache } = require('./routes/gemini-cache');
const { getChips, clearChips } = require('./routes/chips');
const { generateDigest, getDigest, clearDigest } = require('./routes/digest');
const { trackEvent, getSummary: getAnalyticsSummary, clearAnalytics } = require('./routes/analytics');
const { aiProxy, clearResponseCache, aiRateLimiter } = require('./routes/ai');
const { downloadLogs, logStats } = require('./store/queryLogger');
const { doScrape, scrapeSakshi } = require('./routes/scrape-sakshi');
const { isSafeUrl } = require('./utils/safeUrl');
const {
  globalCircuitBreaker,
  ipBlocklistMiddleware,
  rateLimiter,
  burstLimiter,
  ttsLimiter,
  scrapeLimiter,
  uaFilter,
  requestTimeout,
} = require('./middleware/rate-limiter');
const { loadFromFile: loadArticles, saveToFile: saveArticles, clearFile: clearArticleCache, getAllArticles: getStoreArticles } = require('./store/articleStore');

// ── Article disk cache path ───────────────────────────────────────────────────
// Articles are in-memory only during a run. This cache lets them survive restarts.
// The file is written after every auto-poll and every 5 minutes. Cleared at midnight.
const ARTICLE_CACHE_PATH = path.join(__dirname, '.cache', 'articles.json');

// Load from disk immediately so the store is warm before the first request arrives.
(function bootstrapArticleCache() {
  try {
    const n = loadArticles(ARTICLE_CACHE_PATH);
    if (n > 0) {
      console.log(`[NewsAI] 📂 Restored ${n} articles from disk — store ready`);
    }
  } catch (err) {
    console.warn('[NewsAI] Disk cache bootstrap failed:', err.message);
  }
})();

// Last successful scrape timestamp — exposed by /health for monitoring.
// Only set when at least one new article was ingested (not on 0-article runs).
let lastScrapeAt     = null;
let lastDigestAt     = 0;    // epoch ms — throttle digest to at most once/hour
const DIGEST_MIN_INTERVAL = 60 * 60 * 1000;  // 1 hour

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Trust reverse-proxy headers (needed for correct req.ip behind Nginx/Caddy) ──
// Without this, rate limiter sees the proxy's IP for all clients.
app.set('trust proxy', 1);

// ── Security headers ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.set('X-DNS-Prefetch-Control', 'off');
  // Note: frame-ancestors 'none' is fine here (backend API, not a UI host).
  res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
  next();
});

// ── CORS ───────────────────────────────────────────────────────────────────
// Dev: ALLOWED_ORIGINS unset → allow all origins (easiest local testing).
// Production: set ALLOWED_ORIGINS=https://www.sakshi.com,https://sakshi.com
// in the server's .env so only the newspaper domain can call the backend.
// The widget embed snippet runs in readers' browsers on sakshi.com, so its
// origin is always sakshi.com — restricting here prevents misuse from other sites.
const _allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : null;

app.use(cors({
  origin: _allowedOrigins
    ? (origin, cb) => {
        // Allow requests with no origin (server-to-server, Postman, extension)
        if (!origin || _allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`CORS: origin ${origin} not allowed`));
      }
    : '*',
  methods: ['GET', 'POST', 'DELETE'],
  credentials: false,
}));

// ── DDoS / abuse protection — layered, outermost first ───────────────────────
// IMPORTANT: these must run BEFORE express.json() so that blocked IPs / burst
// violators are rejected before the server buffers and parses their request body.
// Reordering these below body parsers would let attackers make the server allocate
// up to 10 MB of RAM per request even after being blocked.
//
// Layer 1: global circuit breaker (server-wide cap — stops distributed floods)
app.use('/api', globalCircuitBreaker);
// Layer 2: IP blocklist (blocked IPs get 403 immediately)
app.use('/api', ipBlocklistMiddleware);
// Layer 3: UA filter (blocks obvious automation scripts on user-facing endpoints)
app.use('/api', uaFilter);
// Layer 4: burst limiter (60 req/min per IP — catches single-IP floods)
app.use('/api', burstLimiter);
// Layer 5: hourly limiter (300 req/hr per IP — baseline budget)
app.use('/api', rateLimiter);
// Layer 6: request timeout (30 s default — prevents slow-loris / runaway handlers)
app.use('/api', requestTimeout(30000));

// Tight body-size caps per route category — registered AFTER the protection stack
// so rejected requests never have their body buffered.
// Routes that genuinely need large bodies (PDF, bulk ingest) keep them higher.
app.use('/api/ai',           express.json({ limit: '32kb' }));   // messages + sessionId only
app.use('/api/tts',          express.json({ limit: '16kb' }));   // text + lang
app.use('/api/query',        express.json({ limit: '16kb' }));
app.use('/api/analytics',    express.json({ limit: '4kb' }));
app.use('/api/ingest-today', express.json({ limit: '2mb' }));    // full article array
app.use('/api/ingest-pdf',   express.json({ limit: '10mb' }));   // PDF URL can be long
app.use('/api',              express.json({ limit: '256kb' }));   // catch-all for everything else
app.use(express.urlencoded({ extended: true, limit: '16kb' }));

// ── Admin token guard — protects destructive/management endpoints ─────────
// Set ADMIN_SECRET env var in production.
// IMPORTANT: fails CLOSED if ADMIN_SECRET is unset — use NODE_ENV=development
// explicitly to open admin access during local dev.
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    // Fail closed in production; open only when NODE_ENV=development is set explicitly
    if (process.env.NODE_ENV === 'development') return next();
    return res.status(503).json({
      error: 'Admin endpoint disabled — set ADMIN_SECRET in backend/.env to enable',
    });
  }
  // Reject ?adminToken= query params — they appear verbatim in server access logs.
  // Secrets must travel in the X-Admin-Token request header only.
  if (req.query.adminToken) {
    return res.status(400).json({
      error: 'Pass the admin token in the X-Admin-Token header, not in the URL',
    });
  }
  const token = req.headers['x-admin-token'];
  // Constant-time comparison prevents timing attacks on the token
  const secretBuf = Buffer.from(secret);
  const tokenBuf  = Buffer.from(String(token || ''));
  const safe = secretBuf.length === tokenBuf.length &&
    require('crypto').timingSafeEqual(secretBuf, tokenBuf);
  if (!safe) {
    return res.status(401).json({ error: 'Unauthorized — X-Admin-Token header required' });
  }
  next();
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const articles = getStoreArticles();
  res.json({
    status:           'ok',
    service:          'NewsAI Backend',
    version:          '1.0.0',
    articles:         articles.length,
    cacheActive:      getCacheId() !== null,
    lastScrapeAt:     lastScrapeAt ? new Date(lastScrapeAt).toISOString() : null,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    sarvamConfigured: !!process.env.SARVAM_API_KEY,
    hfConfigured:     !!process.env.HF_API_KEY,
  });
});

/**
 * GET /api/healthz
 * Machine-readable liveness probe — returns 200 only when the system is
 * genuinely ready to serve readers:
 *   • articleCount > 0 (articles loaded)
 *   • last scrape < 4 hours ago (data is fresh)
 * Returns 503 otherwise, so uptime monitors and health-monitor.sh can alert.
 */
app.get('/api/healthz', (req, res) => {
  const articles    = getStoreArticles();
  const articleCount = articles.length;
  const scrapeAge   = lastScrapeAt ? Date.now() - lastScrapeAt : Infinity;
  const scrapeStale = scrapeAge > 4 * 3600 * 1000;

  const ok = articleCount > 0 && !scrapeStale;
  const payload = {
    ok,
    articleCount,
    lastScrapeAt:  lastScrapeAt ? new Date(lastScrapeAt).toISOString() : null,
    scrapeAgeMin:  lastScrapeAt ? Math.round(scrapeAge / 60000) : null,
    reason: ok ? null
      : articleCount === 0  ? 'no_articles'
      : scrapeStale         ? 'scrape_stale'
      : 'unknown',
  };
  res.status(ok ? 200 : 503).json(payload);
});

// ── Security stats (admin-protected) ─────────────────────────────────────────
const { getStats: getRateLimitStats, blockIp, unblockIp } = require('./middleware/rate-limiter');
app.get('/api/security/stats',    requireAdmin, (req, res) => res.json(getRateLimitStats()));
app.post('/api/security/block',   requireAdmin, (req, res) => {
  const { ip, hours = 24, reason = 'manual' } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  blockIp(ip, hours * 3600 * 1000, reason);
  res.json({ ok: true, ip, hours });
});
app.post('/api/security/unblock', requireAdmin, (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  unblockIp(ip);
  res.json({ ok: true, ip });
});

// ── Routes ──────────────────────────────────────────────────────────────────
/**
 * POST /api/ingest-pdf
 * Body: { pdfUrl: "https://..." }
 * Returns structured articles extracted from the PDF.
 */
app.post('/api/ingest-pdf', ingestPdf);

/**
 * GET /api/scrape?url=https://newspaper.com
 * Returns headlines and summaries scraped from the newspaper homepage.
 */
app.get('/api/scrape', scrape);

/**
 * POST /api/scrape-sakshi
 * Fetches sakshi.com homepage + section pages, parses articles, ingests into store.
 * Returns { ok, scraped, ingested, skipped, sections, total, elapsed }
 * No body required. Auto-saves to disk on success.
 */
app.post('/api/scrape-sakshi', scrapeLimiter, (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400) setImmediate(() => {
      try { saveArticles(ARTICLE_CACHE_PATH); } catch (_) {}
      runPostScrapePipeline('manual-scrape');
    });
  });
  return scrapeSakshi(req, res, next);
});

/**
 * POST /api/tts
 * Body: { text: string, lang: "te" | "en", voice?: string }
 * Returns MP3 audio stream using Microsoft Edge TTS neural voices.
 * Requires: pip install edge-tts
 */
app.post('/api/tts',               ttsLimiter, tts);
app.post('/api/tts/stream',        ttsLimiter, ttsStream);         // SSE — base64 WAV chunks
app.post('/api/tts/stream-binary', ttsLimiter, ttsBinaryStream);   // raw PCM binary stream (AudioWorklet)

/**
 * POST /api/ingest           — add one article to today's edition
 * GET  /api/articles/today   — list all today's articles + stats
 * DELETE /api/articles/reset — clear today's edition
 * POST /api/articles/sample  — load sample Sakshi articles for demo
 */
app.post('/api/ingest',                      ingestArticle);
app.get('/api/articles/today',              getToday);
app.get('/api/articles/breaking-count',     getBreakingCount);  // lightweight widget freshness check
app.delete('/api/articles/reset', requireAdmin, resetToday);  // destructive — admin token in prod
app.post('/api/articles/sample',  requireAdmin, loadSample);  // management — admin token in prod

/**
 * POST /api/query
 * Body: { question: string, topN?: number }
 * Returns the top N most relevant articles for the question (keyword-scored).
 * Widget uses this to send focused context instead of all articles.
 */
app.post('/api/query', queryArticles);

/**
 * POST /api/embed        — batch-embed all articles via HuggingFace (background)
 * GET  /api/embed/status — embedding coverage stats
 * Called by newsai-content.js after articles are ingested.
 * Uses: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 (free, Telugu-aware)
 */
app.post('/api/embed',        embedArticles);
app.get('/api/embed/status',  embedStatus);

/**
 * POST /api/translate        — translate one text block to Telugu
 * POST /api/translate/batch  — translate content field of multiple articles
 * Uses Meta NLLB-200 via HuggingFace free Inference API (no billing required).
 * Set HF_API_KEY env var for faster warm starts.
 */
app.post('/api/translate',       translate);
app.post('/api/translate/batch', translateBatch);

/**
 * POST /api/ingest-today
 * Body: { articles: [...] }   — full scraped array from newsai-content.js
 * Fetches complete body text for ALL articles in parallel, saves to disk.
 * Idempotent: skips if today's briefing already exists. Use ?force=1 to re-ingest.
 *
 * GET /api/briefing/status — check if today's briefing is ready
 */
app.post('/api/ingest-today',    ingestToday);
app.get('/api/briefing/status',  briefingStatus);

/**
 * POST /api/chat
 * Body: { question: string }
 * Returns { context, section, source, articleCount, total, date }
 * context is null when no briefing exists → widget falls back to DOM content.
 *
 * GET /api/chat/sections — list available sections in today's briefing
 */
app.post('/api/chat',          chat);
app.get('/api/chat/sections',  listSections);

/**
 * POST /api/ingest-xml       — parse XML string (Sakshi CMS, RSS, Atom) and ingest articles
 * POST /api/poll-xml         — fetch XML from a remote URL + optional auto-poll schedule
 * GET  /api/poll-xml/status  — last poll time and article count
 */
// Wrap ingest-xml and poll-xml to auto-save after every successful ingest.
// res.on('finish') fires after the response is sent — non-blocking, doesn't slow the client.
app.post('/api/ingest-xml', (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400) setImmediate(() => {
      try { saveArticles(ARTICLE_CACHE_PATH); } catch (_) {}
      runPostScrapePipeline('xml-ingest');
    });
  });
  return ingestXML(req, res, next);
});
app.post('/api/poll-xml', (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400) setImmediate(() => {
      try { saveArticles(ARTICLE_CACHE_PATH); } catch (_) {}
      runPostScrapePipeline('xml-poll');
    });
  });
  return pollXML(req, res, next);
});
app.get('/api/poll-xml/status', pollStatus);

/**
 * POST /api/tts/prefetch      — pre-generate TTS audio for all articles (background, fire-and-forget)
 * GET  /api/tts/cache/status  — cache coverage (cached / total / %)
 * GET  /api/tts/cache/:id     — serve cached MP3 audio for article ID (zero-latency playback)
 */
app.post('/api/tts/prefetch',    prefetchTTS);
app.get('/api/tts/cache/status', cacheStatus);
app.get('/api/tts/cache/:id',    serveCache);

/**
 * POST /api/ai
 * Body: { messages: [{role,content}], lang: "te"|"en", sessionId: string }
 * Server-side AI proxy — keeps the Gemini key off the browser and streams the
 * response back as SSE. Guarded by the stricter aiRateLimiter (30/min/IP).
 */
app.post('/api/ai', aiRateLimiter, aiProxy);

/**
 * GET /api/gemini-cache — active Gemini context cache ID (widget fetches at open)
 */
app.get('/api/gemini-cache', geminiCacheStatus);

/**
 * GET /api/chips — dynamic suggestion chips built from today's articles
 */
app.get('/api/chips', getChips);

/**
 * GET /api/digest — pre-generated Telugu + English daily digest
 */
app.get('/api/digest', getDigest);

/**
 * POST /api/analytics       — log an event (open, query, tts, lang_switch, article_click)
 * GET  /api/analytics/summary — aggregated stats (admin-protected)
 */
app.post('/api/analytics',         trackEvent);
app.get('/api/analytics/summary',  requireAdmin, getAnalyticsSummary);

/**
 * GET /api/admin/logs/download — download full query+response log as CSV
 * GET /api/admin/logs/stats    — aggregated stats: total, by-lang, avg latency, top queries
 * Both endpoints require the admin token in the X-Admin-Token request header.
 * Do NOT pass the token as a ?adminToken= query param — it appears in access logs.
 */
app.get('/api/admin/logs/download', requireAdmin, downloadLogs);
app.get('/api/admin/logs/stats',    requireAdmin, logStats);

/**
 * GET /portal — serve the ingestion portal UI
 */
app.use('/portal', express.static(path.join(__dirname, '..', 'portal')));

/**
 * GET /widget/* — serve widget JS/CSS files so the demo page can load them.
 * Enables single-deployment: backend serves both the API and the widget assets.
 */
app.use('/widget', express.static(path.join(__dirname, '..', 'widget')));

/**
 * GET /configs/* — serve client config JSON files (sakshi.json, eenadu.json…).
 * Newspaper web teams point their embed snippet configUrl here:
 *   window.NewsAIConfig = { configUrl: 'https://ai-api.sakshi.com/configs/sakshi.json' };
 */
app.use('/configs', express.static(path.join(__dirname, '..', 'configs')));

/**
 * GET /demo — serve the widget demo/test page (works on mobile browser too).
 * Alias: GET / also serves it so the root URL is usable.
 */
const demoPath = path.join(__dirname, '..', 'test.html');
app.get('/demo', (req, res) => res.sendFile(demoPath));
app.get('/', (req, res) => res.sendFile(demoPath));

/**
 * GET /demo-sakshi — Sakshi-branded demo page for handoff to Sakshi's web team.
 * GET /app         — Mobile WebView page for Sakshi's Android/iOS app.
 */
app.get('/demo-sakshi', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'test-sakshi.html')));
app.get('/app', (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'sakshi-webview.html')));

/**
 * GET /api/rss?url=https://newspaper.com/rss.xml
 * Server-side RSS proxy — avoids CORS issues on the browser side.
 * isSafeUrl() now lives in utils/safeUrl.js so scrape-sakshi.js can share it.
 */
app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });
  if (!isSafeUrl(url)) return res.status(400).json({ error: 'Invalid or unsafe URL' });

  try {
    // Use global fetch (Node 18+) — removed node-fetch dependency
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    // Cap at 5 MB to prevent memory exhaustion
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 5 * 1024 * 1024) throw new Error('RSS feed exceeds 5 MB limit');
    const xml = Buffer.from(buf).toString('utf8');
    res.set('Content-Type', 'application/xml').send(xml);
  } catch (err) {
    res.status(502).json({ error: `RSS fetch failed: ${err.message}` });
  }
});

// ── Global error handler ─────────────────────────────────────────────────────
// Log full error server-side but NEVER echo stack traces or upstream URLs to client.
app.use((err, req, res, _next) => {
  console.error('[NewsAI Backend Error]', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Midnight IST article store reset ─────────────────────────────────────────
// Clears yesterday's articles so today's XML/scrape poll starts fresh each day.
// IST = UTC+5:30. Runs once at midnight and re-schedules itself for the next night.
function scheduleMidnightReset() {
  const nowUtc   = Date.now();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst   = new Date(nowUtc + IST_OFFSET_MS);
  // Next midnight IST — nowIst's UTC fields represent the IST wall clock, so we
  // must use setUTCHours here. setHours() would apply the SERVER's local timezone,
  // firing the reset at the wrong time on any non-UTC server (e.g. ~18:30 IST on an IST box).
  const midIst   = new Date(nowIst);
  midIst.setUTCHours(24, 0, 5, 0); // 00:00:05 IST next day (5s buffer)
  const msLeft   = midIst - nowIst;

  setTimeout(() => {
    try {
      // Clear article store (main data)
      const { resetArticles } = require('./store/articleStore');
      if (typeof resetArticles === 'function') resetArticles();

      // Clear audio cache — so stale article IDs don't serve yesterday's audio
      clearAudioCache();

      // Clear query response cache — yesterday's answers are invalid for today's articles
      clearQueryCache();
      clearResponseCache();  // ai.js 5-min response cache

      // Clear new daily caches
      clearGeminiCache();
      clearChips();
      clearDigest();
      clearAnalytics();  // logs a midnight_reset event, doesn't wipe analytics
      lastDigestAt = 0;  // allow immediate digest on first morning scrape

      // Remove stale disk cache so tomorrow's auto-poll starts fresh.
      try { clearArticleCache(ARTICLE_CACHE_PATH); } catch (_) {}

      console.log('[NewsAI] 🌙 Midnight IST — article store + audio + query + gemini + chips + digest + disk cache reset');
    } catch (err) {
      console.error('[NewsAI] Midnight reset failed:', err.message);
    } finally {
      scheduleMidnightReset(); // always reschedule, even if reset threw
    }
  }, msLeft).unref();

  const hh = Math.floor(msLeft / 3600000);
  const mm = Math.floor((msLeft % 3600000) / 60000);
  console.log(`[NewsAI] Midnight IST reset scheduled in ${hh}h ${mm}m`);
}
scheduleMidnightReset();

// ── Automatic Sakshi.com web scrape (default ON, every 2 hours) ──────────────
// Mirrors the Chrome extension's 3-phase DOM scraping but runs server-side.
// No config needed — starts automatically with the backend.
// Override interval: SAKSHI_SCRAPE_INTERVAL_HOURS=3 in backend/.env
// Disable entirely: SAKSHI_SCRAPE_DISABLED=true in backend/.env
const SAKSHI_SCRAPE_DISABLED = process.env.SAKSHI_SCRAPE_DISABLED === 'true';
const SAKSHI_SCRAPE_INTERVAL = parseFloat(process.env.SAKSHI_SCRAPE_INTERVAL_HOURS || '2') * 60 * 60 * 1000;

// ── Post-scrape pipeline — called after every successful scrape ───────────────
// Runs in fire-and-forget order: Gemini cache → digest → embeddings → TTS prefetch.
// Each step is independent; failures are logged but don't block the others.
// ingestedCount: number of NEW articles added by this scrape (0 = dupe-only run).
function runPostScrapePipeline(label, ingestedCount = 1) {
  // Only advance the scrape timestamp when we actually got new articles.
  // A 0-ingest run (all dupes) shouldn't reset the "last successful scrape" clock.
  if (ingestedCount > 0) lastScrapeAt = Date.now();

  const articles = getStoreArticles();
  if (articles.length === 0) {
    console.warn(`[NewsAI] Pipeline skipped (${label}) — store is empty, nothing to cache/digest`);
    return;
  }

  setImmediate(() => {
    // Gemini cache: only run when AI_PROVIDER=gemini — OpenAI never uses cachedContent
    if ((process.env.AI_PROVIDER || 'gemini') !== 'openai') {
      refreshGeminiCache()
        .catch(err => console.warn(`[NewsAI] Gemini cache refresh failed (${label}):`, err.message));
    }

    // Digest: throttle to at most once/hour to avoid burning Gemini quota on every 30-min scrape
    const now = Date.now();
    if (now - lastDigestAt >= DIGEST_MIN_INTERVAL) {
      lastDigestAt = now;
      generateDigest(articles)
        .catch(err => console.warn(`[NewsAI] Digest generation failed (${label}):`, err.message));
    } else {
      const minLeft = Math.ceil((DIGEST_MIN_INTERVAL - (now - lastDigestAt)) / 60000);
      console.log(`[NewsAI] Digest skipped (${label}) — throttled, next in ~${minLeft}min`);
    }

    runEmbeddingBackground(process.env.HF_API_KEY || null)
      .catch(err => console.warn(`[NewsAI] Embedding failed (${label}):`, err.message));
    // TTS prefetch disabled: Sarvam free credits exhausted. Re-enable when replenished.
    // runPrefetchBackground()
    //   .catch(err => console.warn(`[NewsAI] TTS prefetch failed (${label}):`, err.message));
  });
}

if (!SAKSHI_SCRAPE_DISABLED) {
  // Peak publishing windows (IST): morning 6–10 AM, evening 5–7 PM → 30-min scrapes.
  // Off-peak: SAKSHI_SCRAPE_INTERVAL (default 2h, configurable via env).
  const PEAK_INTERVAL_MS = 30 * 60 * 1000;   // 30 minutes during peak hours

  // First scrape: 10 seconds after startup (lets the server finish booting first)
  setTimeout(async () => {
    try {
      console.log('[NewsAI] 🌐 Startup scrape — fetching sakshi.com…');
      const result = await doScrape();
      console.log(`[NewsAI] 🌐 Startup scrape done: ${result.ingested} new, ${result.skipped} dupes, ${result.elapsed}`);
      saveArticles(ARTICLE_CACHE_PATH);
      runPostScrapePipeline('startup', result.ingested);
    } catch (err) {
      const existing = getStoreArticles().length;
      const ageMin   = lastScrapeAt ? Math.round((Date.now() - lastScrapeAt) / 60000) : null;
      const stale    = existing > 0 && ageMin !== null ? ` (${existing} stale articles from ${ageMin}m ago still serving)` : '';
      console.warn(`[NewsAI] Startup scrape failed: ${err.message}${stale}`);
    }
  }, 10 * 1000).unref();

  // IST-aware recurring scrape — self-rescheduling setTimeout loop.
  // Computes next interval at schedule time so peak/off-peak hours are always current.
  function scheduleRecurringScrape() {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIst   = new Date(Date.now() + IST_OFFSET_MS);
    const istHour  = nowIst.getUTCHours();  // UTC + offset = IST wall clock hour
    const isPeak   = (istHour >= 6 && istHour < 10) || (istHour >= 17 && istHour < 19);
    const intervalMs = isPeak ? PEAK_INTERVAL_MS : SAKSHI_SCRAPE_INTERVAL;
    const mins     = Math.round(intervalMs / 60000);

    console.log(`[NewsAI] Next scrape in ${mins}min (IST ${istHour}h, ${isPeak ? '🔥 peak' : 'off-peak'})`);

    setTimeout(async () => {
      // Recompute IST hour at actual fire time for accurate logging
      const fireIst  = new Date(Date.now() + IST_OFFSET_MS);
      const fireHour = fireIst.getUTCHours();
      const peakTag  = ((fireHour >= 6 && fireHour < 10) || (fireHour >= 17 && fireHour < 19))
        ? '🔥 peak' : 'off-peak';
      try {
        console.log(`[NewsAI] 🌐 Scheduled scrape (IST ${fireHour}h, ${peakTag}) — fetching sakshi.com…`);
        const result = await doScrape();
        console.log(`[NewsAI] 🌐 Scheduled scrape done: ${result.ingested} new, ${result.skipped} dupes, ${result.elapsed}`);
        saveArticles(ARTICLE_CACHE_PATH);
        runPostScrapePipeline('scheduled', result.ingested);
      } catch (err) {
        const existing = getStoreArticles().length;
        const ageMin   = lastScrapeAt ? Math.round((Date.now() - lastScrapeAt) / 60000) : null;
        const stale    = existing > 0 && ageMin !== null ? ` (${existing} stale articles from ${ageMin}m ago still serving)` : '';
        console.warn(`[NewsAI] Scheduled scrape failed: ${err.message}${stale}`);
      } finally {
        scheduleRecurringScrape();  // always reschedule, even after failure
      }
    }, intervalMs).unref();
  }
  scheduleRecurringScrape();

  console.log('[NewsAI] Auto-scrape: sakshi.com — 30min during 6-10 AM / 5-7 PM IST, otherwise every', (SAKSHI_SCRAPE_INTERVAL / 3600000).toFixed(1), 'h');
} else {
  console.log('[NewsAI] Auto-scrape disabled — set SAKSHI_SCRAPE_DISABLED=false to enable');
}

// ── Background XML refresh (optional, for Sakshi RSS feeds) ─────────────────
// Set XML_POLL_URL in backend/.env to enable.
// Example: XML_POLL_URL=https://feeds.sakshi.com/rss/telangana.xml
const XML_POLL_URL      = process.env.XML_POLL_URL || null;
const XML_POLL_INTERVAL = parseInt(process.env.XML_POLL_INTERVAL_MIN || '30', 10) * 60 * 1000;

if (XML_POLL_URL) {
  (async () => {
    try {
      const { parsed, ingested } = await pollFromUrl(XML_POLL_URL);
      console.log(`[NewsAI] 🔄 Startup XML poll: parsed=${parsed}, new=${ingested}`);
      saveArticles(ARTICLE_CACHE_PATH);
    } catch (err) {
      console.warn('[NewsAI] Startup XML poll failed:', err.message);
    }
  })();

  setInterval(async () => {
    try {
      const { parsed, ingested } = await pollFromUrl(XML_POLL_URL);
      console.log(`[NewsAI] 🔄 XML auto-refresh: parsed=${parsed}, new=${ingested} | ${XML_POLL_URL}`);
      saveArticles(ARTICLE_CACHE_PATH);
    } catch (err) {
      console.warn('[NewsAI] XML auto-refresh failed:', err.message);
    }
  }, XML_POLL_INTERVAL).unref();
  console.log(`[NewsAI] XML auto-refresh every ${XML_POLL_INTERVAL / 60000} min from ${XML_POLL_URL}`);
}

// Periodic disk save — covers manual /api/ingest-xml and /api/ingest calls too.
// Runs every 5 minutes; lightweight (just writes JSON of the in-memory array).
setInterval(() => {
  try { saveArticles(ARTICLE_CACHE_PATH); } catch (_) {}
}, 5 * 60 * 1000).unref();

// ── Global crash guards — prevent silent process death ───────────────────────
process.on('uncaughtException',  (err) => console.error('[NewsAI] Uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[NewsAI] Unhandled rejection:', err));

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NewsAI backend running on http://localhost:${PORT}`);

  // ── Startup configuration audit ───────────────────────────────────────────
  const geminiOk = !!process.env.GEMINI_API_KEY;
  const sarvamOk = !!process.env.SARVAM_API_KEY;
  const hfOk     = !!process.env.HF_API_KEY;
  console.log(`[NewsAI] Config: Gemini=${geminiOk ? '✅' : '❌ MISSING'} | Sarvam TTS=${sarvamOk ? '✅' : '⚠️  no voice'} | HuggingFace embeddings=${hfOk ? '✅' : '⚠️  no HF_API_KEY (keyword search only)'}`);
  if (!hfOk) {
    console.log('[NewsAI] 💡 To enable semantic search: add HF_API_KEY=hf_xxx to backend/.env');
    console.log('[NewsAI]    Get a free token at https://huggingface.co/settings/tokens');
  }

  console.log('Routes:');
  console.log('  POST /api/ingest-pdf  — PDF text extraction');
  console.log('  GET  /api/scrape      — Web scraping proxy');
  console.log('  GET  /api/rss         — RSS CORS proxy');
  console.log('  POST /api/tts         — Sarvam Bulbul v3 TTS (set SARVAM_API_KEY in .env)');
  console.log('  POST /api/ingest      — Add article to today\'s edition');
  console.log('  GET  /api/articles/today — List today\'s articles');
  console.log('  POST /api/query       — RAG: keyword + HuggingFace semantic search');
  console.log('  POST /api/ai          — Server-side AI proxy (SSE stream, key stays on server)');
  console.log('  POST /api/embed       — batch-embed articles via HF (background)');
  console.log('  GET  /api/embed/status — embedding coverage stats');
  console.log('  POST /api/ingest-today   — Ingest full article set with body text (once/day)');
  console.log('  GET  /api/briefing/status — Check if today\'s briefing is ready');
  console.log('  POST /api/chat        — Get context string for a user question');
  console.log('  GET  /api/chat/sections — List available sections in today\'s briefing');
  console.log('  POST /api/scrape-sakshi — Live web scrape of sakshi.com (auto-runs every 2h)');
  console.log('  POST /api/ingest-xml  — Parse XML (Sakshi CMS/RSS/Atom) and ingest articles');
  console.log('  POST /api/poll-xml    — Fetch + auto-poll XML from remote URL');
  console.log('  POST /api/tts/prefetch — Pre-generate TTS audio for all articles (background)');
  console.log('  GET  /api/tts/cache/:id — Serve cached TTS audio (zero-latency playback)');
  console.log('  GET  /portal          — Content ingestion portal UI');
});

module.exports = app;
