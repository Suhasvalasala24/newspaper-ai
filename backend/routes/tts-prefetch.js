'use strict';

/**
 * TTS Pre-generation — generates audio for articles at ingest time.
 * Audio is cached in memory and served via GET /api/tts/cache/:id
 *
 * Zero-latency TTS: widget requests /api/tts/cache/:id at response time.
 * If audio is ready → serves immediately. If not → widget falls back to
 * Web Speech API (same as before).
 *
 * Uses Sarvam Bulbul v3 — same API as /api/tts route.
 * Requires SARVAM_API_KEY in backend/.env
 *
 * Routes:
 *   POST /api/tts/prefetch       — trigger background prefetch for all articles
 *   GET  /api/tts/cache/:id      — serve cached WAV audio for a specific article ID
 *   GET  /api/tts/cache/status   — cache coverage stats
 */

const store = require('../store/articleStore');
const { callSarvam, detectPace, preprocessForTTS, SPEAKER_MAP, LANG_CODE_MAP } = require('./tts');

// In-memory cache: articleId → { base64: string, mime: string }
// Capped at MAX_AUDIO_CACHE entries with LRU eviction to prevent OOM on long runs.
// 500 entries × ~250 KB average (500-char WAV base64) ≈ 125 MB worst-case.
// In practice entries are smaller and articles reset at midnight.
const audioCache      = new Map();
const MAX_AUDIO_CACHE = 500;
let   prefetchRunning = false;

// LRU eviction helper — removes the oldest (first inserted) entry
function evictOldestAudio() {
  const firstKey = audioCache.keys().next().value;
  if (firstKey !== undefined) audioCache.delete(firstKey);
}

// ── Simple Telugu script detector ─────────────────────────────────────────────
function detectLang(text) {
  return (text && (text.match(/[ఀ-౿]/g) || []).length > 2) ? 'te' : 'en';
}

// ── Generate audio for a single article snippet ───────────────────────────────
async function generateAudio(text, lang) {
  const speaker    = SPEAKER_MAP[lang]     || SPEAKER_MAP.te;
  const targetLang = LANG_CODE_MAP[lang]   || 'te-IN';
  // Expand abbreviations (IPL→ఐపీఎల్, CM→ముఖ్యమంత్రి) before chunking so Sarvam
  // hears the full form, not spelled-out letters. Same step used by /api/tts.
  const processed  = preprocessForTTS(text.slice(0, 600), targetLang);
  const snippet    = processed.slice(0, 500);   // cap at 500 chars for fast prefetch
  const pace       = detectPace(snippet);

  const wavBuf = await callSarvam(snippet, targetLang, speaker, pace);
  return wavBuf.toString('base64');        // store as base64 to keep cache uniform
}

// ── Internal: generate audio for all uncached articles ───────────────────────
/**
 * Does the actual background TTS prefetch work — no req/res needed.
 * Can be called directly by server.js after a scrape, or by prefetchTTS().
 * Uses prefetchRunning guard so concurrent calls are no-ops (not queued).
 */
async function runPrefetchBackground() {
  if (prefetchRunning) return;
  prefetchRunning = true;  // set synchronously before any await

  const allArticles = typeof store.getAllArticles === 'function'
    ? store.getAllArticles()
    : [];
  const pending = allArticles.filter(a => !audioCache.has(a.id));

  let generated = 0;
  try {
    for (const a of pending) {
      if (audioCache.has(a.id)) continue;
      const text = `${a.title || a.headline || ''}. ${(a.content || a.body || '').slice(0, 400)}`.trim();
      const lang = a.language || detectLang(a.title || a.headline || '');
      try {
        const base64 = await generateAudio(text, lang);
        if (audioCache.size >= MAX_AUDIO_CACHE) evictOldestAudio();
        audioCache.set(a.id, { base64, mime: 'audio/wav' });
        generated++;
      } catch (err) {
        // Sarvam not configured or article failed — silently skip
        console.warn(`[NewsAI TTS Prefetch] Skipped article ${a.id}: ${err.message}`);
      }
      // Small delay between articles to avoid hammering Sarvam rate limits
      await new Promise(r => setTimeout(r, 300));
    }
    if (pending.length > 0) {
      console.log(`[NewsAI TTS Prefetch] Done: ${generated}/${pending.length} articles cached`);
    }
  } finally {
    prefetchRunning = false;  // always release, even on unexpected throws
  }
}

// ── POST /api/tts/prefetch ────────────────────────────────────────────────────
// Fire-and-forget: responds immediately, runs background in runPrefetchBackground().
// DISABLED: Sarvam free credits exhausted — returns 503 until credits replenished.
async function prefetchTTS(req, res) {
  return res.status(503).json({
    message: 'TTS prefetch disabled: Sarvam credits exhausted. Re-enable when replenished.',
    cached:  audioCache.size,
  });
}

// ── GET /api/tts/cache/status ─────────────────────────────────────────────────
function cacheStatus(req, res) {
  const allArticles = typeof store.getAllArticles === 'function'
    ? store.getAllArticles()
    : [];
  res.json({
    cached:  audioCache.size,
    total:   allArticles.length,
    pct:     allArticles.length > 0
      ? Math.round((audioCache.size / allArticles.length) * 100)
      : 0,
    running: prefetchRunning,
  });
}

// ── GET /api/tts/cache/:id ────────────────────────────────────────────────────
// Serves cached WAV audio for an article.
function serveCache(req, res) {
  const raw = req.params.id;
  const id  = parseInt(raw, 10);
  if (!raw || isNaN(id) || id < 0 || String(id) !== String(raw)) {
    return res.status(400).json({ error: 'Invalid article ID' });
  }

  const cached = audioCache.get(id);
  if (!cached) {
    return res.status(404).json({
      error: 'Audio not cached yet',
      hint:  'POST /api/tts/prefetch to pre-generate, or use Web Speech API fallback',
    });
  }

  const buf = Buffer.from(cached.base64, 'base64');
  res.set('Content-Type',   cached.mime);
  res.set('Content-Length', String(buf.length));
  res.set('Cache-Control',  'public, max-age=86400');  // 24h browser cache
  res.send(buf);
}

// Clear all cached audio — called at IST midnight reset so stale article IDs
// don't serve yesterday's audio for today's (potentially reused) article IDs.
function clearAudioCache() {
  audioCache.clear();
  console.log('[NewsAI TTS Prefetch] Audio cache cleared for new edition');
}

module.exports = { prefetchTTS, serveCache, cacheStatus, audioCache, clearAudioCache, runPrefetchBackground };
