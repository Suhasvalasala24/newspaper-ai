'use strict';

// Load .env before any other require so process.env is populated
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path          = require('path');
const { ingestPdf } = require('./routes/ingest-pdf');
const { scrape }    = require('./routes/scrape');
const { tts }       = require('./routes/tts');
const { ingestArticle, getToday, resetToday, loadSample } = require('./routes/ingest');
const { queryArticles, clearQueryCache } = require('./routes/query');
const { embedArticles, embedStatus } = require('./routes/embed');
const { translate, translateBatch } = require('./routes/translate');
const { ingestToday, briefingStatus } = require('./routes/ingest-today');
const { chat, listSections }          = require('./routes/chat');
const { ingestXML, pollXML, pollStatus } = require('./routes/xml-ingest');
const { prefetchTTS, serveCache, cacheStatus, clearAudioCache } = require('./routes/tts-prefetch');
const { getCacheStatus: geminiCacheStatus, clearCache: clearGeminiCache } = require('./routes/gemini-cache');
const { getChips, clearChips } = require('./routes/chips');
const { getDigest, clearDigest } = require('./routes/digest');
const { trackEvent, getSummary: getAnalyticsSummary, clearAnalytics } = require('./routes/analytics');
const { rateLimiter } = require('./middleware/rate-limiter');

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
  // Only allow embedding on the newspaper's own domain (loosened when needed via config)
  res.set('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
  next();
});

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*', // Widget embeds on any newspaper domain — CORS must stay open
  methods: ['GET', 'POST', 'DELETE'], // DELETE needed for /api/articles/reset
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate limiting — 60 req/hr per IP on all /api routes ──────────────────
app.use('/api', rateLimiter);

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
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  // Constant-time comparison prevents timing attacks on the token
  const secretBuf = Buffer.from(secret);
  const tokenBuf  = Buffer.from(String(token || ''));
  const safe = secretBuf.length === tokenBuf.length &&
    require('crypto').timingSafeEqual(secretBuf, tokenBuf);
  if (!safe) {
    return res.status(401).json({ error: 'Unauthorized — admin token required' });
  }
  next();
}

// ── Health check (only for API clients that send Accept: application/json) ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'NewsAI Backend', version: '1.0.0' });
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
 * POST /api/tts
 * Body: { text: string, lang: "te" | "en", voice?: string }
 * Returns MP3 audio stream using Microsoft Edge TTS neural voices.
 * Requires: pip install edge-tts
 */
app.post('/api/tts', tts);

/**
 * POST /api/ingest           — add one article to today's edition
 * GET  /api/articles/today   — list all today's articles + stats
 * DELETE /api/articles/reset — clear today's edition
 * POST /api/articles/sample  — load sample Sakshi articles for demo
 */
app.post('/api/ingest',                     ingestArticle);
app.get('/api/articles/today',             getToday);
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
app.post('/api/ingest-xml',     ingestXML);
app.post('/api/poll-xml',       pollXML);
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
 * GET /portal — serve the ingestion portal UI
 */
app.use('/portal', express.static(path.join(__dirname, '..', 'portal')));

/**
 * GET /widget/* — serve widget JS/CSS files so the demo page can load them.
 * Enables single-deployment: backend serves both the API and the widget assets.
 */
app.use('/widget', express.static(path.join(__dirname, '..', 'widget')));

/**
 * GET /demo — serve the widget demo/test page (works on mobile browser too).
 * Alias: GET / also serves it so the root URL is usable.
 */
const demoPath = path.join(__dirname, '..', 'test.html');
app.get('/demo', (req, res) => res.sendFile(demoPath));
app.get('/', (req, res) => res.sendFile(demoPath));

/**
 * GET /api/rss?url=https://newspaper.com/rss.xml
 * Server-side RSS proxy — avoids CORS issues on the browser side.
 */
function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (h === '169.254.169.254' || h === 'metadata.google.internal') return false;
    if (/^10\./.test(h) || /^192\.168\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h.endsWith('.internal') || h.endsWith('.local')) return false;
    return true;
  } catch (_) { return false; }
}

app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });
  if (!isSafeUrl(url)) return res.status(400).json({ error: 'Invalid or unsafe URL' });

  try {
    const fetch = require('node-fetch');
    // Cap response at 5 MB to prevent memory exhaustion
    const resp  = await fetch(url, { timeout: 10000, size: 5 * 1024 * 1024 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
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

      // Clear new daily caches
      clearGeminiCache();
      clearChips();
      clearDigest();
      clearAnalytics();  // logs a midnight_reset event, doesn't wipe analytics

      console.log('[NewsAI] 🌙 Midnight IST — article store + audio + query + gemini + chips + digest reset');
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

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NewsAI backend running on http://localhost:${PORT}`);
  console.log('Routes:');
  console.log('  POST /api/ingest-pdf  — PDF text extraction');
  console.log('  GET  /api/scrape      — Web scraping proxy');
  console.log('  GET  /api/rss         — RSS CORS proxy');
  console.log('  POST /api/tts         — Sarvam Bulbul v3 TTS (set SARVAM_API_KEY in .env)');
  console.log('  POST /api/ingest      — Add article to today\'s edition');
  console.log('  GET  /api/articles/today — List today\'s articles');
  console.log('  POST /api/query       — RAG: keyword + HuggingFace semantic search');
  console.log('  POST /api/embed       — batch-embed articles via HF (background)');
  console.log('  GET  /api/embed/status — embedding coverage stats');
  console.log('  POST /api/ingest-today   — Ingest full article set with body text (once/day)');
  console.log('  GET  /api/briefing/status — Check if today\'s briefing is ready');
  console.log('  POST /api/chat        — Get context string for a user question');
  console.log('  GET  /api/chat/sections — List available sections in today\'s briefing');
  console.log('  POST /api/ingest-xml  — Parse XML (Sakshi CMS/RSS/Atom) and ingest articles');
  console.log('  POST /api/poll-xml    — Fetch + auto-poll XML from remote URL');
  console.log('  POST /api/tts/prefetch — Pre-generate TTS audio for all articles (background)');
  console.log('  GET  /api/tts/cache/:id — Serve cached TTS audio (zero-latency playback)');
  console.log('  GET  /portal          — Content ingestion portal UI');
});

module.exports = app;
