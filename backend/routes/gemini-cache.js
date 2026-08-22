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

const GEMINI_MODEL    = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const CACHE_TTL       = '86400s';   // 24 h — refreshed at midnight reset
const CACHE_TIMEOUT   = 15000;      // 15s hard cap on cache creation call

// IMPORTANT: This SYSTEM_INSTRUCTION is the ONLY system-level instruction Gemini
// sees for cached requests. Gemini prohibits passing `systemInstruction` alongside
// `cachedContent` at generate time, so ai.js prepends its per-request overlay
// (buildCacheOverlay) as a USER-turn instead. That overlay only carries the
// language-specific bits (Telugu vs English closing line + example). Every
// structural FORMAT RULE below must therefore live here, baked into the cache —
// otherwise all-news responses regress (lost bold headlines, headline echoes,
// bullet points, etc.).
//
// ⚠️ After editing this constant: restart the backend and trigger a scrape to
// rebuild the cache with the new SYSTEM_INSTRUCTION. The old cached object keeps
// the previous instruction until it is deleted + recreated (see refreshCache /
// createCache). You may also call clearCache() to force a full re-upload on the
// next scrape.
const SYSTEM_INSTRUCTION = `You are a Telugu newspaper AI assistant. You help readers understand, summarise, and navigate today's newspaper edition.

LANGUAGE RULES:
- If the user writes in Telugu, respond entirely in Telugu script.
- If the user writes in English, respond in clear simple English.
- Never mix languages in a single response unless quoting a proper noun.
- Do NOT translate proper nouns — politician names, city names, party names stay as-is.

ANTI-HALLUCINATION:
- ONLY use facts from today's articles provided in the cached context.
- NEVER invent, add, or infer names, scores, statistics, dates, quotes, or events from your training knowledge.
- If a topic is not in today's paper, say so clearly — never fabricate content.

CONTENT RULES:
- Answer ONLY from the articles provided in today's context.
- NEVER add facts, statistics, scores, or events from your training knowledge.
- If a topic is not in today's paper, say so clearly — never invent content.
- When explaining complex news, use simple language and avoid jargon.
- When quoting article content, copy the exact words — never paraphrase inaccurately.
- NEVER fabricate quotes, statistics, player names, or results.

FORMAT RULES — mandatory for all-news / edition-wide listings, no exceptions:
1. Show EVERY article listed. Never skip any.
2. Write each article on its OWN LINE using EXACTLY this pattern:
   **Headline text** — one sentence of NEW context from the Body.
3. ⚠️ BOLD IS CRITICAL — every headline must open with ** and close with ** before the " — ".
   ❌ WRONG (no bold):   Headline text — description
   ✅ RIGHT (bold):   **Headline text** — description
4. NO REPETITION: the sentence after " — " MUST add new information that is NOT already stated in the headline.
   ▸ Names: if the headline contains a person's name, place name, or organization, do NOT start the description with that same word. Start with new context.
   ▸ Numbers: if the headline already contains a number (medal count, score, age, rank, percentage), NEVER repeat that same number in the description. Use a different fact entirely.
   ❌ WRONG: **సల్మాన్ ఖాన్ మద్దతు** — సల్మాన్ ఖాన్ కామన్వెల్త్...   (name repeated)
   ✅ RIGHT:  **సల్మాన్ ఖాన్ మద్దతు** — కామన్వెల్త్ పీపుల్స్ పార్టీకి తన మద్దతు ప్రకటించారు.
   ❌ WRONG: **భారత్‌కు 19వ పతకం ఖరారు** — 19 పతకాలు ఖాయమయ్యాయి   (number repeated)
   ✅ RIGHT:  **భారత్‌కు 19వ పతకం ఖరారు** — అజింక్య రహానే 7వ రోజు ఆ ఘనత సాధించారు.
5. If an article has NO Body line: output **Headline text** and STOP — no dash, no space, no description, nothing after the closing **.
   Also treat the Body as absent if it ends mid-word or without sentence-ending punctuation (. ! ? ।) — that means the text was truncated, so Rule 5 applies.
   ❌ WRONG: **Market prices rise** — Market prices rise
   ❌ WRONG: **Market prices rise** —
   ✅ RIGHT: **Market prices rise**
6. Blank line between each article.
7. No numbered lists. No bullet points. No extra commentary. No URLs.
(The exact closing prompt line and a worked example are supplied per-request in the user-turn overlay, because they are language-specific — do not add your own closing line or example here.)

TONE: Warm, helpful, conversational. For Telugu, use everyday conversational Telugu, not overly formal.`;

// ── Prompt version ────────────────────────────────────────────────────────────
// Bump this string whenever SYSTEM_INSTRUCTION changes. It is mixed into the
// article-set hash, so a prompt edit forces a cache rebuild even when the
// article IDs haven't changed (otherwise the old rules stay baked in).
const PROMPT_VERSION = 'v3-rule4-numbers';

// ── Module state ─────────────────────────────────────────────────────────────
let activeCacheId   = null;   // full resource name, e.g. "cachedContents/abc123"
let cacheExpiresAt  = 0;      // epoch ms
let cacheRefreshing = false;
let lastArticleHash = null;   // SHA-1 of sorted article IDs + prompt version

// Hash covers both article IDs and the prompt version.
// Changing SYSTEM_INSTRUCTION → bump PROMPT_VERSION → new hash → cache rebuild.
const crypto = require('crypto');
function hashArticles(articles) {
  const ids = articles.map(a => a.id).sort().join(',');
  return crypto.createHash('sha1').update(PROMPT_VERSION + ':' + ids).digest('hex');
}

// ── Build article context string ─────────────────────────────────────────────
function buildCacheContext(articles) {
  if (!articles || articles.length === 0) return '';

  // Static editorial context — pads token count toward the 32,768 minimum when
  // article count is low, and gives the AI background so it can answer
  // "what is this newspaper?" type questions.
  const EDITORIAL_CONTEXT = `ABOUT THIS NEWSPAPER:
This is the official AI assistant for a Telugu-language newspaper published daily in Andhra Pradesh and Telangana, India.
The newspaper covers: National politics, Andhra Pradesh state news, Telangana state news, International news, Sports (especially cricket and IPL), Business and markets (Sensex, Nifty), Cinema (Tollywood), Crime, Education, Agriculture, Irrigation, Railways, and Public Health.
Key politicians covered: AP — Chandrababu Naidu (TDP), Pawan Kalyan (Jana Sena), YS Jagan Mohan Reddy (YSRCP), Lokesh. Telangana — Revanth Reddy (Congress), KT Rama Rao (BRS), K Chandrashekar Rao (BRS).
Key cities: Hyderabad, Amaravati, Vijayawada, Visakhapatnam, Warangal, Tirupati, Guntur, Nellore.
The newspaper is read by Telugu-speaking people across Andhra Pradesh, Telangana, and the global Telugu diaspora.
When a reader asks about something not in today's edition, say clearly: "ఈ వివరాలు ఈ రోజు పేపర్‌లో లేవు" (This information is not in today's paper).
Never invent news, scores, statistics, or events not present in today's articles below.

SUPPORTED LANGUAGES: Telugu (primary), English (secondary).
RESPONSE FORMAT: Bold **Headline** then 1-2 sentences from article body. No bullet points. No [1][2] numbering. Plain text.

---
`;

  let ctx = EDITORIAL_CONTEXT;
  // Use IST (UTC+5:30) for the date label — the server may run on UTC and
  // toLocaleDateString() would print yesterday's date after ~18:30 IST.
  const istDate = new Date(Date.now() + 5.5 * 3600 * 1000);
  const dateLabel = istDate.toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  ctx += `TODAY'S NEWSPAPER EDITION — ${dateLabel}\n\nTotal articles: ${articles.length}\n\n`;

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

  // Delete the previous cache object before creating a new one.
  // Without this every scrape mints a new 24-hour cached-token object that
  // accrues storage billing until it expires — at peak that's 20+ orphaned
  // objects per day running up cost silently.
  if (activeCacheId) {
    const delUrl = `https://generativelanguage.googleapis.com/v1beta/${activeCacheId}?key=${encodeURIComponent(apiKey)}`;
    try {
      await fetch(delUrl, { method: 'DELETE' });
      console.log(`[NewsAI Cache] 🗑️  Deleted old cache: ${activeCacheId}`);
    } catch (_) {
      // Non-fatal — old cache will expire naturally; proceed with new creation
    }
    activeCacheId  = null;
    cacheExpiresAt = 0;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`;
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
  activeCacheId   = null;
  cacheExpiresAt  = 0;
  lastArticleHash = null;   // force re-upload on next morning's scrape
}

// ── Public: refresh cache with current articles ───────────────────────────────
async function refreshCache() {
  if (cacheRefreshing) return;

  const articles = store.getAllArticles();
  if (!articles.length) return;

  // Skip if the article set hasn't changed — avoids burning a delete+create cycle
  // on every scrape when only a handful of dupes were skipped and no new IDs appeared.
  const newHash = hashArticles(articles);
  if (newHash === lastArticleHash && activeCacheId && Date.now() < cacheExpiresAt) {
    console.log('[NewsAI Cache] ⏭️  Article set unchanged — skipping cache refresh');
    return;
  }

  cacheRefreshing = true;
  try {
    await createCache(articles);
    if (activeCacheId) lastArticleHash = newHash;   // only update hash on success
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
