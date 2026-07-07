'use strict';

/**
 * TTS Pre-generation — generates audio for articles at ingest time.
 * Audio is cached in memory (base64) and served via GET /api/tts/cache/:id
 *
 * Zero-latency TTS: widget requests /api/tts/cache/:id at response time.
 * If audio is ready → serves immediately. If not → widget falls back to
 * Web Speech API (same as before).
 *
 * Uses edge-tts (Python) — same as /api/tts route.
 * Falls back gracefully if edge-tts is not installed.
 *
 * Routes:
 *   POST /api/tts/prefetch       — trigger background prefetch for all articles
 *   GET  /api/tts/cache/:id      — serve cached audio for a specific article ID
 *   GET  /api/tts/cache/status   — cache coverage stats
 */

const { execFile } = require('child_process');
const path         = require('path');
const os           = require('os');
const fs           = require('fs');
const store        = require('../store/articleStore');

// In-memory cache: articleId → { base64: string, mime: string }
const audioCache = new Map();
let prefetchRunning = false;

// Voice map — same as tts.js
const VOICE_MAP = {
  te: 'te-IN-ShrutiNeural',
  en: 'en-IN-NeerjaNeural',
};

async function generateAudio(text, lang) {
  const voice   = VOICE_MAP[lang] || VOICE_MAP.te;
  const tmpFile = path.join(os.tmpdir(), `newsai-pre-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);

  return new Promise((resolve, reject) => {
    execFile('edge-tts', [
      '--voice', voice,
      '--text',  text.slice(0, 500),  // cap at 500 chars for fast prefetch
      '--write-media', tmpFile,
    ], { timeout: 20000 }, (err) => {
      if (err) {
        // Clean up temp file on error (best-effort)
        fs.unlink(tmpFile, () => {});
        return reject(err);
      }
      try {
        const buf    = fs.readFileSync(tmpFile);
        const base64 = buf.toString('base64');
        fs.unlinkSync(tmpFile);
        resolve(base64);
      } catch (e) { reject(e); }
    });
  });
}

/**
 * POST /api/tts/prefetch
 * Fire-and-forget: responds immediately, generates audio in background.
 */
async function prefetchTTS(req, res) {
  const allArticles = typeof store.getAllArticles === 'function'
    ? store.getAllArticles()
    : [];
  const pending = allArticles.filter(a => !audioCache.has(a.id));

  res.json({
    message:  `TTS prefetch started for ${pending.length} articles`,
    pending:  pending.length,
    cached:   audioCache.size,
    total:    allArticles.length,
  });

  if (prefetchRunning) return;
  prefetchRunning = true;

  let generated = 0;
  for (const a of pending) {
    if (audioCache.has(a.id)) continue;  // may have been added by parallel request
    const text = `${a.title}. ${(a.content || '').slice(0, 400)}`.trim();
    const lang = a.language || detectLang(a.title);
    try {
      const base64 = await generateAudio(text, lang);
      audioCache.set(a.id, { base64, mime: 'audio/mpeg' });
      generated++;
    } catch (_) {
      // edge-tts not installed or failed — silently skip
    }
    // Small delay to avoid hammering the TTS binary
    await new Promise(r => setTimeout(r, 150));
  }

  prefetchRunning = false;
  console.log(`[NewsAI TTS Prefetch] Done: ${generated}/${pending.length} articles cached`);
}

/**
 * GET /api/tts/cache/status
 */
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

/**
 * GET /api/tts/cache/:id
 * Serves cached MP3 audio for an article.
 */
function serveCache(req, res) {
  const raw = req.params.id;
  const id  = parseInt(raw, 10);
  // Reject non-numeric or negative IDs to prevent unexpected map lookups
  if (!raw || isNaN(id) || id < 0 || String(id) !== String(raw)) {
    return res.status(400).json({ error: 'Invalid article ID' });
  }
  const cached = audioCache.get(id);
  if (!cached) {
    return res.status(404).json({
      error:  'Audio not cached yet',
      hint:   'POST /api/tts/prefetch to pre-generate, or use Web Speech API fallback',
    });
  }
  const buf = Buffer.from(cached.base64, 'base64');
  res.set('Content-Type',  cached.mime);
  res.set('Content-Length', buf.length);
  res.set('Cache-Control', 'public, max-age=86400');  // cache for 24h
  res.send(buf);
}

// Simple Telugu detector for prefetch language selection
function detectLang(text) {
  return (text && (text.match(/[ఀ-౿]/g) || []).length > 2) ? 'te' : 'en';
}

// Export the cache map so server.js can trigger prefetch after ingest
module.exports = { prefetchTTS, serveCache, cacheStatus, audioCache };
