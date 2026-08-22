'use strict';

/**
 * Validates that a URL is safe to fetch (blocks SSRF: private IPs, metadata endpoints).
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

// Max XML body size to prevent ReDoS / memory exhaustion on huge feeds (5 MB)
const MAX_XML_BYTES = 5 * 1024 * 1024;

/**
 * XML Article Ingestion — Parses Sakshi's XML format and ingests into article store.
 *
 * Supports multiple XML structures common in newspaper CMSes:
 *   1. RSS/Atom feeds (title, description, category, link)
 *   2. Custom Sakshi/Telugu CMS format (story/article elements)
 *   3. NITF-style (body.head/body.content)
 *
 * Routes:
 *   POST /api/ingest-xml       — body: { xml: string }  — parse XML string and ingest
 *   POST /api/poll-xml         — body: { url, intervalMinutes? } — fetch XML from URL + optional auto-poll
 *   GET  /api/poll-xml/status  — last poll timestamp + article count
 */

const https = require('https');
const http  = require('http');
const store = require('../store/articleStore');

// ── Auto-embed helper ─────────────────────────────────────────────────────────
// Fires background embedding immediately after articles are ingested so
// semantic search is available for the first query instead of being a fallback.
// Wrapped in a lazy require to avoid circular deps at module load time.
function triggerAutoEmbed() {
  setImmediate(() => {
    try {
      const { embedArticles: _embed } = require('./embed');
      // Simulate a minimal req/res to call the existing function
      const fakeRes = {
        status: () => fakeRes,
        json:   () => {},
      };
      _embed({ body: {} }, fakeRes).catch(e => {
        console.warn('[NewsAI XML] Auto-embed failed:', e.message);
      });
    } catch (e) {
      console.warn('[NewsAI XML] Auto-embed error:', e.message);
    }
  });
}

// ── Post-ingest background jobs ───────────────────────────────────────────────
// Each runs in setImmediate to avoid blocking the HTTP response.
// Wrapped in lazy require to avoid circular deps at module load time.

function triggerCacheRefresh() {
  setImmediate(() => {
    try {
      const { refreshCache } = require('./gemini-cache');
      refreshCache().catch(e => console.warn('[NewsAI XML] Cache refresh failed:', e.message));
    } catch (e) {
      console.warn('[NewsAI XML] Cache refresh error:', e.message);
    }
  });
}

function triggerChipsBuild() {
  setImmediate(() => {
    try {
      const { buildChips } = require('./chips');
      buildChips(store.getAllArticles());
    } catch (e) {
      console.warn('[NewsAI XML] Chips build error:', e.message);
    }
  });
}

function triggerDigestGeneration() {
  setImmediate(() => {
    try {
      const { generateDigest } = require('./digest');
      generateDigest(store.getAllArticles()).catch(e =>
        console.warn('[NewsAI XML] Digest generation failed:', e.message)
      );
    } catch (e) {
      console.warn('[NewsAI XML] Digest generation error:', e.message);
    }
  });
}

// ── Poll state ──────────────────────────────────────────────────────────────
let lastPollTime  = null;
let lastPollCount = 0;
let pollInterval  = null;

// ── Minimal XML text extractor (no external dependency) ────────────────────
// Returns first match for any of the given tag names.
function xmlTag(xml, ...tags) {
  for (const tag of tags) {
    // Match <tag> ... </tag> and <tag attr="..."> ... </tag>
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m  = xml.match(re);
    if (m) {
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')  // unwrap CDATA
        .replace(/<[^>]+>/g, ' ')                        // strip inner tags
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return '';
}

// Returns all outer matches of a tag (including the tag wrapper itself)
function xmlAll(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[0]);
  }
  return results;
}

// ── Image URL extractor from a single item's raw XML ─────────────────────────
function extractImageUrl(itemXml) {
  // Strategy 1: <media:content url="..."> or <media:content url='...'>
  let m = itemXml.match(/<media:content[^>]+url=["']([^"']+)["']/i);
  if (m) return m[1];

  // Strategy 2: <enclosure url="..." type="image/...">
  m = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]+type=["']image\//i);
  if (!m) m = itemXml.match(/<enclosure[^>]+type=["']image\/[^"']*["'][^>]+url=["']([^"']+)["']/i);
  if (m) return m[1];

  // Strategy 3: <media:thumbnail url="...">
  m = itemXml.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
  if (m) return m[1];

  // Strategy 4: <thumbnail>url</thumbnail> or <image><url>...</url></image>
  m = itemXml.match(/<thumbnail>([^<]+)<\/thumbnail>/i);
  if (m) return m[1].trim();
  m = itemXml.match(/<image[^>]*>[\s\S]*?<url>([^<]+)<\/url>/i);
  if (m) return m[1].trim();

  // Strategy 5: first <img src="..."> in description/content (skip 1×1 tracker pixels)
  m = itemXml.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (m) {
    // Skip pixel trackers (width=1 or height=1)
    const imgTag = m[0];
    if (/width=["']?1["']?/i.test(imgTag) || /height=["']?1["']?/i.test(imgTag)) return null;
    return m[1];
  }

  return null;
}

// Validate extracted image URL — must be http/https, reject data: and javascript:
function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return /^https?:\/\//i.test(url.trim());
}

// ── Core parser ─────────────────────────────────────────────────────────────
function parseXML(xmlString) {
  const articles = [];

  // ── Strategy 1: RSS <item> elements ────────────────────────────────────────
  const rssItems = xmlAll(xmlString, 'item');
  if (rssItems.length > 0) {
    for (const item of rssItems) {
      const title    = xmlTag(item, 'title');
      const content  = xmlTag(item, 'content:encoded', 'content', 'description', 'summary');
      const section  = xmlTag(item, 'category', 'section', 'cat');
      const url      = xmlTag(item, 'link', 'guid', 'url');
      const pubDate  = xmlTag(item, 'pubDate', 'pubdate', 'dc:date', 'published');
      const rawImg   = extractImageUrl(item);
      const imageUrl = isValidImageUrl(rawImg) ? rawImg : null;
      if (title && title.length > 3) {
        articles.push({ title, section: section || 'General', content, url, publishedAt: pubDate, imageUrl });
      }
    }
    if (articles.length) return articles;
  }

  // ── Strategy 2: Atom <entry> elements ──────────────────────────────────────
  const entries = xmlAll(xmlString, 'entry');
  if (entries.length > 0) {
    for (const entry of entries) {
      const title    = xmlTag(entry, 'title');
      const content  = xmlTag(entry, 'content', 'summary');
      const section  = xmlTag(entry, 'category');
      const url      = xmlTag(entry, 'id', 'link');
      const rawImg   = extractImageUrl(entry);
      const imageUrl = isValidImageUrl(rawImg) ? rawImg : null;
      if (title) articles.push({ title, section: section || 'General', content, url, publishedAt: '', imageUrl });
    }
    if (articles.length) return articles;
  }

  // ── Strategy 3: Custom Sakshi/newspaper CMS formats ───────────────────────
  // Try common Telugu CMS element names, ordered by likelihood
  const customTags = ['story', 'article', 'news_item', 'newsitem', 'Story', 'Article',
                      'news', 'News', 'item_detail', 'storydetail', 'articledetail'];
  for (const tag of customTags) {
    const items = xmlAll(xmlString, tag);
    if (!items.length) continue;
    for (const item of items) {
      const title   = xmlTag(item, 'headline', 'title', 'head', 'storyhead', 'Headline',
                             'Title', 'ArticleTitle', 'storytitle', 'newstitle', 'header');
      const content = xmlTag(item, 'body', 'content', 'description', 'storybody', 'text',
                             'Body', 'Content', 'articleBody', 'storybody', 'articlecontent',
                             'fullcontent', 'detail');
      const section = xmlTag(item, 'section', 'category', 'cat', 'topic', 'Section',
                             'Category', 'channel', 'Channel', 'pageName', 'pagename');
      const url     = xmlTag(item, 'url', 'link', 'articleurl', 'storyurl', 'Url', 'Link',
                             'articleLink', 'storyLink', 'weburl', 'permalink');
      const pubDate = xmlTag(item, 'publishedAt', 'pubdate', 'date', 'datetime', 'PublishedAt',
                             'publishdate', 'created_date', 'storydate', 'newsdate');
      const rawImg  = extractImageUrl(item);
      const imageUrl = isValidImageUrl(rawImg) ? rawImg : null;
      if (title && title.length > 3) {
        articles.push({ title, section: section || 'General', content, url, publishedAt: pubDate, imageUrl });
      }
    }
    if (articles.length) return articles;
  }

  console.warn('[NewsAI XML] No known element structure found in XML');
  return articles;
}

// ── Ingest parsed articles into the article store ──────────────────────────
function ingestArticles(parsed) {
  let count = 0;
  for (const a of parsed) {
    if (!a.title || a.title.length < 3) continue;
    try {
      // Use URL path to detect section — more reliable than RSS <category> which
      // Sakshi often returns as "General" or "National" regardless of the actual section.
      const resolvedSection = normalizeSectionFromUrl(a.url, a.section);
      store.addArticle({
        title:    a.title,
        section:  resolvedSection,
        tags:     [`#${resolvedSection.toLowerCase().replace(/[\s&]+/g, '')}`],
        content:  (a.content || '').slice(0, 2000),
        url:      a.url || '',
        language: detectLanguage(a.title),
        imageUrl: a.imageUrl || null,
      });
      count++;
    } catch (e) {
      console.warn('[NewsAI XML] Failed to ingest article:', e.message);
    }
  }
  return count;
}

// Simple Telugu script detector
function detectLanguage(text) {
  const teluguChars = (text.match(/[ఀ-౿]/g) || []).length;
  return teluguChars > 2 ? 'te' : 'en';
}

// ── URL-based section detection ────────────────────────────────────────────────
// Sakshi URL pattern: sakshi.com/telugu-news/{section}/{slug}-{id}
// Many Telugu CMS feeds tag all articles as "General" or "National" in the RSS
// <category> field, even when the URL path clearly identifies the section.
// This function detects the true section from the URL path and overrides the
// RSS-supplied category when a more specific match is found.
const URL_SECTION_MAP = [
  { paths: ['/telangana'],                        section: 'Telangana' },
  { paths: ['/andhra-pradesh', '/andhra/'],        section: 'Andhra Pradesh' },
  { paths: ['/sports', '/cricket/'],               section: 'Sports' },
  { paths: ['/movies', '/cinema', '/entertainmen'],section: 'Cinema' },
  { paths: ['/business', '/economy', '/finance'],  section: 'Business' },
  { paths: ['/national', '/india/'],               section: 'National' },
  { paths: ['/international', '/world/'],          section: 'International' },
  { paths: ['/politics', '/political'],            section: 'Politics' },
  { paths: ['/education'],                         section: 'Education' },
  { paths: ['/agriculture', '/farming'],           section: 'Agriculture' },
  { paths: ['/crime', '/police/', '/law/'],        section: 'Crime & Police' },
  { paths: ['/technology', '/tech/', '/cyber'],    section: 'Technology' },
  { paths: ['/health', '/medical'],                section: 'Public Health' },
  { paths: ['/courts', '/legal', '/judiciary'],    section: 'Courts' },
  { paths: ['/railways', '/railway/', '/metro/'],  section: 'Railways' },
  { paths: ['/family', '/lifestyle'],              section: 'Family' },
  { paths: ['/women', '/mahila'],                  section: 'Women' },
];

/**
 * Returns the best section label for an article.
 * Prefers URL-derived section over RSS-supplied category (which is often wrong).
 * Falls back to rawSection, then 'General'.
 */
function normalizeSectionFromUrl(url, rawSection) {
  if (url) {
    const path = url.toLowerCase();
    for (const entry of URL_SECTION_MAP) {
      if (entry.paths.some(p => path.includes(p))) return entry.section;
    }
  }
  return rawSection || 'General';
}

// ── Fetch XML from a remote URL ────────────────────────────────────────────
function fetchXML(url, _redirectsLeft = 2) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req    = client.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirects — ALWAYS re-validate the new URL through isSafeUrl()
        // Prevents SSRF via redirect: attacker's server can redirect to 169.254.169.254
        if (_redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        let absolute;
        try {
          absolute = new URL(res.headers.location, url).href; // resolve relative redirects
        } catch (_) {
          return reject(new Error(`Invalid redirect location: ${res.headers.location}`));
        }
        if (!isSafeUrl(absolute)) {
          return reject(new Error(`Redirect to unsafe URL blocked: ${absolute}`));
        }
        return resolve(fetchXML(absolute, _redirectsLeft - 1));
      }
      let data = '';
      let size = 0;
      // Decode as a UTF-8 stream — `data += chunk` on raw Buffers converts each
      // chunk independently, corrupting multibyte Telugu characters that get
      // split across chunk boundaries (they become U+FFFD replacement chars).
      res.setEncoding('utf8');
      res.on('data', chunk => {
        size += Buffer.byteLength(chunk); // chunk is a string now — count bytes, not chars
        if (size > MAX_XML_BYTES) {
          req.destroy();
          return reject(new Error('XML response too large (max 5 MB)'));
        }
        data += chunk;
      });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('XML fetch timed out after 15s')); });
  });
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/ingest-xml
 * Body: { xml: string }
 */
async function ingestXML(req, res) {
  const { xml } = req.body;
  if (!xml || typeof xml !== 'string' || xml.trim().length < 10) {
    return res.status(400).json({ error: '"xml" string is required in the request body' });
  }
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    return res.status(413).json({ error: `XML too large (max ${MAX_XML_BYTES / 1024 / 1024} MB)` });
  }

  const parsed   = parseXML(xml);
  const ingested = ingestArticles(parsed);
  const stats    = store.getStats ? store.getStats() : {};

  console.log(`[NewsAI XML] Direct ingest: parsed=${parsed.length}, ingested=${ingested}`);
  res.json({ parsed: parsed.length, ingested, stats, message: `Ingested ${ingested} articles` });

  // Fire all background jobs after ingest
  if (ingested > 0) {
    triggerAutoEmbed();
    triggerCacheRefresh();
    triggerChipsBuild();
    triggerDigestGeneration();
  }
}

/**
 * POST /api/poll-xml
 * Body: { url: string, intervalMinutes?: number }
 * Does an immediate fetch + optionally sets up a recurring poll.
 */
async function pollXML(req, res) {
  const { url, intervalMinutes } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: '"url" is required in the request body' });
  }
  if (!isSafeUrl(url)) {
    return res.status(400).json({ error: 'Invalid or unsafe URL' });
  }

  // Immediate fetch
  let ingested = 0;
  let parsed   = 0;
  try {
    const xml   = await fetchXML(url);
    const items = parseXML(xml);
    ingested    = ingestArticles(items);
    parsed      = items.length;
    lastPollTime  = new Date().toISOString();
    lastPollCount = ingested;
    console.log(`[NewsAI XML] Poll from ${url}: parsed=${parsed}, ingested=${ingested}`);
    // Fire all background jobs after successful poll
    if (ingested > 0) {
      triggerAutoEmbed();
      triggerCacheRefresh();
      triggerChipsBuild();
      triggerDigestGeneration();
    }
  } catch (err) {
    return res.status(502).json({ error: `Poll failed: ${err.message}` });
  }

  // Schedule recurring poll if requested
  if (intervalMinutes && intervalMinutes > 0) {
    if (pollInterval) clearInterval(pollInterval);
    const ms = intervalMinutes * 60 * 1000;
    pollInterval = setInterval(async () => {
      try {
        const xml   = await fetchXML(url);
        const items = parseXML(xml);
        const n     = ingestArticles(items);
        lastPollTime  = new Date().toISOString();
        lastPollCount = n;
        console.log(`[NewsAI XML] Auto-poll from ${url}: ${n} new articles`);
        if (n > 0) {
          triggerAutoEmbed();
          triggerCacheRefresh();
          triggerChipsBuild();
          triggerDigestGeneration();
        }
      } catch (e) {
        console.error('[NewsAI XML] Auto-poll error:', e.message);
      }
    }, ms);
    console.log(`[NewsAI XML] Auto-poll scheduled every ${intervalMinutes} min for ${url}`);
  }

  res.json({
    parsed,
    ingested,
    lastPollTime,
    scheduledEvery: intervalMinutes ? `${intervalMinutes} min` : null,
    message: `Poll successful — ${ingested} articles ingested`,
  });
}

/**
 * GET /api/poll-xml/status
 */
function pollStatus(req, res) {
  res.json({
    lastPollTime,
    lastPollCount,
    autoPolling: !!pollInterval,
    stats: store.getStats ? store.getStats() : {},
  });
}

/**
 * Programmatic helper — fetch, parse, and ingest from a URL without needing an
 * Express req/res pair. Used by server.js for background 30-min auto-refresh.
 * Returns { parsed, ingested } or throws on network/parse failure.
 */
async function pollFromUrl(url) {
  if (!isSafeUrl(url)) throw new Error(`Blocked unsafe URL: ${url}`);
  const xml   = await fetchXML(url);
  const items = parseXML(xml);
  const n     = ingestArticles(items);
  lastPollTime  = new Date().toISOString();
  lastPollCount = n;
  if (n > 0) {
    triggerAutoEmbed();
    triggerCacheRefresh();
    triggerChipsBuild();
    triggerDigestGeneration();
  }
  return { parsed: items.length, ingested: n };
}

module.exports = { ingestXML, pollXML, pollStatus, pollFromUrl };
