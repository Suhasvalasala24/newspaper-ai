'use strict';

/**
 * Gemini Context Caching — POST /v1beta/cachedContents
 *
 * After XML ingest, we POST all 200 articles as a cached content object.
 * Subsequent Gemini calls reference the cache ID — the system context is
 * NOT resent every time, saving ~90% of input token cost on cached tokens.
 *
 * Minimum: 32,768 tokens. If today's articles are below that, caching is
 * skipped silently and the widget falls back to full systemInstruction.
 *
 * GET /api/gemini-cache — widget polls this at open to get the active cacheId.
 */

const store = require('../store/articleStore');

const GEMINI_MODEL    = 'gemini-2.5-flash-lite';
const CACHE_TTL       = '86400s';   // 24 h — refreshed at midnight reset
const CACHE_TIMEOUT   = 15000;      // 15s hard cap on cache creation call

const SYSTEM_INSTRUCTION = `You are a Telugu newspaper AI assistant. You help readers understand, summarise, and navigate today's newspaper edition.

LANGUAGE RULES:
- If the user writes in Telugu, respond entirely in Telugu script.
- If the user writes in English, respond in clear simple English.
- Never mix languages in a single response unless quoting a proper noun.
- Do NOT translate proper nouns — politician names, city names, party names stay as-is.

CONTENT RULES:
- Answer ONLY from the articles provided in today's context.
- NEVER add facts, statistics, scores, or events from your training knowledge.
- If a topic is not in today's paper, say so clearly — never invent content.
- When summarising, be concise: 3–5 bullet points per section.
- When explaining complex news, use simple language and avoid jargon.
- When quoting article content, copy the exact words — never paraphrase inaccurately.
- NEVER fabricate quotes, statistics, player names, or results.

TONE: Warm, helpful, conversational. For Telugu, use everyday conversational Telugu, not overly formal.`;

// ── Module state ─────────────────────────────────────────────────────────────
let activeCacheId   = null;   // full resource name, e.g. "cachedContents/abc123"
let cacheExpiresAt  = 0;      // epoch ms
let cacheRefreshing = false;

// ── Build article context string ─────────────────────────────────────────────
function buildCacheContext(articles) {
  if (!articles || articles.length === 0) return '';
  let ctx = `TODAY'S NEWSPAPER EDITION — ${new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })}\n\nTotal articles: ${articles.length}\n\n`;

  for (const a of articles) {
    ctx += `[${a.section}] ${a.title}\n`;
    if (a.content && a.content.length > 30) {
      ctx += `${a.content.slice(0, 800)}\n`;
    }
    if (a.url) ctx += `URL: ${a.url}\n`;
    ctx += '\n';
  }
  return ctx;
}

// ── Create a Gemini cached content object ─────────────────────────────────────
async function createCache(articles) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[NewsAI Cache] GEMINI_API_KEY not set — skipping context caching');
    return;
  }

  const contextStr = buildCacheContext(articles);
  if (!contextStr) {
    console.warn('[NewsAI Cache] No articles to cache');
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${apiKey}`;
  const body = JSON.stringify({
    model: `models/${GEMINI_MODEL}`,
    systemInstruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: contextStr }],
      },
      {
        role: 'model',
        parts: [{ text: 'Understood. I have read all of today\'s articles and am ready to answer questions about them accurately.' }],
      },
    ],
    ttl: CACHE_TTL,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CACHE_TIMEOUT);

  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      // 400 with "tokens" in the error = below minimum token threshold — expected
      if (resp.status === 400 && errText.toLowerCase().includes('token')) {
        console.warn(`[NewsAI Cache] Context too small for Gemini caching (need ≥32,768 tokens). Using standard prompts. Articles: ${articles.length}`);
      } else {
        console.warn(`[NewsAI Cache] Cache creation failed ${resp.status}: ${errText.slice(0, 200)}`);
      }
      activeCacheId  = null;
      cacheExpiresAt = 0;
      return;
    }

    const data = await resp.json();
    activeCacheId  = data.name || null;
    cacheExpiresAt = Date.now() + 23 * 3600 * 1000; // expire before TTL to avoid stale ref
    console.log(`[NewsAI Cache] ✅ Gemini context cache created: ${activeCacheId} (${articles.length} articles)`);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[NewsAI Cache] Cache creation timed out after ${CACHE_TIMEOUT}ms`);
    } else {
      console.warn('[NewsAI Cache] Cache creation error:', err.message);
    }
    activeCacheId  = null;
    cacheExpiresAt = 0;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public: get active cache ID if still valid ────────────────────────────────
function getCacheId() {
  if (!activeCacheId) return null;
  if (Date.now() > cacheExpiresAt) {
    activeCacheId  = null;
    cacheExpiresAt = 0;
    return null;
  }
  return activeCacheId;
}

// ── Public: clear cache on midnight reset ─────────────────────────────────────
function clearCache() {
  activeCacheId  = null;
  cacheExpiresAt = 0;
}

// ── Public: refresh cache with current articles ───────────────────────────────
async function refreshCache() {
  if (cacheRefreshing) return;
  cacheRefreshing = true;
  try {
    const articles = store.getAllArticles();
    await createCache(articles);
  } finally {
    cacheRefreshing = false;
  }
}

// ── Route: GET /api/gemini-cache ──────────────────────────────────────────────
function getCacheStatus(req, res) {
  const id = getCacheId();
  res.json({
    cacheId:    id,
    expiresAt:  id ? cacheExpiresAt : null,
    active:     !!id,
  });
}

module.exports = { createCache, getCacheId, clearCache, refreshCache, getCacheStatus };
