'use strict';

const fetch   = require('node-fetch');
const cheerio = require('cheerio');

// Simple in-memory cache (30-minute TTL)
const CACHE = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * GET /api/scrape?url=NEWSPAPER_URL
 *
 * Fetches the newspaper homepage, extracts headlines + summaries using
 * common newspaper HTML patterns, and returns structured article objects.
 *
 * Returns: { articles: [{ headline, section, summary, url }] }
 */
async function scrape(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'url query param is required' });
  }

  // Check cache
  const cached = CACHE.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.json({ articles: cached.articles, cached: true });
  }

  let html;
  try {
    const response = await fetch(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsAI/1.0; +https://github.com/newsai)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
  } catch (err) {
    return res.status(400).json({ error: `Could not scrape page: ${err.message}` });
  }

  const articles = extractArticles(html, url);

  CACHE.set(url, { articles, ts: Date.now() });
  res.json({ articles });
}

/**
 * Extract article data from HTML using broad selector patterns.
 * Covers most newspaper CMSes (WordPress, custom, etc.).
 */
function extractArticles(html, baseUrl) {
  const $ = cheerio.load(html);
  const articles = [];
  const seen = new Set();

  // Selector priority list — tries each in order, stops when enough found
  const HEADLINE_SELECTORS = [
    'h1.story-title', 'h2.story-title', 'h3.story-title',
    'h1.article-title', 'h2.article-title', 'h3.article-title',
    '.headline a', '.story-headline a',
    'article h2 a', 'article h3 a',
    '.card-title a', '.news-title a',
    'h2 a', 'h3 a',
  ].join(', ');

  const SUMMARY_SELECTORS = [
    'p.story-summary', 'p.article-summary', 'p.description',
    '.story-intro p', '.article-intro p',
    'article p',
  ].join(', ');

  $(HEADLINE_SELECTORS).each((i, el) => {
    if (articles.length >= 40) return false;

    const $el = $(el);
    const headline = $el.text().trim();
    if (!headline || seen.has(headline) || headline.length < 8) return;
    seen.add(headline);

    const href = $el.is('a') ? $el.attr('href') : $el.find('a').first().attr('href');
    const articleUrl = href ? resolveUrl(href, baseUrl) : baseUrl;

    // Try to grab a summary near this element
    const $parent = $el.closest('article, .card, .story, .news-item, li');
    let summary = '';
    if ($parent.length) {
      summary = $parent.find(SUMMARY_SELECTORS).first().text().trim();
      if (!summary) summary = $parent.find('p').first().text().trim();
    }

    const section = detectSection($el, $parent);

    articles.push({
      headline,
      section,
      summary:     summary.slice(0, 300),
      body:        summary,
      url:         articleUrl,
      publishedAt: new Date().toISOString().slice(0, 10),
    });
  });

  return articles;
}

function detectSection($el, $parent) {
  // Look for a category/section label near the headline
  const label = $parent.find('.category, .section, .tag, .label').first().text().trim();
  if (label) return label;

  // Fallback: look in ancestor breadcrumbs
  const crumb = $el.closest('[class*="national"],[class*="sport"],[class*="business"],[class*="local"]')
                   .attr('class') || '';

  if (/national/i.test(crumb)) return 'National';
  if (/sport/i.test(crumb))    return 'Sports';
  if (/business|finance/i.test(crumb)) return 'Business';
  if (/local|state|city/i.test(crumb)) return 'State';
  return 'General';
}

function resolveUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch (_) {
    return href;
  }
}

module.exports = { scrape };
