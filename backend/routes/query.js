'use strict';

const store         = require('../store/articleStore');
const { embedText } = require('./embed');

// ── Query response cache (1-hour TTL) ────────────────────────────────────────
// Caches the full query result keyed by question + topN so identical concurrent
// requests ("today's headlines?" from 50 users at once) share one HF call.
// 1-hour TTL: news articles typically don't change within an hour, so cache hits
// are safe. Cleared at IST midnight when the article store resets.
// Cleared automatically when entries expire — no manual eviction needed.
const queryCache   = new Map();   // key → { result, expiresAt }
const CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour — news articles update infrequently, safe to cache longer

function cacheGet(key) {
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { queryCache.delete(key); return null; }
  return entry.result;
}
function cacheSet(key, result) {
  queryCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict expired entries when cache grows large
  if (queryCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of queryCache) { if (now > v.expiresAt) queryCache.delete(k); }
    // Hard cap: with a 1-hour TTL, a flood of unique questions can outpace
    // expiry-based eviction and grow the Map without bound. Drop the oldest
    // (Maps iterate in insertion order) until we're back under the cap.
    while (queryCache.size > 500) {
      queryCache.delete(queryCache.keys().next().value);
    }
  }
}

// ── HF circuit breaker ────────────────────────────────────────────────────────
// After 3 consecutive HF timeouts skip semantic for 60s to prevent every query
// paying a 2s penalty during a cold-start period.
let hfFailCount    = 0;
let hfSkipUntil    = 0;
const HF_FAIL_LIMIT = 3;
const HF_SKIP_MS   = 60_000;

/**
 * Remove repeated sentences/fragments from article body text.
 * Handles RSS/CMS bugs where the same sentence is repeated many times.
 */
function dedupContent(text) {
  if (!text || text.length < 60) return text;

  // Pass 1: deduplicate at sentence boundaries
  const tokens = text.split(/([.?!।])/);
  const seenSent = new Set();
  const outTokens = [];
  for (let si = 0; si < tokens.length; si += 2) {
    const sent  = (tokens[si]  || '').trim();
    const delim = tokens[si + 1] || '';
    const norm  = sent.toLowerCase().replace(/\s+/g, ' ');
    if (norm.length >= 15) {
      if (seenSent.has(norm)) continue;
      seenSent.add(norm);
    }
    if (sent || delim) outTokens.push(sent + delim);
  }
  let result = outTokens.join(' ');

  // Pass 2: collapse consecutive repeated word-windows (fragments without punctuation)
  const words = result.split(/\s+/);
  if (words.length < 15) return result.trim();
  const WIN = 5;
  const outWords = [];
  let wi = 0;
  while (wi < words.length) {
    if (wi + WIN * 3 <= words.length) {
      const win  = words.slice(wi, wi + WIN).join(' ');
      const nxt1 = words.slice(wi + WIN, wi + WIN * 2).join(' ');
      const nxt2 = words.slice(wi + WIN * 2, wi + WIN * 3).join(' ');
      if (win === nxt1 && win === nxt2) {
        outWords.push(...words.slice(wi, wi + WIN));
        let wj = wi + WIN;
        while (wj + WIN <= words.length && words.slice(wj, wj + WIN).join(' ') === win) wj += WIN;
        wi = wj;
        continue;
      }
    }
    outWords.push(words[wi]);
    wi++;
  }
  return outWords.join(' ').trim();
}

/**
 * Extract the first meaningful sentence from article body text.
 * Done here (not by the LLM) so hallucination is impossible —
 * the LLM copies the Summary field, it doesn't generate it.
 */
function extractFirstSentence(text) {
  if (!text || text.length < 30) return '';
  // Match first sentence ending with ., ?, !, ।, or newline (min 20 chars to skip short stubs)
  const m = text.match(/^.{20,150}?[.?!।\n]/);
  if (m) return m[0].trim();
  // Fallback: cut at last space within 120 chars
  const cut = text.slice(0, 120);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * POST /api/query
 * Body: { question: string, topN?: number, hfApiKey?: string }
 * Returns: { articles: [...], context: string, stats: {...}, method: string }
 *
 * Two-phase retrieval:
 *   Phase 1 — Fast keyword search with Telugu→English expansion (instant).
 *   Phase 2 — HuggingFace semantic fallback when keyword score < 5.
 *             Model: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
 *             Supports Telugu natively — finds "India vs England ఫలితం?"
 *             even when no tags match. 2s timeout protects the widget's 3s limit.
 *
 * Body threshold ≥ 150 chars:
 *   Below this the LLM gets [HEADLINE ONLY] — no inventions from partial sentences.
 *   Above this the LLM may quote 1 sentence from Body (system prompt enforces this).
 */
async function queryArticles(req, res) {
  const { hfApiKey } = req.body;
  // Clamp topN to a sane integer — it flows into the cache key and result slice,
  // so a huge/garbage value would pollute the cache and bloat responses.
  const rawTopN = parseInt(req.body.topN, 10);
  const topN    = Number.isFinite(rawTopN) ? Math.min(Math.max(rawTopN, 1), 50) : 15;
  // Clamp question length — prevent very long queries from hogging keyword search
  const rawQ = req.body.question;
  if (!rawQ || !String(rawQ).trim()) {
    return res.status(400).json({ error: 'question is required' });
  }

  // Strip zero-width chars (ZWNJ, ZWJ, BOM) before validation — Telugu text uses them.
  // A string of only ZWNJs passes .trim() but tokenises to nothing, wasting an HF call.
  const question = String(rawQ).replace(/[​-‍﻿]/g, '').trim().slice(0, 500);
  if (!question || !/[\p{L}\p{N}]/u.test(question)) {
    return res.status(400).json({ error: 'question is required' });
  }

  const allStats = store.getStats();

  if (allStats.total === 0) {
    return res.json({
      articles: [],
      context:  null,
      stats:    allStats,
      message:  'No articles ingested today. Widget will use DOM-scraped content.',
    });
  }

  // ── Cache lookup ───────────────────────────────────────────────────────────
  const cacheKey = `${question}|${topN}`;
  const cached   = cacheGet(cacheKey);
  if (cached) {
    console.log(`[NewsAI Query] CACHE HIT "${question.slice(0, 50)}"`);
    return res.json({ ...cached, cached: true });
  }

  // ── Phase 1: Keyword search ────────────────────────────────────────────────
  let results  = store.queryArticles(question, topN);
  let method   = 'keyword';
  const topScore = results[0]?._score || 0;

  // ── Phase 2: Always-on hybrid semantic ────────────────────────────────────
  // Run hybrid scoring whenever embeddings exist, not just when keyword score is weak.
  // If HF is unavailable (cold start / circuit open), keyword results are kept.
  const embStats   = store.getEmbeddingStats();
  const hfReady    = Date.now() > hfSkipUntil;
  const shouldHybrid = embStats.withEmbedding > 0 && hfReady;

  if (shouldHybrid) {
    const apiKey   = hfApiKey || process.env.HF_API_KEY || null;
    // 2s timeout — if HF is cold/slow, fall through to keyword results gracefully
    const queryVec = await embedText(question, apiKey, 2000);

    if (queryVec) {
      hfFailCount = 0;  // success — reset circuit breaker
      const hybridResults = store.queryHybrid(question, queryVec, topN);
      if (hybridResults.length > 0) {
        results = hybridResults;
        method  = 'hybrid';
      }
    } else {
      // HF timed out or unavailable
      hfFailCount++;
      if (hfFailCount >= HF_FAIL_LIMIT) {
        hfSkipUntil = Date.now() + HF_SKIP_MS;
        hfFailCount = 0;
        console.warn('[NewsAI Query] HF circuit open — skipping semantic for 60s');
      }
    }
  }

  const embStats2 = store.getEmbeddingStats(); // re-fetch in case it changed during HF await
  console.log(
    `[NewsAI Query] "${question.slice(0, 50)}" → ${results.length}/${allStats.total} articles` +
    ` | top: ${topScore} | method: ${method}` +
    ` | embeds: ${embStats2.withEmbedding}/${embStats2.total}` +
    ` | hf-circuit: ${Date.now() < hfSkipUntil ? 'OPEN' : 'closed'}`
  );

  if (results.length === 0) {
    return res.json({
      articles: [],
      context:  null,
      stats:    allStats,
      message:  'No match found — widget will use full DOM-scraped content.',
    });
  }

  // ── Build focused context string ───────────────────────────────────────────
  // Body threshold: 150 chars. Below this → [HEADLINE ONLY] marker.
  // The system prompt rule: "if [HEADLINE ONLY]: print headline only, zero extra words."
  // For articles with ≥ 150 chars real content: LLM may copy 1 sentence from Body.
  const date  = new Date().toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric' });
  let context = `Today's articles | ${date} | ${results.length} relevant articles\n\n`;

  for (const a of results) {
    context += `Headline: ${a.title}\n`;
    const body = dedupContent(a.content || '');  // collapse CMS-introduced repetitions
    if (body && body.length >= 150) {
      // Pre-extract first sentence in code — LLM copies it, never generates it.
      const summary = extractFirstSentence(body);
      if (summary) context += `Summary: ${summary}\n`;
      context += `Body: ${body}\n`;
    } else {
      context += `Body: [HEADLINE ONLY — DO NOT ADD ANY DESCRIPTION]\n`;
    }
    if (a.url) context += `URL: ${a.url}\n`;
    context += '\n';
  }

  // Deduplicate by URL so the widget never shows the same article link twice
  // (can occur when Phase 1 + Phase 2 scrapes both ingest the same story)
  const seenUrls  = new Set();
  const dedupedResults = results.filter(a => {
    if (!a.url) return true;          // no URL — always include
    if (seenUrls.has(a.url)) return false;
    seenUrls.add(a.url);
    return true;
  });

  const result = { articles: dedupedResults, context, stats: allStats, method };
  cacheSet(cacheKey, result);  // cache for 1 hour
  res.json(result);
}

// Called at IST midnight reset to evict yesterday's cached answers
function clearQueryCache() {
  queryCache.clear();
  hfFailCount = 0;
  hfSkipUntil = 0;
}

module.exports = { queryArticles, clearQueryCache };
