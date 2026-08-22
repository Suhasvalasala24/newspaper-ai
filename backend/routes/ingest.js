'use strict';

const store = require('../store/articleStore');

const MAX_TITLE_LEN   = 500;
const MAX_SECTION_LEN = 100;
const MAX_CONTENT_LEN = 10000;  // 10 KB per article body
const MAX_URL_LEN     = 2000;
const MAX_TAGS        = 20;

// ── URL-based section override ────────────────────────────────────────────────
// Same logic as xml-ingest.js. Applied here because the widget DOM-scraper
// also uses this endpoint, and section labels from the DOM can be incorrect
// (e.g. Sakshi's Telangana articles may arrive as "General" or "National").
const URL_SECTION_MAP = [
  { paths: ['/telangana'],                         section: 'Telangana' },
  { paths: ['/andhra-pradesh', '/andhra/'],         section: 'Andhra Pradesh' },
  { paths: ['/sports', '/cricket/'],                section: 'Sports' },
  { paths: ['/movies', '/cinema', '/entertainmen'], section: 'Cinema' },
  { paths: ['/business', '/economy', '/finance'],   section: 'Business' },
  { paths: ['/national', '/india/'],                section: 'National' },
  { paths: ['/international', '/world/'],           section: 'International' },
  { paths: ['/politics', '/political'],             section: 'Politics' },
  { paths: ['/education'],                          section: 'Education' },
  { paths: ['/agriculture', '/farming'],            section: 'Agriculture' },
  { paths: ['/crime', '/police/', '/law/'],         section: 'Crime & Police' },
  { paths: ['/technology', '/tech/', '/cyber'],     section: 'Technology' },
  { paths: ['/health', '/medical'],                 section: 'Public Health' },
  { paths: ['/courts', '/legal', '/judiciary'],     section: 'Courts' },
  { paths: ['/railways', '/railway/', '/metro/'],   section: 'Railways' },
  { paths: ['/family', '/lifestyle'],               section: 'Family' },
  { paths: ['/women', '/mahila'],                   section: 'Women' },
];

function normalizeSectionFromUrl(url, rawSection) {
  if (url) {
    const path = url.toLowerCase();
    for (const entry of URL_SECTION_MAP) {
      if (entry.paths.some(p => path.includes(p))) return entry.section;
    }
  }
  return rawSection || 'General';
}

/** POST /api/ingest — add one article to today's edition */
function ingestArticle(req, res) {
  try {
    let { title, section, tags, content, url, language } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!section || typeof section !== 'string' || !section.trim()) {
      return res.status(400).json({ error: 'section is required' });
    }

    // Enforce size limits to prevent memory exhaustion
    title   = String(title).trim().slice(0, MAX_TITLE_LEN);
    section = String(section).trim().slice(0, MAX_SECTION_LEN);
    content = content ? String(content).slice(0, MAX_CONTENT_LEN) : '';
    url     = url     ? String(url).slice(0, MAX_URL_LEN) : '';
    language = language ? String(language).slice(0, 10) : 'te';
    if (Array.isArray(tags)) {
      tags = tags.slice(0, MAX_TAGS).map(t => String(t).slice(0, 100));
    } else {
      tags = [];
    }

    // Override section with URL-derived label when available — more reliable
    // than what the scraper/RSS provides (Sakshi often tags Telangana articles as General)
    const resolvedSection = normalizeSectionFromUrl(url, section);
    const totalBefore = store.getStats().total;
    const article = store.addArticle({ title, section: resolvedSection, tags, content, url, language });
    const stats   = store.getStats();
    // Only log new articles — suppresses the wall of duplicate "Added" lines during re-polls
    if (stats.total > totalBefore) {
      console.log(`[NewsAI Ingest] ✅ Added: "${title.slice(0, 60)}" [${resolvedSection}] | Total: ${stats.total}`);
    }
    res.json({ success: true, article, stats });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

/** GET /api/articles/today — list all articles for today */
function getToday(req, res) {
  const articles = store.getAllArticles();
  const stats    = store.getStats();
  const pendingIds = new Set((store.getArticlesForEmbedding() || []).map(a => a.id));
  // Strip the 384-float embedding vector and full body text — they are not needed by
  // consumers of this endpoint and add ~76 KB of floats + body text per 200 articles.
  const articlesWithFlag = articles.map(({ embedding: _emb, content: _body, ...rest }) => ({
    ...rest,
    hasEmbedding: !pendingIds.has(rest.id),
  }));
  res.json({ articles: articlesWithFlag, stats });
}

/**
 * GET /api/articles/breaking-count — lightweight freshness check for the widget.
 * Returns only article IDs + addedAt for articles ingested in the last 15 minutes.
 * The widget's checkBreakingNews() polls this instead of /api/articles/today so it
 * avoids downloading all article text on a hot 5-min polling path.
 */
function getBreakingCount(req, res) {
  const FRESH_MS = 15 * 60 * 1000;   // 15-min freshness window
  const cutoff   = Date.now() - FRESH_MS;
  const breaking = store.getAllArticles()
    .filter(a => a.addedAt && new Date(a.addedAt).getTime() > cutoff)
    .map(a => ({ id: a.id, addedAt: a.addedAt, section: a.section }));
  res.json({ count: breaking.length, articles: breaking });
}

/** DELETE /api/articles/reset — clear today's edition */
function resetToday(req, res) {
  store.resetArticles();
  console.log('[NewsAI Ingest] 🔄 Articles reset for new edition');
  res.json({ success: true, message: 'Articles cleared. Ready for new edition.' });
}

/** POST /api/articles/sample — load sample Sakshi articles for demo */
function loadSample(req, res) {
  const count = store.loadSampleArticles();
  const stats  = store.getStats();
  console.log(`[NewsAI Ingest] 📰 Loaded ${count} sample articles`);
  res.json({ success: true, count, stats, articles: store.getAllArticles() });
}

module.exports = { ingestArticle, getToday, getBreakingCount, resetToday, loadSample };
