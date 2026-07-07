'use strict';

/**
 * POST /api/ingest-today
 *
 * Receives the full scraped articles array from newsai-content.js,
 * fetches the FULL BODY TEXT for every article in parallel batches,
 * then saves the complete briefing to disk via briefingStore.
 *
 * This runs ONCE per day (idempotent — skips if today's briefing exists).
 * Use ?force=1 to re-ingest even if a briefing already exists today.
 *
 * Body: { articles: [{ headline, section, url, body? }] }
 *
 * Response: { success, cached, stats, message }
 */

const fetch   = require('node-fetch');
const briefing = require('../store/briefingStore');

const BATCH_SIZE   = 8;     // fetch 8 articles simultaneously
const FETCH_TIMEOUT = 8000; // 8 s per article page
const MAX_BODY_CHARS = 1200; // keep body within token budget

// ── HTML body extractor ────────────────────────────────────────────────────

/**
 * Strips HTML tags and returns plain text from the most likely article body
 * element. Uses a cascade of CSS-class patterns common in Indian news sites.
 */
function extractBodyText(html) {
  // Remove noise blocks first
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Remove Sakshi.com news ticker blocks — these appear on every article page
  // and contain multiple headlines separated by ".." that contaminate the body.
  // Pattern: <ul>/<div> containing multiple <li>/<p> ticker headlines.
  html = html
    .replace(/<[^>]*class="[^"]*(?:ticker|scroll-news|breaking-ticker|news-ticker|marquee)[^"]*"[^>]*>[\s\S]*?<\/(?:ul|div|marquee)>/gi, '')
    .replace(/<marquee[\s\S]*?<\/marquee>/gi, '');

  // Priority selectors — match the outermost container, then strip inner tags.
  // Ordered from most-specific (Drupal field classes) to least-specific.
  const patterns = [
    // Schema.org structured data (works on any modern CMS)
    /<[^>]+itemprop="articleBody"[^>]*>([\s\S]*?)<\/(?:div|article|section)>/i,
    // Sakshi.com / Drupal 10 specific field classes
    /<(?:div|section)[^>]*class="[^"]*(?:field--name-body|field--type-text-with-summary|sakshi-full-story|full-story|fullstory|story-full|detail-content|news-detail|article-full-text|story-detail)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/i,
    // Common Telugu / Indian news sites
    /<(?:div|section)[^>]*class="[^"]*(?:story-body|article-body|article-content|story-content|content-body|article-text|news-body|post-content|entry-content)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/i,
    // Generic <article> element
    /<article[^>]*>([\s\S]*?)<\/article>/i,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > 100) return text.slice(0, MAX_BODY_CHARS);
    }
  }

  // Fallback: harvest <p> tags, but skip ticker-like paragraphs.
  // Ticker paragraphs contain multiple headlines separated by ".." and are
  // typically short bursts of text with 3+ occurrences of "..".
  const paragraphs = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRe.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length < 40) continue;

    // Skip ticker lines: multiple short headlines joined by ".." (3+ dots sequences)
    const dotDotCount = (text.match(/\.\./g) || []).length;
    if (dotDotCount >= 3) continue;

    // Skip "సాక్షి, <city>:" prefix lines (Sakshi.com section preview blurbs)
    if (/^సాక్షి,\s/.test(text) && text.length < 120) continue;

    paragraphs.push(text);
    if (paragraphs.join(' ').length > MAX_BODY_CHARS) break;
  }

  return paragraphs.join(' ').slice(0, MAX_BODY_CHARS).trim();
}

/**
 * Also extracts publishedAt from <time datetime="..."> or article:published_time meta.
 */
function extractPublishedAt(html) {
  const timeRe = /<time[^>]+datetime="([^"]+)"/i;
  const metaRe = /<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/i;
  const m = html.match(timeRe) || html.match(metaRe);
  return m ? m[1] : '';
}

// ── Per-article fetcher ────────────────────────────────────────────────────

async function fetchArticleBody(article) {
  if (!article.url || !article.url.startsWith('http')) return article;

  // Skip if body is already good (from DOM enrichment)
  if ((article.body || '').length > 200) return article;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const resp = await fetch(article.url, {
      signal:  controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsAI/1.0)',
        'Accept':     'text/html',
      },
    });
    clearTimeout(timer);

    if (!resp.ok) return article;

    const html       = await resp.text();
    const body       = extractBodyText(html);
    const publishedAt = article.publishedAt || extractPublishedAt(html);

    return { ...article, body: body || article.body || '', publishedAt };
  } catch (_) {
    // Network error / timeout / CSP — keep original
    return article;
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

async function ingestToday(req, res) {
  const { articles } = req.body;
  const force = req.query.force === '1';

  if (!articles || !Array.isArray(articles) || articles.length === 0) {
    return res.status(400).json({ error: 'articles array required in body' });
  }

  // Idempotent: skip if we already have a good briefing for today
  if (!force && briefing.hasToday()) {
    const existing = briefing.load();
    console.log(`[Ingest] Today's briefing already exists (${existing.length} articles). Skipping. Use ?force=1 to re-ingest.`);
    return res.json({
      success: true,
      cached:  true,
      message: `Already have ${existing.length} articles for today. Pass ?force=1 to re-ingest.`,
      stats:   briefing.getStats(existing),
    });
  }

  console.log(`[Ingest] Starting full-body ingestion of ${articles.length} articles...`);
  const startTime = Date.now();

  // Batch-fetch bodies in parallel
  const enriched = [];
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch   = articles.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(fetchArticleBody));
    enriched.push(...results);
    console.log(`[Ingest] Fetched ${Math.min(i + BATCH_SIZE, articles.length)} / ${articles.length}`);
  }

  // Save to disk
  briefing.save(enriched);
  const stats = briefing.getStats(enriched);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`[Ingest] ✅ Done in ${elapsed}s — ${stats.total} articles, ${stats.withBody} with body text`);
  console.log('[Ingest] Sections:', JSON.stringify(stats.bySection));

  res.json({
    success: true,
    cached:  false,
    elapsed: `${elapsed}s`,
    stats,
    message: `Ingested ${stats.total} articles (${stats.withBody} with full text) in ${elapsed}s.`,
  });
}

/**
 * GET /api/briefing/status — check if today's briefing is ready
 */
function briefingStatus(req, res) {
  const articles = briefing.load();
  const stats    = briefing.getStats(articles);
  res.json({
    ready:   articles.length > 0,
    stats,
    dates:   briefing.listDates(),
  });
}

module.exports = { ingestToday, briefingStatus };
