'use strict';

/**
 * POST /api/ai — Server-side AI proxy (SSE streaming).
 *
 * Why: the widget previously called Gemini directly from the browser, which
 * exposed the API key to anyone who opened DevTools. This proxy keeps the key
 * server-side (process.env.GEMINI_API_KEY) and streams the model's tokens back
 * to the widget as Server-Sent Events.
 *
 * Request:  { messages: [{role,content}], lang: "te"|"en", sessionId: string }
 * Response: text/event-stream
 *              data: {"token":"..."}\n\n   (one per streamed token)
 *              data: [DONE]\n\n            (terminal)
 *
 * Flow:
 *   1. Validate body + key (503 JSON if no key).
 *   2. recordQuery() for per-session interest tracking.
 *   3. If a Gemini context cache is active → send the slim overlay only
 *      (the cache already holds all ~200 articles). Otherwise fetch the topN
 *      most relevant articles from the store and build TODAY'S ARTICLES context.
 *   4. Call Gemini streamGenerateContent and pipe each token back as SSE.
 *
 * SECURITY: the Gemini API key lives only in the request URL to Google. It is
 * NEVER echoed back to the client — every error path returns a generic message.
 */

const store = require('../store/articleStore');
const { recordQuery } = require('./user-context');
const { getCacheId } = require('./gemini-cache');
const { embedText } = require('./embed');
const { logQuery } = require('../store/queryLogger');

// Model is configurable via GEMINI_MODEL env var.
// Default: gemini-2.5-flash-lite (free-tier friendly, confirmed working).
// Upgrade options: gemini-3.6-flash, gemini-3.5-flash (require paid API plan + Interactions API migration).
const GEMINI_MODEL      = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_TIMEOUT_MS = 30000;

// ── Alternative AI provider: OpenAI ─────────────────────────────────────────
// Set AI_PROVIDER=openai in .env to route all AI requests through GPT-4o-mini.
// TTS stays on Sarvam Bulbul v3 regardless — OpenAI TTS has no Telugu support.
// Gemini context cache is bypassed for OpenAI (OpenAI has no equivalent).
const AI_PROVIDER       = process.env.AI_PROVIDER || 'gemini';   // 'gemini' | 'openai'
const OPENAI_MODEL      = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TIMEOUT_MS = 30000;

// Disable thinking tokens — Gemini 2.5 models output a "thought: true" part first,
// whose text goes to parts[0]; the actual response then arrives in later chunks ALSO
// as parts[0] in separate SSE events. Without thinkingBudget:0 our token extractor
// `candidates[0].content.parts[0].text` may miss response text or capture raw thought
// text as the response, producing garbled or empty output.
const GENERATION_CONFIG = {
  maxOutputTokens: 8192,
  temperature:     0.1,
  topP:            0.85,
  thinkingConfig:  { thinkingBudget: 0 },  // no thinking — faster, cheaper, reliable SSE
};
const BRAND_NAME        = process.env.BRAND_NAME || 'NewsAI';

// ── Abort orphaned Gemini streams per session ────────────────────────────────
// One in-flight Gemini stream per sessionId. When a new /api/ai arrives for a
// session that already has a stream running (user resent, or the widget retried),
// we abort the old controller so we stop paying for tokens nobody will read.
// Entry shape: { controller, lastSeen }. Cleaned up on stream end, and pruned by
// idle age once the Map grows past AI_STREAM_MAX.
const _aiStreamControllers = new Map();   // sessionId → { controller, lastSeen }
const AI_STREAM_MAX     = 200;
const AI_STREAM_IDLE_MS = 10 * 60 * 1000; // 10 min

// ── Query-embedding LRU cache ────────────────────────────────────────────────
// embedText() runs a local MiniLM forward pass on every query. Identical/repeated
// queries (section names, "ఈ రోజు వార్తలు", etc.) recompute the same vector each
// time. Cache the last 100 query vectors. Map insertion order == LRU order:
//   get() deletes+re-inserts to move the key to the end (most-recently-used);
//   set() evicts the first (oldest) key when size exceeds 100.
const _embedCache     = new Map();  // key → 384-dim vector (or null)
const EMBED_CACHE_MAX = 100;
function _embedKey(lang, query) {
  return lang + ':' + String(query || '').trim().toLowerCase();
}
function _embedGet(key) {
  // undefined = miss. null IS a valid cached value (embedding failed earlier),
  // so we must distinguish "not present" from "present but null".
  if (!_embedCache.has(key)) return undefined;
  const v = _embedCache.get(key);
  _embedCache.delete(key);
  _embedCache.set(key, v);   // move to most-recently-used position
  return v;
}
function _embedSet(key, v) {
  if (_embedCache.has(key)) _embedCache.delete(key);
  _embedCache.set(key, v);
  if (_embedCache.size > EMBED_CACHE_MAX) {
    _embedCache.delete(_embedCache.keys().next().value);  // evict oldest
  }
}

// ── Per-IP token-bucket rate limiter for /api/ai ─────────────────────────────
// Every /api/ai call is a paid LLM inference. The global/burst limiters cap
// overall traffic, but without a per-IP cap one user can spam Gemini and burn
// credits. Token bucket: 30 tokens max (burst), refills 1 token every 2s
// (= 30/min steady state). Smoother than a fixed window — a client that pauses
// briefly regains capacity gradually instead of waiting for a hard window reset.
const _aiBuckets = new Map();  // ip → { tokens, lastRefill }
const AI_RATE_LIMIT   = 30;    // max burst
const AI_REFILL_MS    = 2000;  // 1 token per 2s refill

function aiRateLimiter(req, res, next) {
  const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let   b   = _aiBuckets.get(ip);
  if (!b) { b = { tokens: AI_RATE_LIMIT, lastRefill: now }; _aiBuckets.set(ip, b); }
  // Refill tokens proportional to time elapsed since the last request from this IP
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(AI_RATE_LIMIT, b.tokens + elapsed / AI_REFILL_MS);
  b.lastRefill = now;
  if (b.tokens < 1) {
    res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
    return;
  }
  b.tokens -= 1;
  // Cleanup stale buckets when the Map grows large (prevent unbounded growth)
  if (_aiBuckets.size > 1000) {
    const cutoff = now - 10 * 60 * 1000;  // 10 min idle
    for (const [k, v] of _aiBuckets) { if (v.lastRefill < cutoff) _aiBuckets.delete(k); }
  }
  next();
}

// ── In-memory response cache for repeated list-mode queries ──────────────────
// Caches non-detail, non-article-ref list responses for 5 minutes.
// Key: lang + ':' + normalizedQuery + ':' + articleCount
// On hit: re-emits meta + full response as SSE without calling Gemini.
// On miss: accumulates streamed tokens, stores after DONE.
// Clears automatically as article count changes (stale key never matches).
const _responseCache    = new Map();
const RESPONSE_CACHE_TTL = 5 * 60 * 1000;   // 5 minutes

function _rcKey(lang, msg, n, histLen, hasCacheId) {
  // Include conversation history length so context-dependent follow-ups get separate entries.
  // Include cache presence so full-context (cacheId) and inline-context responses don't collide.
  return `${lang}:${hasCacheId ? 'c' : 'n'}:${histLen}:${(msg || '').toLowerCase().trim().replace(/\s+/g, ' ')}:${n}`;
}
function _rcGet(key) {
  const e = _responseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.cachedAt > RESPONSE_CACHE_TTL) { _responseCache.delete(key); return null; }
  return e;
}
// Prevent the cache growing unbounded — evict oldest when over 50 entries
function _rcSet(key, text, articleMeta) {
  // Only evict when we're about to add a NEW key — updates don't grow the cache
  if (!_responseCache.has(key) && _responseCache.size >= 50) {
    _responseCache.delete(_responseCache.keys().next().value);
  }
  _responseCache.set(key, { text, articleMeta, cachedAt: Date.now() });
}
// Called at midnight IST reset so stale answers from yesterday are never served
function clearResponseCache() {
  _responseCache.clear();
  console.log('[NewsAI AI] 🌙 Response cache cleared for new edition');
}

// ── Detect if user is referencing an article by number or position ────────────
// Fires when user replies "2", "first", "రెండవ", etc. after seeing the article list.
function isArticleRef(msg) {
  const q = (msg || '').trim();
  if (/^\d+$/.test(q) && +q >= 1 && +q <= 15) return true;
  if (/^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\b/i.test(q)) return true;
  // NOTE: \b (word boundary) does NOT work after Telugu characters — Telugu letters
  // are not \w, so \b never asserts true here and this test always returned false,
  // silently breaking article-number replies like "రెండవ" / "మొదటి". Anchor to ^ only.
  if (/^(మొదటి|రెండవ|మూడవ|నాల్గవ|ఐదవ|ఆరవ|ఏడవ|ఎనిమిదవ|తొమ్మిదవ|పదవ)/.test(q)) return true;
  return false;
}

function extractArticleRefNumber(msg) {
  const q = (msg || '').trim();
  const m = q.match(/^(\d+)/);
  if (m) return parseInt(m[1], 10);
  const MAP = {
    first:1,'1st':1,మొదటి:1, second:2,'2nd':2,రెండవ:2, third:3,'3rd':3,మూడవ:3,
    fourth:4,'4th':4,నాల్గవ:4, fifth:5,'5th':5,ఐదవ:5, sixth:6,'6th':6,ఆరవ:6,
    seventh:7,'7th':7,ఏడవ:7, eighth:8,'8th':8,ఎనిమిదవ:8, ninth:9,'9th':9,తొమ్మిదవ:9,
    tenth:10,'10th':10,పదవ:10,
  };
  for (const [w, n] of Object.entries(MAP)) {
    if (q.toLowerCase().startsWith(w.toLowerCase())) return n;
  }
  return null;
}

// Parse **bold** headlines from the last assistant message in history
function extractPreviousHeadlines(messages) {
  const lastAI = [...messages].reverse().find(m => m && m.role === 'assistant' && m.content);
  if (!lastAI) return [];
  const matches = [...String(lastAI.content).matchAll(/\*\*([^*\n]{5,200}?)\*\*/g)];
  return matches.map(m => m[1].trim()).filter(h => h.length > 5);
}

// ── topN classifier ────────────────────────────────────────────────────────────
function classifyTopN(lastUserMsg) {
  const q = (lastUserMsg || '').toLowerCase().trim();
  // Article reference reply (user saying "2", "second", etc.) — handled separately
  if (isArticleRef(lastUserMsg)) return 3;
  // Short factual: who/what/when/where/how-many
  if (q.length < 60 && /^(who|what|when|where|how many|ఎవరు|ఏమి|ఎంత|ఎప్పుడు|స్కోర్|కెప్టెన్)/.test(q)) {
    return 6;
  }
  // Section-specific queries — user wants ALL news from one section
  if (/(telangana|hyderabad|andhra\s*pradesh|andhra|sports|cricket|cinema|movies|business|economy|national|india|international|world|politics|education|agriculture|farming|crime|police|technology|family|lifestyle|railways|తెలంగాణ|హైదరాబాద్|ఆంధ్ర|ఏపీ|క్రీడ|సినిమా|వ్యాపార|జాతీయ|అంతర్జాతీయ|రాజకీయ|విద్య|వ్యవసాయ|నేరాల|వార్తలు|న్యాయ|రైల్వే)/.test(q)) {
    return 15;
  }
  // Broad digest / today's headlines / summary — these bypass queryHybrid entirely (see isAllNewsQuery)
  if (/(summary|summarize|digest|headlines|all news|today|ఈ రోజు|అన్ని వార్తలు|హెడ్‌లైన్స్|సారాంశం|టాప్ వార్తలు|ముఖ్య వార్తలు|ప్రధాన వార్తలు|లేటెస్ట్|breaking)/.test(q)) {
    return 12;  // isAllNewsQuery will use getAllArticles().slice(0,12) — keep in sync
  }
  return 10;  // default: enough for a useful list
}

// ── Detect "show me ALL of today's news" queries ─────────────────────────────
// These must bypass queryHybrid() because generic words like "ఈ రోజు", "ముఖ్య",
// "వార్తలు" score zero against specific article keywords — causing only 0-3 articles
// to pass the _score > 0 filter even when 50+ articles are in the store.
// Instead we directly use getAllArticles() sorted by recency.
function isAllNewsQuery(msg) {
  const q = (msg || '').toLowerCase().trim();
  if (isArticleRef(msg) || isDetailQuery(msg)) return false;
  return /(summary|summarize|digest|headlines|all news|today.*news|news.*today|ఈ రోజు|అన్ని వార్తలు|హెడ్‌లైన్స్|సారాంశం|టాప్ వార్తలు|ముఖ్య వార్తలు|ప్రధాన వార్తలు|లేటెస్ట్ వార్తలు|breaking|top stories)/.test(q);
}

// ── Detect section-specific queries ──────────────────────────────────────────
// Returns the matched section name (e.g. 'Telangana', 'Sports') when the user
// is asking for news from ONE specific section. Returns null for general queries.
//
// Difference from isAllNewsQuery:
//   isAllNewsQuery → "ఈ రోజు ముఖ్య వార్తలు" — give me everything
//   detectSectionQuery → "తెలంగాణ వార్తలు" — give me only Telangana
//
// When a section is detected, aiProxy filters getAllArticles() by that section
// instead of using queryHybrid (which can miss section articles with generic titles).
const SECTION_TRIGGERS = [
  // More specific patterns first — prevents "andhra" matching "national" etc.
  { section: 'Andhra Pradesh', re: /andhra\s*pradesh|\bap\s+news\b|ఆంధ్రప్రదేశ్|ఆంధ్ర\s*ప్రదేశ్|అమరావతి|విజయవాడ|విశాఖ|విజాగ్|చంద్రబాబు|పవన్\s*కళ్యాణ్|నెల్లూరు|గుంటూరు|తిరుపతి|ఏపీ\s+వార్తలు|ఏపి\s+వార్తలు/ },
  { section: 'Telangana',      re: /telangana|hyderabad|secunderabad|warangal|తెలంగాణ|హైదరాబాద్|సికింద్రాబాద్|వరంగల్|కరీంనగర్|రేవంత్\s*రెడ్డి|కేటీఆర్|ఖమ్మం|నల్లగొండ|ఆదిలాబాద్|సిద్దిపేట/ },
  { section: 'Sports',         re: /\bsports?\b|cricket|ipl|football|kabaddi|hockey|olympics|badminton|tennis|మ్యాచ్|క్రీడ|క్రికెట్|ఫుట్బాల్|కబడ్డీ|ఒలింపిక్స్|ఐపీఎల్|హాకీ|టెన్నిస్|బ్యాడ్మింటన్|ఆటలు|ఆటగాడు|సెంచరీ/ },
  { section: 'Cinema',         re: /\bcinema\b|movies?|tollywood|bollywood|\bott\b|trailer|సినిమా|వినోదం|టాలీవుడ్|బాలీవుడ్|నటుడు|నటి|మూవీ|హీరో|హీరోయిన్|దర్శకుడు|రిలీజ్|ట్రైలర్|టీజర్/ },
  { section: 'Business',       re: /business|economy|market\s+news|sensex|nifty|stock\s+market|budget|gdp|gst|\bfinance\b|వ్యాపారం|ఆర్థిక|మార్కెట్|సెన్సెక్స్|నిఫ్టీ|బడ్జెట్|జీడీపీ|జీఎస్టీ|బంగారం|షేర్|ఆర్‌బీఐ/ },
  { section: 'International',  re: /international|world\s+news|global\s+news|america\s+news|russia\s+news|china\s+news|ukraine|israel|అంతర్జాతీయ|ప్రపంచం|అమెరికా\s+వార్తలు|చైనా|రష్యా|పాకిస్తాన్|ఇజ్రాయెల్|ఇరాన్|నాటో/ },
  { section: 'National',       re: /\bnational\b|india\s+news|delhi\s+news|parliament\s+news|జాతీయ|భారత్\s+వార్తలు|ఢిల్లీ\s+వార్తలు|కేంద్ర\s+ప్రభుత్వం|పార్లమెంట్|లోక్‌సభ/ },
  // Politics — the old pattern required the exact word "politics" (so "political news",
  // "politics news" and "politicians" all missed) and, in Telugu, only matched
  // "రాజకీయ వార్తలు" WITH a space. Every miss fell through to queryHybrid, which has no
  // section awareness — that is how cinema articles were returned for "political news".
  { section: 'Politics',       re: /\bpolitic(?:s|al|ian|ians)\b|\belections?\b|\bassembly\s+news\b|\bpoll\s+news\b|పొలిటికల్|పొలిటిక్స్|రాజకీయ|ఎన్నిక|శాసనసభ|అసెంబ్లీ|ప్రతిపక్ష|అధికారపక్ష/ },
  { section: 'Crime & Police', re: /\bcrime\s+news\b|police\s+news|నేరాలు\s+వార్తలు|పోలీసు\s+వార్తలు|హత్య\s+వార్తలు/ },
  { section: 'Agriculture',    re: /agriculture\s+news|farm\s+news|farmer\s+news|రైతు\s+వార్తలు|వ్యవసాయం\s+వార్తలు|రైతన్న/ },
  { section: 'Education',      re: /education\s+news|school\s+news|eamcet|నీట్\s+ఫలితాలు|జేఈఈ|విద్య\s+వార్తలు|పాఠశాల\s+వార్తలు|పరీక్ష\s+ఫలితాలు|ఎంసెట్/ },
  { section: 'Public Health',  re: /health\s+news|hospital\s+news|ఆరోగ్యం\s+వార్తలు|వైద్యం\s+వార్తలు/ },
  { section: 'Technology',     re: /tech\s+news|technology\s+news|cyber\s+news|సాంకేతిక\s+వార్తలు|సైబర్\s+వార్తలు|డిజిటల్\s+వార్తలు/ },
  { section: 'Courts',         re: /court\s+news|verdict\s+news|న్యాయస్థానం\s+వార్తలు|హైకోర్టు\s+వార్తలు|సుప్రీంకోర్టు/ },
  { section: 'Railways',       re: /railway\s+news|train\s+news|metro\s+news|రైల్వే\s+వార్తలు|మెట్రో\s+వార్తలు|వందేభారత్/ },
];

function detectSectionQuery(msg) {
  // Never fire for general all-news or detail queries
  if (!msg || isAllNewsQuery(msg) || isArticleRef(msg) || isDetailQuery(msg)) return null;
  const q = (msg || '').toLowerCase().trim();
  for (const { section, re } of SECTION_TRIGGERS) {
    if (re.test(q)) return section;
  }
  return null;
}

// ── Section relevance ────────────────────────────────────────────────────────
// Built from the SAME vocabulary the store uses to auto-tag articles at ingest
// (TELUGU_SECTION_MAP + ENGLISH_SECTION_KEYWORDS), so "does this article belong to
// section X?" is answered identically on both sides of the pipeline.
//
// Why this exists: the section path used to fall back to store.queryHybrid() whenever
// fewer than 3 articles carried the exact section label. queryHybrid scores by keyword
// + embedding similarity and knows NOTHING about sections, so a Politics query with a
// thin Politics bucket came back full of Cinema articles — which the prompt then
// dutifully read out as "today's political news". Now the fallback is filtered.
const _SECTION_TOKENS = (() => {
  const map = {};
  for (const entry of (store.TELUGU_SECTION_MAP || [])) {
    map[entry.section] = new Set(entry.tokens);
  }
  for (const [word, section] of Object.entries(store.ENGLISH_SECTION_KEYWORDS || {})) {
    if (!map[section]) map[section] = new Set();
    map[section].add(word);
  }
  // Section label words themselves ("politics", "sports") are always relevant.
  for (const section of Object.keys(map)) {
    section.toLowerCase().split(/[\s&]+/).forEach(w => { if (w.length > 2) map[section].add(w); });
  }
  return map;
})();

function _normSection(s) {
  return String(s || '').toLowerCase().replace(/[\s&]+/g, '');
}

// STRICT: the article was explicitly labelled (or auto-tagged) with this section.
function articleInSectionStrict(a, section) {
  const secNorm = _normSection(section);
  if (_normSection(a.section) === secNorm) return true;
  if (Array.isArray(a.tags)) {
    return a.tags.some(t => _normSection(String(t).replace(/^#/, '')) === secNorm);
  }
  return false;
}

// LOOSE: strict match, OR the article's own text contains a keyword that belongs to
// this section. Used to widen a thin section bucket WITHOUT admitting unrelated news.
function articleInSectionLoose(a, section) {
  if (articleInSectionStrict(a, section)) return true;
  const toks = _SECTION_TOKENS[section];
  if (!toks || toks.size === 0) return false;
  const title = a.title || '';
  const body  = (a.content || '').slice(0, 600);
  const teluguProbe = title + ' ' + body;          // Telugu has no case — match as-is
  const asciiProbe  = teluguProbe.toLowerCase();   // English tokens are lowercase
  for (const t of toks) {
    if (/^[a-z]+$/.test(t)) {
      // Whole-word match for short ASCII tokens ("ap" must not match "apple")
      if (new RegExp(`\\b${t}\\b`).test(asciiProbe)) return true;
    } else if (teluguProbe.includes(t)) {
      return true;
    }
  }
  return false;
}

// ── Build the TODAY'S ARTICLES context block ─────────────────────────────────
// Shows EVERY retrieved article so the AI can list all of them.
// Body dedup: Sakshi CMS often copies the headline verbatim as the first
//   sentence of the body. Detect this (body ≈ headline) and mark as no-summary
//   rather than letting the AI echo the headline as its own description.
// Detail queries: pass bodyLimit=2000 to send the full article body for deep dives.
function buildArticleContext(articles, bodyLimit = 500) {
  // Use IST (UTC+5:30) so the date label is correct after 18:30 UTC when UTC rolls over
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const date = nowIST.toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  // ── Title sanitiser ───────────────────────────────────────────────────────
  // Sakshi (and many news CMSes) appends datelines like "Sat, Jul 18 2026 6:53 AM"
  // to article titles when scraped. Strip them so Gemini doesn't echo the timestamp.
  // Also removes a CMS artifact where the page <title> includes the article headline
  // PLUS the first sentence of the body — joined by a space with a repeated key term.
  // e.g., "రిటైర్మెంట్ అజింక్య రహానే వెటరన్ అజింక్య రహానే కీలక ని"
  //         ← first phrase ──────────────→ ← body fragment ────────→
  // Detection: if a word (≥5 chars) from the first 5 words reappears after word-index 5,
  // clip the title at the start of that repetition.
  function sanitiseTitle(raw) {
    let t = (raw || '')
      // "Sat, Jul 18 2026 6:53 AM" / "Saturday, 18 July 2026" and variants
      .replace(/\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[,.]?\s+[A-Za-z]*\s*\d{1,2}[,.]?\s*\d{4}[^a-zA-Zఀ-౿]*/gi, '')
      // Stand-alone time "6:53 AM" / "10:30 PM"
      .replace(/\s*\b\d{1,2}:\d{2}\s*(AM|PM)\b/gi, '')
      .trim();

    // ── Duplicate-body-fragment detection ────────────────────────────────────
    // Only run on titles long enough to contain both headline + body fragment.
    if (t.length > 65) {
      const words = t.split(/\s+/);
      if (words.length > 8) {
        // Extract key words (≥5 chars) from the first 5 words
        const firstFive = words.slice(0, 5)
          .map(w => w.replace(/[‌‍​-‏﻿]/g, ''))  // strip zero-width chars
          .filter(w => w.length >= 5);
        outerLoop:
        for (const fw of firstFive) {
          // Search for an exact re-occurrence of this word starting at word-index 5
          for (let i = 5; i < words.length; i++) {
            const cw = words[i].replace(/[‌‍​-‏﻿]/g, '');
            if (cw === fw) {
              // Clip at the repetition point and strip trailing punctuation
              t = words.slice(0, i).join(' ').replace(/[\s,.:—\-—–]+$/, '').trim();
              break outerLoop;
            }
          }
        }
      }
    }
    return t;
  }

  // ── Body sanitiser ────────────────────────────────────────────────────────
  // In LIST mode (bodyLimit ≤ 500) we only want the FIRST sentence.
  // Sakshi's __NEXT_DATA__ sometimes includes related-article text after the
  // first sentence, which Gemini then uses as the description for the WRONG article.
  // Clipping at the first sentence boundary (Telugu `।`, `.`, `!`, `?`) prevents
  // cross-article contamination from ever reaching Gemini.
  function firstSentence(text, limit) {
    if (limit > 500) return text.slice(0, limit);          // detail mode — keep full body
    const cap = Math.min(text.length, limit);
    // ── Widen scan window to 380 chars ───────────────────────────────────────
    // Telugu sentences are long (40-120 words vs ~20 in English) and rarely end
    // within 220 chars. The old 220-char cap meant many Telugu articles fell
    // through to a hard-cut at 500 chars — giving Gemini mid-word fragments
    // like "విజయవం" (truncated "విజయవంతంగా") which it then echoes in responses.
    const SENT_END = /[.!?।]/g;
    let lastEnd = -1;
    let m;
    const scan = text.slice(0, 380);
    while ((m = SENT_END.exec(scan)) !== null) lastEnd = m.index;
    if (lastEnd > 30) return text.slice(0, lastEnd + 1);   // clip at sentence boundary
    // Hard-cut fallback: cap at 300 instead of 500 and strip to last space so we
    // never give Gemini a mid-word fragment it can echo verbatim.
    const chunk = text.slice(0, Math.min(text.length, 300));
    const lastSpace = chunk.lastIndexOf(' ');
    return lastSpace > 60 ? chunk.slice(0, lastSpace) : chunk;
  }

  // Photo-gallery / slideshow matcher. ఫొటోలు (U+0C4A) and ఫోటోలు (U+0C4B) are
  // different Telugu vowel signs — include both. Also catch English "(Photos)"
  // and "gallery" variants.
  const GALLERY_RE = /best photos|photo of the week|photos of the|top \d+ photos|\(photos?\)|photo gallery|gallery|ఫొటోలు|ఫోటోలు|ఫోటో గ్యాలరీ|గ్యాలరీ/i;

  // Deduplicate by title (exact match) and filter photo galleries / ad widgets
  const seenTitles = new Set();
  const cleaned = articles.filter(a => {
    if (!a.title || !a.title.trim()) return false;
    const rawTitle = a.title.trim();
    const t = sanitiseTitle(rawTitle);
    // Filter photo galleries & slideshow articles.
    // Test the RAW title (not only the sanitised one): sanitiseTitle's dateline
    // stripper ends with `[^a-zA-Z...]*` which can, on some scraped titles,
    // consume a trailing "(ఫోటోలు)" parenthetical — letting a gallery article
    // slip past a sanitised-only test. This was the cinema-section leak: cinema
    // surfaces far more photo galleries than the general digest, so the same
    // filter that looked fine on all-news queries missed them here.
    // Strip zero-width joiners (ZWNJ/ZWJ appear inside scraped Telugu titles,
    // e.g. "కూకట్‌పల్లి") so they can't split the gallery token and defeat the match.
    const galleryProbe = (rawTitle + ' ' + t).replace(/[​-‍﻿]/g, '');
    if (GALLERY_RE.test(galleryProbe)) return false;
    // Filter promotional / ad content (price tags, limited editions, discount offers)
    if (/కేవలం\s*\d+|స్పెషల్\s*ఎడిషన్|only\s*\d+\s*(left|available|remaining)|limited\s*(offer|edition)|\d+%\s*off/i.test(t)) return false;
    // Filter district/category SEO pages scraped as fake articles.
    // Pattern: body is a keyword-spam list "X తాజా వార్తలు, X వీడియోస్, X న్యూస్"
    // These come from Sakshi's district/category index pages, not real articles.
    const bodyProbe = (a.content || '').slice(0, 300);
    if (/తాజా వార్తలు.{0,120}వీడియోస్|latest news.{0,120}videos/i.test(bodyProbe)) return false;
    // Also filter titles that are pure district/location labels (≤ 4 words, no verb)
    if (/న్యూస్$|crime news$/i.test(t) && t.split(/\s+/).length <= 6) return false;
    // Filter titles that are too short to be real articles
    if (t.length < 15) return false;
    // Deduplicate by normalized title
    const key = t.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  let ctx = `Today's articles (${cleaned.length} total) | ${date}\n\n`;
  if (cleaned.length === 0) return ctx + '(No articles available for this query today.)\n';

  // Build a set of all sanitised headlines (normalised) for cross-contamination detection.
  // If a body text exactly matches another article's headline, it's a scraper artefact —
  // the CMS injected a related-article node whose headline became the "body" text.
  const allHeadlineNorms = new Set(
    cleaned.map(a => sanitiseTitle(a.title || '').toLowerCase().replace(/\s+/g, ' ').trim())
  );

  // ── Cross-contamination detector ────────────────────────────────────────────
  // A body is contaminated when it is (a) an EXACT copy of a DIFFERENT article's
  // headline, or (b) a leading PREFIX of a different headline — the case the exact
  // Set lookup misses. Example: the fragment "సంక్రాంతిపై కన్నేసిన నాగ్" is copied
  // as filler across many articles but is only a PREFIX of the full headline
  // "సంక్రాంతిపై కన్నేసిన నాగ్రజిని ...". Excludes the article's own headline.
  function bodyMatchesOtherHeadline(bodyNormTrimmed, ownNorm) {
    if (!bodyNormTrimmed || bodyNormTrimmed.length < 12 || bodyNormTrimmed.length > 200) return false;
    // (a) exact match to another headline
    if (bodyNormTrimmed !== ownNorm && allHeadlineNorms.has(bodyNormTrimmed)) return true;
    // (b) prefix of another headline
    for (const h of allHeadlineNorms) {
      if (h === ownNorm) continue;                        // never flag own headline
      if (h.length < bodyNormTrimmed.length + 4) continue; // need a real extension
      if (h.startsWith(bodyNormTrimmed)) return true;
    }
    return false;
  }

  for (const a of cleaned) {
    const cleanTitle = sanitiseTitle(a.title);

    // Relative age — helps Gemini distinguish "breaking" from "morning edition" articles.
    // Uses addedAt (set at ingest) as the best proxy for publication time.
    const ts = a.addedAt ? new Date(a.addedAt).getTime() : 0;
    const ageMin = ts ? Math.round((Date.now() - ts) / 60000) : null;
    const ageLabel = ageMin === null ? '' :
      ageMin < 10  ? ' [BREAKING]' :
      ageMin < 60  ? ` [${ageMin}m ago]` :
      ageMin < 720 ? ` [${Math.floor(ageMin / 60)}h ago]` : '';

    ctx += `Headline: ${cleanTitle}${ageLabel}\n`;

    // ── Context budget (list mode only) ───────────────────────────────────────
    // Section queries can return 20+ articles; giving every one a 500-char body
    // slot bloats context to 12–15K tokens and makes Gemini pad with generic
    // filler. In LIST mode (bodyLimit ≤ 500) only the first 5 articles get a body
    // line — the rest are headline-only. DETAIL mode (bodyLimit > 500) always
    // includes the full body regardless of position.
    const isPrimary   = cleaned.indexOf(a) < 5;
    const includeBody = isPrimary || bodyLimit > 500;

    const rawBody   = (a.content || '').trim();
    const titleNorm = cleanTitle.toLowerCase().replace(/\s+/g, ' ');

    if (includeBody && rawBody && rawBody.length >= 80) {
      const bodyNorm = rawBody.toLowerCase().replace(/\s+/g, ' ');

      // ── Check 1: body IS this article's headline ───────────────────────────
      // Detect CMS artifact: body starts with headline text and is not substantially
      // longer. Common in Sakshi where the CMS copies the headline as the lede sentence.
      const prefix40  = titleNorm.slice(0, 40);
      const bodyIsHeadline =
        prefix40.length > 15 &&
        bodyNorm.startsWith(prefix40) &&
        rawBody.length < cleanTitle.length * 1.6;

      // ── Check 2: body IS (or is a PREFIX of) another article's headline ────
      // Happens when extractBodyFromArticlePage picks up a related-article paragraph
      // from the page. Both exact and prefix contamination are handled by the helper.
      const bodyNormTrimmed = bodyNorm.trim();
      const ownNorm = titleNorm.trim();
      const isCrossContaminated = !bodyIsHeadline && bodyMatchesOtherHeadline(bodyNormTrimmed, ownNorm);

      if (bodyIsHeadline || isCrossContaminated) {
        // Omit body line entirely — no marker text for Gemini to echo.
        // Rule 5 in the system prompt handles "no Body line" → output headline only, no dash.
      } else {
        // Strip leading headline repetition when body starts with the headline's prefix
        let cleanBody = rawBody;
        const prefix30 = titleNorm.slice(0, 30);
        if (prefix30.length > 12 && bodyNorm.startsWith(prefix30)) {
          const stripped = rawBody.slice(prefix30.length).replace(/^[\s:,.।—\-–]+/, '').trim();
          if (stripped.length >= 60) cleanBody = stripped;
        }
        // Strip headline-TAIL repetition: many Telugu cinema headlines end with the
        // person's name (e.g. "Quote: రకుల్ ప్రీత్ సింగ్"), and the body naturally
        // starts with that same name ("రకుల్ ప్రీత్ సింగ్ తన...").
        // Find the longest 2-4 word tail of the headline that is a prefix of the body.
        const headWords = titleNorm.trim().split(/\s+/).filter(Boolean);
        if (headWords.length >= 2) {
          const bodyLower = cleanBody.replace(/[​-‍﻿ ]/g, '').toLowerCase().replace(/\s+/g, ' ').trimStart();
          for (let n = Math.min(4, headWords.length); n >= 2; n--) {
            const tail = headWords.slice(-n).join(' ');
            if (tail.length < 6) continue;   // skip very short tails (single short words)
            if (bodyLower.startsWith(tail)) {
              const after = cleanBody.slice(tail.length).replace(/^[\s:,.।—\-–]+/, '').trim();
              if (after.length >= 40) { cleanBody = after; break; }
            }
          }
        }
        // Bug 3 fix: do NOT append '…' — Gemini echoes it literally mid-sentence.
        // The clip is an internal size limit, not meaningful text for the AI.
        const clipped = firstSentence(cleanBody, bodyLimit);
        ctx += `Body: ${clipped}\n`;
      }
    } else if (includeBody && rawBody) {
      // Very short body (<80 chars). These bypass the length-gated checks above,
      // but the cross-contaminated fragment "సంక్రాంతిపై కన్నేసిన నాగ్" is itself
      // short — so run the same contamination test here before including it, or it
      // leaks into Gemini's context (and then into the spoken TTS output).
      const shortBodyNorm = rawBody.toLowerCase().replace(/\s+/g, ' ').trim();
      const shortOwnNorm  = titleNorm.trim();
      if (!bodyMatchesOtherHeadline(shortBodyNorm, shortOwnNorm)) {
        ctx += `Body: ${rawBody}\n`;   // clean short body — include as-is
      }
      // else: contaminated short body — omit entirely (Rule 5 → headline only)
    }
    // No body at all (or a non-primary article in list mode) → omit body line
    // entirely (same rationale as bodyIsHeadline above)

    if (a.url)         ctx += `URL: ${a.url}\n`;
    if (a.imageUrl)    ctx += `Image: ${a.imageUrl}\n`;
    ctx += '\n';
  }
  return ctx;
}

// ── Detect if query is asking for full details on a single article ────────────
function isDetailQuery(msg) {
  const q = (msg || '').toLowerCase();
  return /(full details|tell me more|explain|వివరాలు|పూర్తి వివరాలు|వివరంగా|explain more|more about|elaborate|what happened|ఏం జరిగింది|ఎందుకు|how did|why did)/.test(q);
}

// ── System prompt (full — used when NO Gemini cache is active) ────────────────
// ── Voice-mode appendix ────────────────────────────────────────────────────────
// Appended to the system prompt when the user is speaking (voiceMode/voiceInput).
// Instructs Gemini to produce speech-ready Telugu: no digits, no markdown, short
// sentences, natural spoken connectives — so Sarvam TTS reads it like a human anchor.
const VOICE_PROMPT_TE = `

VOICE OUTPUT MODE — CRITICAL: your response will be read aloud by a Telugu TTS system.
Follow EVERY rule below without exception:

NUMBERS: Write ALL numbers as Telugu words. Never use digits or symbols.
  ₹100 కోట్లు  → నూరు కోట్ల రూపాయలు
  25%           → ఇరవై అయిదు శాతం
  2024లో        → రెండు వేల ఇరవై నాలుగులో
  1,500         → పదిహేను వందలు
  3వ స్థానం     → మూడవ స్థానం

SENTENCES: Maximum 12 Telugu words per sentence. Break long sentences into two.

VOCABULARY: Use ONLY Telugu words. Replace every English word with its Telugu equivalent.
  PM → ప్రధాని, CM → ముఖ్యమంత్రి, BJP → భారతీయ జనతా పార్టీ (first use only)

STYLE: Speak like a friendly Telugu news anchor on radio — warm, clear, conversational.
  Use natural spoken connectives: అయితే, కానీ, అందువల్ల, మరియు, అంటే, కాబట్టి.
  Never use bullet points, dashes, bold, or any punctuation that does not sound natural.

ACRONYMS: Spell out on first use. After that, the short form in Telugu script is fine.`;

const VOICE_PROMPT_EN = `

VOICE OUTPUT MODE — CRITICAL: your response will be read aloud by a TTS system.
- Write ALL numbers as English words (₹100 crore → one hundred crore rupees, 25% → twenty-five percent).
- Maximum 15 words per sentence. Break long sentences.
- No bullet points, no bold, no markdown of any kind.
- Speak like a friendly radio news anchor — conversational and clear.`;

// ── Voice-mode system prompt (replaces list format entirely) ─────────────────
// When the user is listening (voiceMode=true), Gemini must produce FLOWING PROSE
// like a radio news anchor — NOT the **Headline — description** list format.
// The list format is entirely wrong for TTS: Sarvam reads "Headline dash (same words again)"
// which sounds robotic and repetitive. This prompt generates smooth spoken narration instead.
function buildVoiceSystemPrompt(lang, context, opts = {}) {
  const langRule = lang === 'en'
    ? 'respond in clear, natural English'
    : 'respond entirely in Telugu script (తెలుగు). Every word must be in Telugu.';

  const outro = lang === 'en'
    ? "Ask me about any story for full details."
    : 'ఏ వార్త గురించి మరింత తెలుసుకోవాలంటే అడగండి.';

  const rules = lang === 'en' ? `
VOICE NARRATION RULES — follow every rule without exception:
1. Write FLOWING PROSE ONLY. Absolutely no bold text, dashes (—), bullet points, asterisks, or markdown.
2. ⛔ NO PREAMBLE. Never open with a greeting or a summary line such as "Here are today's top stories",
   "Here's the news", "Today's headlines are", "Good morning". Start DIRECTLY with the first story's facts.
   ❌ WRONG: "Here are today's top stories. The chief minister said…"
   ✅ RIGHT: "The chief minister said…"
3. For each article write 2 natural sentences.
4. ⛔ NO TOPIC-SWITCH TRANSITIONS. Never announce a section — "Turning to sports", "In cinema news",
   "In political news", "Now for business" are all BANNED, even if the story is about that topic.
   Use only neutral connectives between stories: "Meanwhile,", "Also,", "In other news,", "Elsewhere,".
5. Write ALL numbers as words: ₹100 crore → "one hundred crore rupees", 25% → "twenty-five percent".
6. Keep each sentence under 15 words. Split long sentences.
7. Do NOT repeat the headline's exact words in the immediately following sentence — lead with NEW information.
8. End with exactly: "${outro}"
9. Do NOT write article numbers, list numbers, or any counting format.` : `
VOICE నేరేషన్ నియమాలు — ప్రతి నియమం తప్పకుండా పాటించండి:
1. పూర్తిగా FLOWING PROSE మాత్రమే రాయండి. Bold, dashes (—), bullet points, asterisks, markdown ఏమీ వాడవద్దు.
2. ⛔ ఎలాంటి ఉపోద్ఘాతం (preamble) రాయవద్దు. "ఈ రోజు ముఖ్యమైన వార్తలు ఇవే", "ఇవి ఈ రోజు వార్తలు",
   "నమస్కారం", "ఈ రోజు వార్తలు" వంటి పరిచయ వాక్యాలు పూర్తిగా నిషేధం.
   మొదటి వార్త విషయంతోనే నేరుగా మొదలుపెట్టండి.
   ❌ తప్పు: "ఈ రోజు ముఖ్యమైన వార్తలు ఇవే. ముఖ్యమంత్రి ప్రకటించారు…"
   ✅ సరైనది: "ముఖ్యమంత్రి ప్రకటించారు…"
3. ప్రతి వార్తకు 2 సహజమైన వాక్యాలు రాయండి.
4. ⛔ విభాగం పేరు చెప్పే transitions పూర్తిగా నిషేధం — "ఇప్పుడు క్రీడల వార్తలు", "సినిమా రంగం నుండి",
   "రాజకీయ వార్తల్లో", "వ్యాపార వార్తలు" ఇలాంటివి ఎప్పుడూ రాయవద్దు.
   వార్తల మధ్య తటస్థ connectives మాత్రమే వాడండి: "అలాగే,", "ఇంకా,", "మరో వార్తలో,".
5. అన్ని సంఖ్యలు Telugu words లో రాయండి: ₹100 కోట్లు → "నూరు కోట్ల రూపాయలు", 25% → "ఇరవై అయిదు శాతం".
6. ఒక్కో వాక్యంలో maximum 12 Telugu words ఉండాలి. పెద్ద వాక్యాలు రెండుగా విభజించండి.
7. Headline లో వాడిన మాటలే తర్వాత వాక్యంలో repeat చేయవద్దు. కొత్త సమాచారంతో మొదలుపెట్టండి.
8. అయితే, కానీ, అందువల్ల, మరియు వంటి spoken connectives వాడండి.
9. PM → ప్రధాని, CM → ముఖ్యమంత్రి వాడండి.
10. Response చివరికి ఖచ్చితంగా ఇలా రాయండి: "${outro}"
11. Article numbers, list numbers వాడవద్దు.`;

  return `You are ${BRAND_NAME} — reading today's newspaper aloud to the listener.
LANGUAGE: ${langRule}.
ANTI-HALLUCINATION: ONLY use facts from TODAY'S ARTICLES below. Never invent names, scores, statistics, or events.
${buildSectionScopeRule(lang, opts)}${rules}

COVER EVERY article in TODAY'S ARTICLES that is in scope. Write pure spoken narration — NO formatting symbols of any kind.

TODAY'S ARTICLES:
${context}`;
}

// ── Section scope rule ───────────────────────────────────────────────────────
// Injected into the system prompt whenever the reader asked for ONE section.
// Retrieval already filters by section, but a thin bucket can still contain a
// loosely-matched article — this rule stops the model from reading anything
// off-topic and, in the empty-section case, makes it say so instead of passing
// unrelated articles off as the requested section.
function buildSectionScopeRule(lang, opts = {}) {
  const section = opts && opts.section;
  if (!section) return '';
  const teLabel = SECTION_LABEL_TE[section] || section;

  if (opts.sectionFallback) {
    return lang === 'en'
      ? `\nSECTION SCOPE — CRITICAL: the reader asked for ${section} news, but today's edition has NO ${section} articles.
Open with ONE short sentence saying there is no ${section} news in today's paper, then give the general headlines below.
NEVER present an unrelated article as if it were ${section} news.\n`
      : `\nSECTION SCOPE — చాలా ముఖ్యం: పాఠకుడు ${teLabel} వార్తలు అడిగారు, కానీ ఈ రోజు పత్రికలో ${teLabel} వార్తలు లేవు.
ముందుగా ఒకే ఒక చిన్న వాక్యంలో "ఈ రోజు ${teLabel} వార్తలు లేవు" అని చెప్పి, ఆ తర్వాత కింద ఉన్న సాధారణ వార్తలు చెప్పండి.
సంబంధం లేని వార్తను ${teLabel} వార్తగా ఎప్పుడూ చెప్పవద్దు.\n`;
  }

  return lang === 'en'
    ? `\nSECTION SCOPE — CRITICAL: the reader asked ONLY for ${section} news.
Report ONLY articles that are genuinely about ${section}. If an article below is about a different
topic (a film review, a match report, a share price… when they are not what was asked for), SKIP IT
ENTIRELY — do not mention its headline, and do not count it. It is far better to return three
on-topic stories than ten with unrelated ones mixed in.\n`
    : `\nSECTION SCOPE — చాలా ముఖ్యం: పాఠకుడు ${teLabel} వార్తలు మాత్రమే అడిగారు.
నిజంగా ${teLabel} విభాగానికి చెందిన వార్తలు మాత్రమే చెప్పండి. కింద ఇచ్చిన వార్తల్లో ఏదైనా వేరే విషయానికి
సంబంధించినది ఉంటే (సినిమా రివ్యూ, మ్యాచ్ స్కోరు, షేర్ ధర… అడగనివి) దాన్ని పూర్తిగా వదిలేయండి —
దాని headline కూడా చెప్పవద్దు. పది వార్తల్లో సంబంధం లేనివి కలపడం కంటే మూడు సరైన వార్తలు చెప్పడమే మేలు.\n`;
}

// Telugu labels for section names — used by buildSectionScopeRule().
const SECTION_LABEL_TE = {
  'Telangana': 'తెలంగాణ', 'Andhra Pradesh': 'ఆంధ్రప్రదేశ్', 'Sports': 'క్రీడల',
  'Cinema': 'సినిమా', 'Business': 'వ్యాపార', 'International': 'అంతర్జాతీయ',
  'National': 'జాతీయ', 'Politics': 'రాజకీయ', 'Crime & Police': 'నేరాల',
  'Agriculture': 'వ్యవసాయ', 'Education': 'విద్యా', 'Public Health': 'ఆరోగ్య',
  'Technology': 'సాంకేతిక', 'Courts': 'న్యాయస్థాన', 'Railways': 'రైల్వే',
};

function buildSystemPrompt(lang, context, isVoiceMode = false, opts = {}) {
  // Voice mode: skip the list format entirely — use flowing prose for TTS
  if (isVoiceMode) return buildVoiceSystemPrompt(lang, context, opts);
  const closing = lang === 'en'
    ? "Which story would you like full details on? Reply with a number (1, 2, 3…) or a keyword from the headline."
    : 'ఏ వార్త పూర్తి వివరాలు కావాలో అడగండి. నంబర్ చెప్పండి (1, 2, 3…) లేదా వార్త కీవర్డ్ టైప్ చేయండి.';
  const langRule = lang === 'en'
    ? 'respond in English'
    : 'respond in Telugu script';

  // Generic format example — shows the PATTERN without any real political content
  // (political examples risk triggering Gemini safety filters and producing empty output)
  const example = lang === 'en'
    ? `**Leader announces new infrastructure project** — The chief minister said work will begin next month in the capital.

**Sports team wins regional championship** — The squad defeated rivals by 3 goals in yesterday's final.

**Market prices rise amid global trends**`
    : `**నాయకుడు కొత్త మౌలిక సదుపాయాల ప్రాజెక్ట్ ప్రకటించారు** — ముఖ్యమంత్రి వచ్చే నెల రాజధానిలో పని ప్రారంభమవుతుందని తెలిపారు.

**స్పోర్ట్స్ జట్టు ప్రాంతీయ చాంపియన్‌షిప్ గెలిచింది** — నిన్న ఫైనల్‌లో 3 గోల్‌ల తేడాతో జట్టు విజయం సాధించింది.

**మార్కెట్ ధరలు పెరిగాయి**`;

  const voiceAppendix = isVoiceMode ? (lang === 'en' ? VOICE_PROMPT_EN : VOICE_PROMPT_TE) : '';

  return `You are ${BRAND_NAME} — a newspaper AI assistant helping readers explore today's edition.
LANGUAGE: ${langRule}. Every word must be in ${lang === 'en' ? 'English' : 'Telugu'} (proper nouns may stay as they appear in the article).
ANTI-HALLUCINATION: ONLY use facts from TODAY'S ARTICLES below. Never invent names, scores, statistics, or events.
${buildSectionScopeRule(lang, opts)}
FORMAT RULES — mandatory, no exceptions:
1. Show every article listed in TODAY'S ARTICLES${opts && opts.section ? ' that is in scope (see SECTION SCOPE above)' : '. Never skip any'}.
2. Write each article on its OWN LINE using EXACTLY this pattern:
   **Headline text** — one sentence of NEW context from Body
3. ⚠️ BOLD IS CRITICAL — NEVER write a headline without **double asterisks**.
   ❌ WRONG (no bold):   Headline text — description
   ✅ RIGHT (bold):   **Headline text** — description
   Every single headline must open with ** and close with ** before the " — ".
4. NO REPETITION: the sentence after " — " MUST add new information (a name, location, number, quote, or outcome) that is NOT already stated in the headline. Never restate or rephrase the headline.
   ▸ Names: if the headline contains a person's name, place name, or organization, do NOT start the description with that same word. Start with new context.
   ▸ Numbers: if the headline already contains a number (medal count, score, age, rank, percentage), NEVER repeat that same number in the description. Use a different fact entirely.
   ❌ WRONG: **సల్మాన్ ఖాన్ మద్దతు** — సల్మాన్ ఖాన్ కామన్వెల్త్...   (name repeated)
   ✅ RIGHT:  **సల్మాన్ ఖాన్ మద్దతు** — కామన్వెల్త్ పీపుల్స్ పార్టీకి తన మద్దతు ప్రకటించారు.
   ❌ WRONG: **భారత్‌కు 19వ పతకం ఖరారు** — 19 పతకాలు ఖాయమయ్యాయి   (number repeated)
   ✅ RIGHT:  **భారత్‌కు 19వ పతకం ఖరారు** — అజింక్య రహానే 7వ రోజు ఆ ఘనత సాధించారు.
5. If an article has NO Body line: output **Headline text** and STOP — no dash, no space, no description, nothing after the closing **. ❌ DO NOT copy the headline as description. ❌ DO NOT add " — " at all.
   Also treat the Body as absent if it ends mid-word or without sentence-ending punctuation (. ! ? ।) — that means the text was truncated, so Rule 5 applies.
   ❌ WRONG: **Market prices rise** — Market prices rise
   ❌ WRONG: **Market prices rise** —
   ✅ RIGHT: **Market prices rise**
6. Blank line between each article.
7. After ALL articles write this line exactly: ${closing}
8. No numbered lists. No bullet points. No extra commentary. No URLs.

EXAMPLE OF CORRECT OUTPUT:
${example}

TODAY'S ARTICLES:
${context}${voiceAppendix}`;
}

// ── Slim overlay (used when a Gemini context cache IS active) ─────────────────
// Mirrors the FORMAT RULES of buildSystemPrompt() so Gemini behaves identically
// whether articles were injected inline or loaded from cache.
function buildCacheOverlay(lang, isVoiceMode = false) {
  if (isVoiceMode) {
    // Voice overlay: tell Gemini to narrate the cached articles as flowing prose.
    // MUST NOT use the list format rules — those conflict with voice output.
    const langRule = lang === 'en'
      ? 'RESPOND IN ENGLISH ONLY.'
      : 'RESPOND IN TELUGU. Every word in Telugu script. Only proper nouns may stay in English.';
    const outro = lang === 'en'
      ? "Ask me about any story for full details."
      : 'ఏ వార్త గురించి మరింత తెలుసుకోవాలంటే అడగండి.';
    // Neutral connectives only — topic-labelled transitions ("Turning to sports",
    // "ఇప్పుడు క్రీడల వార్తలు") made every digest sound like a section round-up and
    // leaked sports/cinema framing into unrelated answers.
    const transitions = lang === 'en'
      ? 'Meanwhile, Also, In other news, Elsewhere,'
      : 'అలాగే, ఇంకా, మరో వార్తలో,';
    const noPreamble = lang === 'en'
      ? '- ⛔ NO PREAMBLE: never open with "Here are today\'s top stories" or any greeting/summary line. Start directly with the first story\'s facts.\n- ⛔ NO TOPIC-SWITCH TRANSITIONS: "Turning to sports", "In cinema news", "In political news" are BANNED.'
      : '- ⛔ ఉపోద్ఘాతం నిషేధం: "ఈ రోజు ముఖ్యమైన వార్తలు ఇవే" వంటి పరిచయ వాక్యం ఎప్పుడూ రాయవద్దు. మొదటి వార్త విషయంతోనే మొదలుపెట్టండి.\n- ⛔ విభాగం పేరు చెప్పే transitions నిషేధం: "ఇప్పుడు క్రీడల వార్తలు", "సినిమా రంగం నుండి", "రాజకీయ వార్తల్లో" వాడవద్దు.';
    return `${langRule}
VOICE NARRATION MODE — you are a radio news anchor reading aloud. Follow ALL rules:
- Write FLOWING PROSE ONLY. No bold, no dashes (—), no bullet points, no markdown.
${noPreamble}
- For each article: 2 natural sentences. Join stories with a neutral connective (${transitions}).
- ALL numbers as words. Max 12 Telugu / 15 English words per sentence.
- Do NOT repeat headline words in the immediately following sentence — lead with NEW info.
- End with: "${outro}"`;
  }
  const langRule = lang === 'en'
    ? 'RESPOND IN ENGLISH ONLY.'
    : 'RESPOND IN TELUGU. Every word must be in Telugu script. Only proper nouns may stay in English.';
  const closing = lang === 'en'
    ? "Which story would you like full details on? Reply with a number (1, 2, 3…) or a keyword from the headline."
    : 'ఏ వార్త పూర్తి వివరాలు కావాలో అడగండి. నంబర్ చెప్పండి (1, 2, 3…) లేదా వార్త కీవర్డ్ టైప్ చేయండి.';

  // Neutral format example — same examples used in buildSystemPrompt() so Gemini
  // sees consistent formatting cues regardless of which path is active.
  const example = lang === 'en'
    ? `**Leader announces new infrastructure project** — The chief minister said work will begin next month in the capital.

**Sports team wins regional championship** — The squad defeated rivals by 3 goals in yesterday's final.

**Market prices rise amid global trends**`
    : `**నాయకుడు కొత్త మౌలిక సదుపాయాల ప్రాజెక్ట్ ప్రకటించారు** — ముఖ్యమంత్రి వచ్చే నెల రాజధానిలో పని ప్రారంభమవుతుందని తెలిపారు.

**స్పోర్ట్స్ జట్టు ప్రాంతీయ చాంపియన్‌షిప్ గెలిచింది** — నిన్న ఫైనల్‌లో 3 గోల్‌ల తేడాతో జట్టు విజయం సాధించింది.

**మార్కెట్ ధరలు పెరిగాయి**`;

  return `You are ${BRAND_NAME} — a newspaper AI assistant helping readers explore today's edition.
LANGUAGE: ${langRule}. Every word must be in ${lang === 'en' ? 'English' : 'Telugu'} (proper nouns may stay as they appear in the article).
ANTI-HALLUCINATION: ONLY use facts from TODAY'S CACHED ARTICLES. Never invent names, scores, statistics, or events.

FORMAT RULES — mandatory, no exceptions:
1. Show EVERY article listed. Never skip any.
2. Write each article on its OWN LINE using EXACTLY this pattern:
   **Headline text** — one sentence of NEW context from Body
3. ⚠️ BOLD IS CRITICAL — NEVER write a headline without **double asterisks**.
   ❌ WRONG (no bold):   Headline text — description
   ✅ RIGHT (bold):   **Headline text** — description
   Every single headline must open with ** and close with ** before the " — ".
4. NO REPETITION: the sentence after " — " MUST add new information (a name, location, number, quote, or outcome) that is NOT already stated in the headline. Never restate or rephrase the headline.
   ▸ Names: if the headline contains a person's name, place name, or organization, do NOT start the description with that same word. Start with new context.
   ▸ Numbers: if the headline already contains a number (medal count, score, age, rank, percentage), NEVER repeat that same number in the description. Use a different fact entirely.
   ❌ WRONG: **సల్మాన్ ఖాన్ మద్దతు** — సల్మాన్ ఖాన్ కామన్వెల్త్...   (name repeated)
   ✅ RIGHT:  **సల్మాన్ ఖాన్ మద్దతు** — కామన్వెల్త్ పీపుల్స్ పార్టీకి తన మద్దతు ప్రకటించారు.
   ❌ WRONG: **భారత్‌కు 19వ పతకం ఖరారు** — 19 పతకాలు ఖాయమయ్యాయి   (number repeated)
   ✅ RIGHT:  **భారత్‌కు 19వ పతకం ఖరారు** — అజింక్య రహానే 7వ రోజు ఆ ఘనత సాధించారు.
5. If an article has NO Body line: output **Headline text** and STOP — no dash, no space, no description, nothing after the closing **. ❌ DO NOT copy the headline as description. ❌ DO NOT add " — " at all.
   Also treat the Body as absent if it ends mid-word or without sentence-ending punctuation (. ! ? ।) — that means the text was truncated, so Rule 5 applies.
   ❌ WRONG: **Market prices rise** — Market prices rise
   ❌ WRONG: **Market prices rise** —
   ✅ RIGHT: **Market prices rise**
6. Blank line between each article.
7. After ALL articles write this line exactly: ${closing}
8. No numbered lists. No bullet points. No extra commentary. No URLs.

EXAMPLE OF CORRECT OUTPUT:
${example}${isVoiceMode ? (lang === 'en' ? VOICE_PROMPT_EN : VOICE_PROMPT_TE) : ''}`;
}

// ── Detail prompt — for when user selects a specific article ──────────────────
function buildDetailPrompt(lang, context) {
  const langRule = lang === 'en'
    ? 'respond in clear English'
    : 'respond in Telugu script (తెలుగు)';
  return `You are ${BRAND_NAME} — a newspaper AI assistant.
LANGUAGE: ${langRule}. Every word in ${lang === 'en' ? 'English' : 'Telugu'} (proper nouns as they appear).
ANTI-HALLUCINATION: ONLY use facts from the article below. Do not add outside knowledge.

The user has selected a specific article and wants FULL DETAILS. Provide a comprehensive response covering:
• What happened — 3–5 sentences summarising the event
• Who is involved — key people, parties, or organisations mentioned
• Where / When — location and timing if stated in the article
• Why it matters — significance or outcome mentioned
• Any quotes or statistics from the article

ARTICLE:
${context}`;
}

// ── SSE helpers ──────────────────────────────────────────────────────────────
// Honor the same ALLOWED_ORIGINS env var used by the main CORS middleware in
// server.js. Without this, the SSE endpoint would accept any origin even when
// production restricts to sakshi.com — defeating the CORS hardening (task 83).
const _sseAllowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : null;  // null = no restriction (dev mode)

function sseSetup(res, req) {
  const origin       = req && req.headers && req.headers.origin;
  // In dev (no ALLOWED_ORIGINS), reflect '*'. In prod, reflect the request's
  // own origin if it's in the allowed list, else fall back to the first allowed
  // origin (preflight already blocked disallowed origins before we get here).
  const allowOrigin  = !_sseAllowedOrigins
    ? '*'
    : (origin && _sseAllowedOrigins.includes(origin) ? origin : _sseAllowedOrigins[0]);
  res.writeHead(200, {
    'Content-Type':                'text/event-stream',
    'Cache-Control':               'no-cache',
    'Connection':                  'keep-alive',
    'X-Accel-Buffering':           'no',   // disable Nginx buffering
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary':                        'Origin',
  });
  res.flushHeaders();
  if (res.socket) { try { res.socket.setNoDelay(true); } catch (_) {} }
}

// ── OpenAI streaming helper ──────────────────────────────────────────────────
// Called when AI_PROVIDER=openai. Converts the Gemini-format bodyObj to OpenAI
// chat messages, streams GPT-4o-mini tokens back as the same { token } SSE
// events the widget already understands — zero frontend changes needed.
async function _streamFromOpenAI(req, res, bodyObj, ctx) {
  const { cacheKey, articleMeta, lastUserMsg, articles, detailMode, lang, reqStart } = ctx;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI proxy not configured on the server' });
  }

  // ── Convert Gemini body → OpenAI messages array ──────────────────────────
  // Gemini uses role:'model'; OpenAI uses role:'assistant'.
  // Gemini wraps text in parts[{text}]; OpenAI uses content string.
  // systemInstruction → { role:'system', content }
  // cachedContent path: the overlay was injected as the first user turn — treat
  // it the same as any other user turn (no special handling required).
  const msgs = [];
  if (bodyObj.systemInstruction) {
    msgs.push({ role: 'system', content: bodyObj.systemInstruction.parts[0].text });
  }
  for (const c of (bodyObj.contents || [])) {
    msgs.push({
      role:    c.role === 'model' ? 'assistant' : c.role,
      content: (c.parts || [{ text: '' }])[0].text,
    });
  }

  const maxTokens  = bodyObj.generationConfig?.maxOutputTokens || 2048;
  const openAiBody = {
    model:       OPENAI_MODEL,
    max_tokens:  maxTokens,
    temperature: 0.1,
    stream:      true,
    messages:    msgs,
  };

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body:   JSON.stringify(openAiBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const status = err.name === 'AbortError' ? 504 : 502;
    console.warn('[NewsAI AI] OpenAI request failed:', err.message);
    return res.status(status).json({ error: 'AI upstream unavailable' });
  }

  if (!upstream.ok) {
    clearTimeout(timer);
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 200); } catch (_) {}
    console.warn(`[NewsAI AI] OpenAI ${upstream.status}: ${detail}`);
    if (upstream.status === 429) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'AI rate limit reached — try again shortly' });
    }
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(503).json({ error: 'AI proxy authentication failed on the server' });
    }
    return res.status(502).json({ error: 'AI upstream error' });
  }

  sseSetup(res, req);
  try { res.write(`data: ${JSON.stringify({ meta: { articles: articleMeta } })}\n\n`); } catch (_) {}

  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) { clientGone = true; try { controller.abort(); } catch (_) {} }
  });
  const safeWrite = (obj) => {
    if (clientGone || res.writableEnded) return false;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; }
    catch (_) { clientGone = true; return false; }
  };

  const decoder    = new TextDecoder('utf-8');
  let   buf        = '';
  let   tokensSent = 0;
  let   fullText   = '';

  try {
    for await (const chunk of upstream.body) {
      if (clientGone) break;
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const json  = JSON.parse(raw);
          const token = json.choices?.[0]?.delta?.content || '';
          if (token) { safeWrite({ token }); tokensSent++; fullText += token; }
        } catch (_) {}
      }
    }
    buf += decoder.decode();
    if (!clientGone && buf.startsWith('data:')) {
      const raw = buf.slice(5).trim();
      if (raw && raw !== '[DONE]') {
        try {
          const json  = JSON.parse(raw);
          const token = json.choices?.[0]?.delta?.content || '';
          if (token) { safeWrite({ token }); tokensSent++; fullText += token; }
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[NewsAI AI] OpenAI stream error:', err.message);
  } finally {
    clearTimeout(timer);
    if (tokensSent === 0) {
      console.warn(`[NewsAI AI] ⚠️  0 tokens from OpenAI for "${lastUserMsg.slice(0, 80)}"`);
    } else {
      console.log(`[NewsAI AI] ✅ OpenAI (${OPENAI_MODEL}): ${tokensSent} tokens streamed`);
      if (cacheKey && fullText && !clientGone) {
        _rcSet(cacheKey, fullText, articleMeta);
        console.log(`[NewsAI AI] 🗄️  Cached OpenAI response for "${lastUserMsg.slice(0, 50)}" (${fullText.length} chars)`);
      }
      logQuery({
        query:        lastUserMsg,
        response:     fullText,
        lang,
        section:      detectSectionQuery(lastUserMsg) || null,
        detailMode,
        articleCount: articles.length,
        latencyMs:    Date.now() - reqStart,
      });
    }
    if (!res.writableEnded) {
      try { res.write('data: [DONE]\n\n'); res.end(); } catch (_) {}
    }
  }
}

/**
 * POST /api/ai
 */
async function aiProxy(req, res) {
  const _reqStart = Date.now();
  // Validate that the active provider's API key is present.
  // Never leak key names or provider details in the error response.
  const apiKey = AI_PROVIDER === 'openai'
    ? process.env.OPENAI_API_KEY
    : process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI proxy not configured on the server' });
  }

  const { messages, lang: rawLang, sessionId, voiceMode } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  const lang = rawLang === 'en' ? 'en' : 'te';

  // Last user message — drives article retrieval + interest tracking.
  const lastUserMsg = [...messages].reverse().find(m => m && m.role === 'user' && m.content)?.content || '';
  recordQuery(sessionId, String(lastUserMsg).slice(0, 500));

  // ── Build Gemini `contents` from the incoming chat history ─────────────────
  const contents = messages
    .filter(m => m && m.content)
    .map(m => ({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    }));
  // Gemini rejects consecutive same-role turns and a leading non-user turn.
  const deduped = contents.filter((m, i) => i === 0 || m.role !== contents[i - 1].role);
  while (deduped.length > 0 && deduped[0].role !== 'user') deduped.shift();
  if (deduped.length === 0) {
    return res.status(400).json({ error: 'no user message to send' });
  }

  // ── Article retrieval / cache decision ─────────────────────────────────────
  const cacheId = getCacheId();
  const topN    = classifyTopN(lastUserMsg);

  // ── Early exit: store is empty and no Gemini cache ──────────────────────────
  // When articles=0 and no cache, Gemini would receive an empty context and just
  // output the closing prompt ("ఏ వార్త పూర్తి వివరాలు కావాలో...") without any news.
  // Skip the API call entirely and return a clear "not loaded yet" message.
  if (store.getAllArticles().length === 0 && !cacheId) {
    sseSetup(res, req);
    const msg = lang === 'en'
      ? "Today's articles haven't been loaded yet. Please wait a moment and try again."
      : 'ఈ రోజు వార్తలు ఇంకా లోడ్ అవలేదు. కొంచెం సేపు వేచి మళ్లీ ప్రయత్నించండి.';
    try { res.write(`data: ${JSON.stringify({ token: msg })}\n\n`); } catch (_) {}
    try { res.write('data: [DONE]\n\n'); res.end(); } catch (_) {}
    console.warn('[NewsAI AI] Store empty — returned no-articles message without calling Gemini');
    return;
  }

  // Local semantic embedding (non-blocking, 2s cap).
  // Embeddings are generated LOCALLY (embed.js — no API key). The old gate
  // `&& process.env.HF_API_KEY` disabled query-time semantic search whenever
  // HF_API_KEY was unset, even though the articles already had local embeddings —
  // so hybrid search silently degraded to keyword-only. Embed the query whenever
  // any article has a vector; embedText() returns null gracefully if the model
  // is unavailable, and the 2nd arg is ignored (kept for backward compatibility).
  const embStats  = store.getEmbeddingStats();
  let   queryVector = null;
  if (embStats.withEmbedding > 0) {
    // LRU cache: reuse the vector for identical (lang + query) instead of re-embedding.
    const ek     = _embedKey(lang, lastUserMsg);
    const cached = _embedGet(ek);
    if (cached !== undefined) {
      queryVector = cached;
    } else {
      queryVector = await embedText(String(lastUserMsg), null, 2000).catch(() => null);
      _embedSet(ek, queryVector);
    }
  }

  // ── Article-reference detection ───────────────────────────────────────────
  // When the user replies "2" / "second" / "రెండవ" / a short keyword from the list,
  // resolve it to the specific article they mean (using the previous AI response
  // as the article list), then switch to a detail prompt with full body text.
  let detailMode   = false;
  let searchQuery  = String(lastUserMsg);  // what we search for in the store
  let fetchTopN    = topN;

  if (isArticleRef(lastUserMsg)) {
    // User replied with a number ("2") or ordinal ("second", "రెండవ") after seeing the list.
    // Map the position back to the specific headline so we can do a targeted detail search.
    const refNum       = extractArticleRefNumber(lastUserMsg);
    const prevHdlines  = extractPreviousHeadlines(messages);
    const targetHdline = refNum ? prevHdlines[refNum - 1] : null;
    if (targetHdline) {
      searchQuery = targetHdline;
      fetchTopN   = 3;
      detailMode  = true;
      console.log(`[NewsAI AI] Article ref #${refNum} → "${targetHdline.slice(0, 60)}"`);
    }
    // If prevHdlines is empty (first message, no history), fall through to normal search
  }
  // NOTE: Removed the aggressive keyword-match detailMode block that was here.
  // It matched almost any short query (length 4–59) against previous headlines,
  // accidentally entering detailMode on normal section queries like "Sports" or
  // "క్రికెట్", sending 0-3 articles to Gemini and producing empty/minimal responses.

  // ── Article retrieval ─────────────────────────────────────────────────────────
  // Three paths:
  //   1. isAllNewsQuery  → getAllArticles() — generic digest words score 0 in queryHybrid,
  //                        so we skip scoring entirely and return everything sorted by recency.
  //   2. detailMode      → queryHybrid with headline as the query (targeted, 3 articles)
  //   3. default         → queryHybrid keyword+semantic search
  let articles;
  // Section context for the prompt builders:
  //   sectionScope    — the section the reader asked for (null for general queries)
  //   sectionFallback — true when that section has NO articles today and we are
  //                     showing general headlines instead (the AI must say so).
  let sectionScope    = null;
  let sectionFallback = false;
  if (!detailMode && isAllNewsQuery(lastUserMsg)) {
    // Return all articles, newest first (articles accumulate chronologically in the store)
    const all = store.getAllArticles();
    articles  = [...all].reverse().slice(0, 12);   // top-12 most-recent — concise digest
    fetchTopN = articles.length;
    console.log(`[NewsAI AI] ALL-NEWS path — returning ${articles.length} of ${all.length} articles`);
  } else if (!detailMode) {
    // ── Section-filtered path ─────────────────────────────────────────────────
    // When user asks "తెలంగాణ వార్తలు" / "Sports news", filter getAllArticles()
    // by section rather than scoring with queryHybrid.  queryHybrid works well
    // for keyword/semantic searches but section names like "Sports" or "Telangana"
    // score all articles equally (every article has those words in tags) — so we
    // skip scoring entirely and return section articles sorted by recency.
    const detectedSection = detectSectionQuery(lastUserMsg);
    if (detectedSection) {
      sectionScope = detectedSection;
      const all    = store.getAllArticles();
      const recent = [...all].reverse();

      // Tier 1 — STRICT: section label or auto-tag matches.
      let filtered = recent.filter(a => articleInSectionStrict(a, detectedSection));

      // Tier 2 — LOOSE: thin bucket, so widen with keyword-relevant articles.
      // BUG FIX: this used to call store.queryHybrid(), which is section-blind and
      // happily returned Cinema articles for a Politics query. The widening pass now
      // only admits articles whose own text carries this section's vocabulary.
      if (filtered.length < 3) {
        const loose = recent.filter(a => articleInSectionLoose(a, detectedSection));
        const seen  = new Set(filtered.map(a => a.url || a.title));
        for (const a of loose) {
          const key = a.url || a.title;
          if (!seen.has(key)) { seen.add(key); filtered.push(a); }
        }
        console.log(`[NewsAI AI] SECTION path — "${detectedSection}" widened to ${filtered.length} via keyword relevance`);
      }
      filtered = filtered.slice(0, 25);

      if (filtered.length > 0) {
        articles = filtered;
        // ── Cap section context to top 15 ─────────────────────────────────────
        // A busy section (Sports, Cinema) can return 20+ articles; sending them all
        // bloats the prompt. Rank by the SAME embedding similarity used for topN
        // (store.cosineSimilarity, exactly as queryHybrid) and keep the best 15.
        // If there's no query embedding (embedding failed / not ready), keep the
        // first 15 by publish date — `filtered` is already newest-first.
        if (articles.length > 15) {
          if (queryVector) {
            articles = articles
              .map(a => ({
                a,
                sim: a.embedding ? store.cosineSimilarity(queryVector, a.embedding) : 0,
              }))
              .sort((x, y) => y.sim - x.sim)
              .slice(0, 15)
              .map(x => x.a);
          } else {
            articles = articles.slice(0, 15);   // newest 15 (filtered is newest-first)
          }
        }
        fetchTopN = articles.length;
        console.log(`[NewsAI AI] SECTION path — "${detectedSection}": ${articles.length} articles`);
      } else {
        // Genuinely nothing for this section today. Show recent headlines instead, but
        // flag it so the prompt makes the AI SAY the section is empty rather than
        // presenting unrelated articles as if they were the requested section.
        articles        = recent.slice(0, 12);
        sectionFallback = true;
        fetchTopN       = articles.length;
        console.log(`[NewsAI AI] SECTION path — "${detectedSection}" has 0 articles today; showing ${articles.length} recents with an explicit disclaimer`);
      }
    } else {
      articles = store.queryHybrid(searchQuery, queryVector, fetchTopN);
    }
  } else {
    // detailMode — targeted search using headline as the query
    articles = store.queryHybrid(searchQuery, null, fetchTopN);
  }

  // Safety fallback: detailMode resolved but found 0 articles (stale history or
  // no match in today's store) — fall back to a regular broad search so the user
  // always sees something rather than an empty response.
  if (detailMode && articles.length === 0) {
    console.warn(`[NewsAI AI] detailMode fallback — no articles for "${searchQuery.slice(0, 60)}"; reverting to normal search`);
    detailMode  = false;
    searchQuery = String(lastUserMsg);
    fetchTopN   = topN;
    articles    = store.queryHybrid(searchQuery, queryVector, fetchTopN);
  }

  // Secondary fallback: queryHybrid returned nothing (no keyword match) — show recents
  if (!detailMode && articles.length === 0) {
    const all = store.getAllArticles();
    articles  = [...all].reverse().slice(0, 15);
    console.warn(`[NewsAI AI] queryHybrid returned 0 — fallback to ${articles.length} recent articles`);
  }

  // Auto-detail: specific named-entity query that resolves to 1–2 articles should get
  // full body text + detail prompt instead of the terse list format.
  // Guards: skip for all-news, section, and article-ref (already handled above).
  if (!detailMode && articles.length <= 2 && articles.length > 0
      && !isAllNewsQuery(lastUserMsg) && !detectSectionQuery(lastUserMsg)) {
    detailMode = true;
    console.log(`[NewsAI AI] Auto-detail: ${articles.length} article(s) matched query — switching to detail mode`);
  }

  const bodyLimit  = (detailMode || isDetailQuery(lastUserMsg)) ? 2000 : 500;

  // ── Per-request output-token budget ──────────────────────────────────────────
  // Article reference / detail path needs room for a full write-up (8192); section
  // lists are medium (4096); all-news digests and short factual/general answers are
  // capped low (2048) to cut latency + cost. GENERATION_CONFIG stays the untouched
  // base — we spread it and override only maxOutputTokens when building bodyObj.
  const maxOutputTokens =
    (detailMode || isArticleRef(lastUserMsg) || isDetailQuery(lastUserMsg)) ? 8192 :
    detectSectionQuery(lastUserMsg)                                         ? 4096 :
    isAllNewsQuery(lastUserMsg)                                             ? 2048 :
    2048;
  const genConfig = { ...GENERATION_CONFIG, maxOutputTokens };
  console.log(`[NewsAI AI] ${detailMode ? 'DETAIL' : 'LIST'} | lang=${lang} | topN=${fetchTopN} | articles=${articles.length} | maxOut=${maxOutputTokens} | query="${searchQuery.slice(0, 50)}"`);

  const articleMeta = articles
    .filter(a => a.url)
    .slice(0, 5)
    .map(a => ({ url: a.url, title: a.title || '', imageUrl: a.imageUrl || null }));

  // ── Response cache — serve repeated list queries without a Gemini call ────────
  // Only applies to non-detail, non-article-ref, list-mode responses.
  // Cache key encodes lang + query + article count so stale entries are never served.
  const cacheKey = (!detailMode && !isArticleRef(lastUserMsg))
    ? _rcKey(lang, lastUserMsg, store.getAllArticles().length, deduped.length, !!cacheId)
    : null;
  if (cacheKey) {
    const hit = _rcGet(cacheKey);
    if (hit) {
      sseSetup(res, req);
      try { res.write(`data: ${JSON.stringify({ meta: { articles: hit.articleMeta } })}\n\n`); } catch (_) {}
      try { res.write(`data: ${JSON.stringify({ token: hit.text })}\n\n`); } catch (_) {}
      try { res.write('data: [DONE]\n\n'); res.end(); } catch (_) {}
      console.log(`[NewsAI AI] ✅ Cache HIT — "${lastUserMsg.slice(0, 50)}" (${hit.text.length} chars)`);
      return;
    }
  }

  let bodyObj;
  if (detailMode) {
    // User selected a specific article — give comprehensive details
    const context = buildArticleContext(articles, bodyLimit);
    bodyObj = {
      systemInstruction: { parts: [{ text: buildDetailPrompt(lang, context) }] },
      contents:          deduped,
      generationConfig:  genConfig,
    };
  } else if (cacheId && AI_PROVIDER !== 'openai' && isAllNewsQuery(lastUserMsg) && !detectSectionQuery(lastUserMsg)) {
    // ── Context-cache path (all-news queries only) ───────────────────────────
    // Two constraints:
    //   1. Gemini API: cachedContent + systemInstruction are MUTUALLY EXCLUSIVE —
    //      passing systemInstruction alongside cachedContent returns HTTP 400.
    //      The system_instruction baked into the cache at creation time is used
    //      automatically; we add per-request language/format rules as a user turn.
    //   2. Section queries (Cinema, Sports …) need FILTERED articles in context.
    //      The cache holds ALL articles, so section queries must bypass it and use
    //      buildSystemPrompt() with the filtered article set (the else branch below).
    const overlayMsg = buildCacheOverlay(lang, !!voiceMode);
    bodyObj = {
      cachedContent:  cacheId,
      // No systemInstruction here — API prohibits it alongside cachedContent.
      // Language and format rules are injected as the first conversational turn instead.
      contents: [
        { role: 'user',  parts: [{ text: overlayMsg }] },
        { role: 'model', parts: [{ text: 'Understood. I will follow these formatting and language rules exactly.' }] },
        ...deduped,
      ],
      generationConfig: genConfig,
    };
  } else {
    // Full system prompt with inline article context:
    //   • section queries (filtered articles — cache has the wrong scope)
    //   • no active cache
    //   • detail mode already handled above
    const context = buildArticleContext(articles, bodyLimit);
    bodyObj = {
      systemInstruction: { parts: [{ text: buildSystemPrompt(lang, context, !!voiceMode, { section: sectionScope, sectionFallback }) }] },
      contents:          deduped,
      generationConfig:  genConfig,
    };
  }

  // ── Route to OpenAI if configured ───────────────────────────────────────────
  // When AI_PROVIDER=openai the Gemini context cache is unused — the full article
  // context is always injected inline via systemInstruction (never cachedContent).
  if (AI_PROVIDER === 'openai') {
    return await _streamFromOpenAI(req, res, bodyObj, {
      cacheKey, articleMeta, lastUserMsg, articles, detailMode, lang,
      reqStart: _reqStart,
    });
  }

  // ── Call Gemini (headers first — errors return JSON before we commit to SSE) ─
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;
  const controller = new AbortController();

  // ── Abort any orphaned Gemini stream for this same session ──────────────────
  // Skipped entirely when sessionId is absent (never crash on missing id).
  if (sessionId) {
    const prior = _aiStreamControllers.get(sessionId);
    if (prior && prior.controller && prior.controller !== controller) {
      try { prior.controller.abort(); } catch (_) {}
    }
    _aiStreamControllers.set(sessionId, { controller, lastSeen: Date.now() });
    // Cleanup: once the Map grows past AI_STREAM_MAX, drop entries idle > 10 min.
    if (_aiStreamControllers.size > AI_STREAM_MAX) {
      const cutoff = Date.now() - AI_STREAM_IDLE_MS;
      for (const [sid, entry] of _aiStreamControllers) {
        if (entry.lastSeen < cutoff) _aiStreamControllers.delete(sid);
      }
    }
  }
  // Remove this session's entry — only if it still points at OUR controller
  // (a newer request for the same session may have replaced it).
  const releaseStream = () => {
    if (!sessionId) return;
    const entry = _aiStreamControllers.get(sessionId);
    if (entry && entry.controller === controller) _aiStreamControllers.delete(sessionId);
  };

  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(geminiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(bodyObj),
      signal:  controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    releaseStream();
    // AbortError = our timeout; anything else = network failure. Never echo the URL/key.
    const status = err.name === 'AbortError' ? 504 : 502;
    console.warn('[NewsAI AI] Gemini request failed:', err.message);
    return res.status(status).json({ error: 'AI upstream unavailable' });
  }

  // Non-OK upstream — map to a clean client error WITHOUT leaking the key/URL.
  if (!upstream.ok) {
    clearTimeout(timer);
    releaseStream();
    // Drain the error body server-side for logs only.
    let detail = '';
    try { detail = (await upstream.text()).slice(0, 200); } catch (_) {}
    console.warn(`[NewsAI AI] Gemini ${upstream.status}: ${detail}`);
    if (upstream.status === 429) {
      res.set('Retry-After', '30');
      return res.status(429).json({ error: 'AI rate limit reached — try again shortly' });
    }
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(503).json({ error: 'AI proxy authentication failed on the server' });
    }
    return res.status(502).json({ error: 'AI upstream error' });
  }

  // ── Stream tokens back as SSE ──────────────────────────────────────────────
  sseSetup(res, req);

  // Optional metadata event — widget ignores anything without a `token` field.
  try { res.write(`data: ${JSON.stringify({ meta: { articles: articleMeta } })}\n\n`); } catch (_) {}

  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      try { controller.abort(); } catch (_) {}   // stop paying for tokens the client won't see
    }
  });

  const safeWrite = (obj) => {
    if (clientGone || res.writableEnded) return false;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; }
    catch (_) { clientGone = true; return false; }
  };

  // Node 18+ native fetch returns Uint8Array chunks from response.body (Web Streams API).
  // Uint8Array.toString() IGNORES its encoding argument and returns comma-separated decimal
  // byte values ("100,97,116,...") — which breaks the SSE line parser entirely.
  // TextDecoder handles this correctly and correctly reassembles multi-byte UTF-8 sequences
  // (e.g. Telugu characters = 3 bytes each) that may be split across chunk boundaries.
  const decoder = new TextDecoder('utf-8');

  let buf        = '';
  let tokensSent = 0;
  let fullText   = '';   // accumulates all tokens for cache storage
  try {
    for await (const chunk of upstream.body) {
      if (clientGone) break;
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';   // keep the trailing partial line
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const json = JSON.parse(raw);
          // Gemini 2.5 thinking models send a "thought: true" part first,
          // then the actual response in subsequent chunks — both as parts[0].
          // With thinkingBudget:0 we disable thinking, but guard here anyway.
          const part = json.candidates?.[0]?.content?.parts?.[0];
          if (part && part.thought) continue;  // skip thinking tokens
          const token = part?.text || '';
          if (token) { safeWrite({ token }); tokensSent++; fullText += token; }
          // Detect safety block: candidates[] is empty or finishReason=SAFETY
          const fr = json.candidates?.[0]?.finishReason;
          if (fr && fr !== 'STOP' && fr !== 'MAX_TOKENS') {
            console.warn(`[NewsAI AI] Gemini finishReason=${fr} — possible safety block`);
          }
        } catch (_) { /* partial JSON across chunks — ignore */ }
      }
    }
    // Flush the TextDecoder (releases any incomplete multi-byte sequence held in its buffer).
    buf += decoder.decode();

    // Flush any trailing buffered line.
    if (!clientGone && buf.startsWith('data:')) {
      const raw = buf.slice(5).trim();
      if (raw && raw !== '[DONE]') {
        try {
          const json  = JSON.parse(raw);
          const token = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (token) { safeWrite({ token }); tokensSent++; fullText += token; }
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[NewsAI AI] Stream error:', err.message);
  } finally {
    clearTimeout(timer);
    releaseStream();
    if (tokensSent === 0) {
      // Zero tokens — log the last raw SSE line for diagnosis
      console.warn(`[NewsAI AI] ⚠️  0 tokens streamed for query "${lastUserMsg.slice(0, 80)}". Check Gemini safety filters or model availability.`);
      if (buf) console.warn('[NewsAI AI] Trailing SSE buf:', buf.slice(0, 300));
    } else {
      console.log(`[NewsAI AI] ✅ ${tokensSent} tokens streamed`);
      // Store in cache if this was a cacheable list query and streaming succeeded fully
      if (cacheKey && fullText && !clientGone) {
        _rcSet(cacheKey, fullText, articleMeta);
        console.log(`[NewsAI AI] 🗄️  Cached response for "${lastUserMsg.slice(0, 50)}" (${fullText.length} chars)`);
      }
      // Log query + response for training data / quality analysis
      logQuery({
        query:        lastUserMsg,
        response:     fullText,
        lang,
        section:      detectSectionQuery(lastUserMsg) || null,
        detailMode,
        articleCount: articles.length,
        latencyMs:    Date.now() - _reqStart,
      });
    }
    if (!res.writableEnded) {
      try { res.write('data: [DONE]\n\n'); res.end(); } catch (_) {}
    }
  }
}

module.exports = { aiProxy, clearResponseCache, aiRateLimiter };
