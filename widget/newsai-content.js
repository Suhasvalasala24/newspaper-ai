/**
 * NewsAI Content Ingestion
 * Fetches today's newspaper content from the configured source
 * and builds window.NewsAI.todayContent (a string injected into the system prompt).
 *
 * Supported contentSource.type values:
 *   "rss"    — Parse an RSS XML feed (fully implemented)
 *   "api"    — Fetch a JSON endpoint returning { articles: [...] }
 *   "pdf"    — POST to local backend /api/ingest-pdf
 *   "scrape" — GET from local backend /api/scrape
 */
(function () {
  'use strict';

  window.NewsAI = window.NewsAI || {};
  window.NewsAI.sectionPagesReady = false; // set true when section pages postMessage arrives

  const BACKEND_URL = 'http://localhost:3001';
  const MAX_FULL_ARTICLES = 8;    // full body for top enriched articles
  const DEFAULT_CONTENT_CHARS = 4500; // Groq llama-3.1-8b-instant has 131k context — 4500 chars ≈ 1100 tokens, well within budget
  const GEMINI_CONTENT_CHARS  = 10000; // Gemini 2.0 Flash has 1M context — give it rich detail
  const ENRICH_COUNT = 8;         // enrich top 8 articles with full body text
  const MAX_BODY_CHARS = 600;     // 600 chars per article ≈ 4-5 sentences of real content

  const getContentBudget = () => (window.NewsAI && window.NewsAI.contentBudget) || DEFAULT_CONTENT_CHARS;

  // ─── Main entry point ──────────────────────────────────────────────────────
  /**
   * Loads content, sets window.NewsAI.todayContent + window.NewsAI.articles.
   * For the extension preloaded path, also kicks off a background enrichment
   * that fetches full article pages to get body text + journalist names.
   */
  async function loadContent(config) {
    const src = config.contentSource || {};
    let articles = [];

    // ── Extension path: articles were pre-scraped from the page DOM ───────────
    if (window.NewsAIConfig && window.NewsAIConfig.preloadedContent) {
      articles = window.NewsAIConfig.preloadedArticles || [];
      console.log(`[NewsAI] ✅ Using ${articles.length} pre-loaded articles from page DOM.`);

      // Set a fast initial context right away so the widget is usable immediately
      window.NewsAI.articles = articles;
      window.NewsAI.todayContent = buildContextString(articles, config);

      // Then enrich in the background — fetches each article page for full text
      enrichArticlesInBackground(articles, config);

      return articles;
    }

    // ── Network paths (RSS / API / PDF / Scrape) ──────────────────────────────
    try {
      switch (src.type) {
        case 'api':    articles = await loadFromApi(src);    break;
        case 'pdf':    articles = await loadFromPdf(src);    break;
        case 'scrape': articles = await loadFromScrape(src); break;
        case 'rss':
        default:       articles = await loadFromRss(src);    break;
      }
    } catch (err) {
      console.warn('[NewsAI Content] Load failed:', err.message);
    }

    window.NewsAI.articles = articles;
    window.NewsAI.todayContent = buildContextString(articles, config);

    if (articles.length > 0) {
      console.log(`[NewsAI] ✅ Loaded ${articles.length} articles from ${src.type}`);
    } else {
      console.warn('[NewsAI] ⚠️ No articles loaded — AI will not have newspaper content.');
    }

    return articles;
  }

  // ─── Date freshness filter ────────────────────────────────────────────────
  function todayLocalISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * Returns true only if the article is DEFINITIVELY from an older day.
   * Unknown date → returns false (safe default = include).
   */
  function isDefinitelyOldArticle(article) {
    const today = todayLocalISO();

    if (article.publishedAt) {
      try {
        const pubDate = new Date(article.publishedAt);
        if (!isNaN(pubDate)) {
          const pubISO = `${pubDate.getFullYear()}-${String(pubDate.getMonth() + 1).padStart(2, '0')}-${String(pubDate.getDate()).padStart(2, '0')}`;
          return pubISO !== today;
        }
      } catch (_) {}
    }

    const url = article.url || '';
    const slashDate = today.replace(/-/g, '/');
    const matchSlash = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
    if (matchSlash) {
      return `${matchSlash[1]}/${matchSlash[2]}/${matchSlash[3]}` !== slashDate;
    }
    const compactDate = today.replace(/-/g, '');
    const matchCompact = url.match(/\/(\d{8})\//);
    if (matchCompact) {
      return matchCompact[1] !== compactDate;
    }

    return false;  // can't determine — include
  }

  // ─── Background article enrichment ────────────────────────────────────────
  /**
   * Fetches the full page for the top ENRICH_COUNT articles.
   * Extracts: full body text, journalist name, publication time.
   * Silently updates window.NewsAI.todayContent when done — no UI disruption.
   */
  async function enrichArticlesInBackground(articles, config) {
    // Section-aware enrichment: 2 articles per section first, then fill remainder positionally.
    // Ensures Sports/Cinema (which appear late on homepage) get body text.
    const eligible = articles.filter(a => a.url && a.url.startsWith('http') && !a.url.includes(window.location.hostname + '#'));
    const bySection = {};
    for (const a of eligible) {
      const sec = a.section || 'General';
      (bySection[sec] = bySection[sec] || []).push(a);
    }
    const selected = new Set();
    for (const items of Object.values(bySection)) {
      items.slice(0, 2).forEach(a => selected.add(a));
    }
    for (const a of eligible) {
      if (selected.size >= ENRICH_COUNT) break;
      selected.add(a);
    }
    const toEnrich = [...selected].slice(0, ENRICH_COUNT);

    if (!toEnrich.length) return;

    console.log(`[NewsAI] 🔄 Enriching ${toEnrich.length} articles in background...`);

    const results = await Promise.allSettled(
      toEnrich.map(article => fetchArticleDetail(article))
    );

    let enriched = 0;
    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value) {
        const { body, author, publishedAt } = result.value;
        if (body)        toEnrich[i].body        = body;
        if (author)      toEnrich[i].author      = author;
        if (publishedAt) toEnrich[i].publishedAt = publishedAt;
        if (body) enriched++;
      }
    });

    // After enrichment, publishedAt is now set on enriched articles.
    // Filter out articles definitively from an older day.
    const beforeCount = articles.length;
    const freshArticles = articles.filter(a => !isDefinitelyOldArticle(a));
    const removedCount = beforeCount - freshArticles.length;
    if (removedCount > 0) {
      console.log(`[NewsAI] 📅 Date filter: removed ${removedCount} old article(s) — keeping ${freshArticles.length} from today.`);
      window.NewsAI.articles = freshArticles;
    }

    // Rebuild the context string with enriched, today-only articles
    window.NewsAI.todayContent = buildContextString(window.NewsAI.articles || articles, config);
    console.log(`[NewsAI] ✅ Enrichment done — ${enriched}/${toEnrich.length} articles got full text.`);

    // Re-push to backend now that body text is available.
    // Reset the count so ingestToBackend doesn't skip this call.
    if (window.NewsAI && enriched > 0) {
      window.NewsAI._backendIngestCount = 0;
      ingestToBackend(window.NewsAI.articles || articles);
    }
  }

  /**
   * Fetches one article page and extracts body, author, and publish time.
   * Returns null on any failure (network error, timeout, CSP block, etc.).
   */
  async function fetchArticleDetail(article) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5 s max per article

      const resp = await fetch(article.url, {
        signal: controller.signal,
        credentials: 'omit',
        headers: { 'Accept': 'text/html' },
      });
      clearTimeout(timeout);

      if (!resp.ok) return null;
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      // ── Full body text ─────────────────────────────────────────────────────
      // Try progressively broader selectors common in Telugu/Indian news sites
      const bodySelectors = [
        '.story-body', '.article-body', '.article-content', '.story-content',
        '[class*="story-detail"]', '[class*="article-detail"]', '[class*="story-text"]',
        '[class*="content-body"]', '[class*="article-text"]',
        'article .content', 'article p', '.post-content',
      ];
      let body = '';
      for (const sel of bodySelectors) {
        const el = doc.querySelector(sel);
        if (el) {
          // Remove script/style/ad nodes before grabbing text
          el.querySelectorAll('script, style, .ad, [class*="ad-"], iframe').forEach(n => n.remove());
          body = el.textContent.replace(/\s+/g, ' ').trim();
          if (body.length > 100) break; // got something meaningful
        }
      }
      // Fallback: collect all <p> tags inside <article> or <main>
      if (body.length < 100) {
        const container = doc.querySelector('article, main, [role="main"]');
        if (container) {
          body = Array.from(container.querySelectorAll('p'))
            .map(p => p.textContent.trim())
            .filter(t => t.length > 30)
            .join(' ')
            .trim();
        }
      }

      // ── Journalist / author name ───────────────────────────────────────────
      const authorSelectors = [
        '.author', '.byline', '[class*="author"]', '[class*="reporter"]',
        '[class*="journalist"]', '[class*="writer"]', '[rel="author"]',
        'meta[name="author"]', 'meta[property="article:author"]',
      ];
      let author = '';
      for (const sel of authorSelectors) {
        const el = doc.querySelector(sel);
        if (el) {
          author = (el.getAttribute('content') || el.textContent || '').trim()
            .replace(/^(by|written by|రిపోర్టర్|సంపాదకుడు)\s*/i, '');
          if (author.length > 1 && author.length < 80) break;
        }
      }

      // ── Publish time ───────────────────────────────────────────────────────
      const timeEl = doc.querySelector('time[datetime], meta[property="article:published_time"]');
      const publishedAt = timeEl
        ? (timeEl.getAttribute('datetime') || timeEl.getAttribute('content') || '')
        : '';

      return {
        body: body.slice(0, MAX_BODY_CHARS), // capped — keeps tokens low
        author: author.slice(0, 80),
        publishedAt,
      };
    } catch (_) {
      return null; // timeout, network error, CSP block — silently skip
    }
  }

  // ─── Mode 1: RSS ────────────────────────────────────────────────────────────
  async function loadFromRss(src) {
    if (!src.url) throw new Error('No RSS URL configured');

    let xmlText;

    // If URL is already our backend proxy (localhost), fetch directly — no double-proxying
    const isBackendProxy = src.url.includes('localhost') || src.url.includes('127.0.0.1');

    if (isBackendProxy) {
      const resp = await fetch(src.url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      xmlText = await resp.text();
    } else {
      // Try allorigins CORS proxy first, then direct as fallback
      try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(src.url)}`;
        const resp = await fetch(proxyUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        xmlText = json.contents;
      } catch (_) {
        const resp = await fetch(src.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        xmlText = await resp.text();
      }
    }

    return parseRss(xmlText);
  }

  function parseRss(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const items = Array.from(doc.querySelectorAll('item'));

    return items.map(item => {
      const getText = (tag) => item.querySelector(tag)?.textContent?.trim() || '';
      const categories = Array.from(item.querySelectorAll('category')).map(c => c.textContent.trim());

      return {
        headline:    getText('title'),
        section:     categories[0] || 'General',
        summary:     stripHtml(getText('description')),
        body:        stripHtml(getText('description')),
        url:         getText('link'),
        publishedAt: getText('pubDate'),
      };
    }).filter(a => a.headline);
  }

  // ─── Mode 2: API ────────────────────────────────────────────────────────────
  async function loadFromApi(src) {
    if (!src.endpoint) throw new Error('No API endpoint configured');

    const headers = { 'Content-Type': 'application/json' };
    if (src.apiKey) headers['Authorization'] = `Bearer ${src.apiKey}`;

    const resp = await fetch(src.endpoint, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    return (data.articles || []).map(a => ({
      headline:    a.headline || a.title || '',
      section:     a.section  || a.category || 'General',
      summary:     a.summary  || a.description || '',
      body:        a.body     || a.content || a.summary || '',
      url:         a.url      || a.link || '',
      publishedAt: a.publishedAt || a.date || '',
    })).filter(a => a.headline);
  }

  // ─── Mode 3: PDF (via backend) ─────────────────────────────────────────────
  async function loadFromPdf(src) {
    // TODO: implement full PDF handling
    // The backend endpoint /api/ingest-pdf handles text extraction via pdf-parse
    if (!src.pdfUrl) throw new Error('No pdfUrl configured');
    const resp = await fetch(`${BACKEND_URL}/api/ingest-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfUrl: src.pdfUrl }),
    });
    if (!resp.ok) throw new Error(`PDF ingest failed: HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.articles || [];
  }

  // ─── Mode 4: Scrape (via backend) ─────────────────────────────────────────
  async function loadFromScrape(src) {
    // TODO: implement full scrape handling
    // The backend endpoint /api/scrape handles cheerio-based extraction
    if (!src.scrapeUrl) throw new Error('No scrapeUrl configured');
    const url = `${BACKEND_URL}/api/scrape?url=${encodeURIComponent(src.scrapeUrl)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Scrape failed: HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.articles || [];
  }

  // ─── Build context string for AI ──────────────────────────────────────────
  // Format: bullet-per-article grouped by section — matches DIGEST/SECTION output format.
  // Budget is dynamic: 2200 chars for Groq (6k TPM), 6000 for Gemini (no TPM cap).
  function buildContextString(articles, config) {
    if (!articles.length) return '';  // empty → widget uses loading message fallback

    const budget = getContentBudget();
    const newspaper = (config && config.brand && config.brand.name) || 'Eenadu';
    const date = new Date().toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric' });
    const sections = groupBySection(articles);

    let out = `${newspaper} | ${date} | ${articles.length} articles\n\n`;
    let n = 0;

    // Phase 1: bullet-per-article grouped by section
    for (const [section, items] of Object.entries(sections)) {
      out += `${section}:\n`;
      for (const a of items) {
        n++;
        a._n = n;
        const summary = a.summary && a.summary.length > 10 ? a.summary.slice(0, 100) : '';
        const line = summary
          ? `• [${n}] ${a.headline.slice(0, 90)} — ${summary}\n`
          : `• [${n}] ${a.headline.slice(0, 90)}\n`;
        if (out.length + line.length > budget * 0.60) {
          out += `(${articles.length - n} more articles not shown)\n`;
          break;
        }
        out += line;
      }
      out += '\n';
      if (out.includes('more articles not shown')) break;
    }

    // Phase 2: full body text for enriched articles — enables DETAIL mode responses
    const enriched = articles.filter(a => a.body && a.body.length > 50).slice(0, MAX_FULL_ARTICLES);
    if (enriched.length && out.length < budget * 0.95) {
      out += 'FULL TEXT:\n';
      for (const a of enriched) {
        const entry = `[${a._n}] ${a.headline.slice(0, 70)}: ${a.body.slice(0, MAX_BODY_CHARS)}\n`;
        if (out.length + entry.length > budget) break;
        out += entry;
      }
    }

    return out;
  }

  function groupBySection(articles) {
    return articles.reduce((acc, a) => {
      const sec = a.section || 'General';
      (acc[sec] = acc[sec] || []).push(a);
      return acc;
    }, {});
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function stripHtml(html) {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ── Backend ingestion — fire-and-forget ──────────────────────────────────
  async function ingestToBackend(articles) {
    // Only re-ingest when we have MORE articles than the last ingest
    // (section pages arrive after Phase 1, 114 > 80 — we want the full set).
    if (window.NewsAI._backendIngestCount && articles.length <= window.NewsAI._backendIngestCount) return;
    window.NewsAI._backendIngestCount = articles.length;

    try {
      // Reset in-memory store so stale articles from a previous page-load don't linger
      await fetch(`${BACKEND_URL}/api/articles/reset`, { method: 'DELETE' }).catch(() => {});

      // Batch-ingest all articles in parallel — instant (in-memory, no body-fetching)
      let ingested = 0;
      await Promise.all(articles.map(async (a) => {
        try {
          const resp = await fetch(`${BACKEND_URL}/api/ingest`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              title:    a.headline || a.title || '',
              section:  a.section  || 'General',
              tags:     [a.section || 'General'],
              content:  (a.body || a.bodyTe || a.summary || '').slice(0, 800),
              url:      a.url  || '',
              language: 'te',
            }),
          });
          if (resp.ok) ingested++;
        } catch (_) {}
      }));

      if (window.NewsAI) window.NewsAI.backendReady = true;
      console.log(`[NewsAI] ✅ Backend: ingested ${ingested}/${articles.length} articles`);
      const statsResp = await fetch(`${BACKEND_URL}/api/articles/today`).catch(() => null);
      if (statsResp && statsResp.ok) {
        const { stats } = await statsResp.json();
        console.log('[NewsAI] Backend sections:', JSON.stringify(stats.bySection));
      }

      // ── Trigger HuggingFace semantic embedding (fire-and-forget) ──────────
      // Embeds all article titles+content via sentence-transformers multilingual model.
      // Runs in background on the backend — responds immediately with 202 Accepted.
      // Once done, /api/query uses hybrid keyword+semantic search for Telugu queries
      // that don't map to exact keyword matches (e.g. "India vs England ఫలితం?").
      const cfg = window.NewsAI && window.NewsAI.config;
      fetch(`${BACKEND_URL}/api/embed`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ hfApiKey: cfg && cfg.hfApiKey }),
      }).then(r => r.json())
        .then(d => console.log(`[NewsAI] 🔮 HF embed triggered: ${d.message}`))
        .catch(() => {/* non-critical — keyword search still works */});
    } catch (_) {
      console.log('[NewsAI] Backend not available — using DOM-scraped content.');
    }
  }

  // Expose
  window.NewsAI.loadContent = loadContent;

  // ── Phase 2 content refresh from content.js (via postMessage) ─────────────
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'NEWSAI_CONTENT_REFRESH') return;
    let articles = event.data.articles || [];
    if (!articles.length || !window.NewsAI) return;

    const before = articles.length;
    articles = articles.filter(a => !isDefinitelyOldArticle(a));
    if (articles.length < before) {
      console.log(`[NewsAI] 📅 Phase 2 date filter: kept ${articles.length}/${before} articles from today's URLs.`);
    }

    const config = (window.NewsAIConfig && window.NewsAIConfig.config) || {};
    window.NewsAI.articles        = articles;
    window.NewsAI.todayContent    = buildContextString(articles, config);
    window.NewsAI.sectionPagesReady = true; // unblocks section-specific queries in widget
    console.log(`[NewsAI] Content refreshed via postMessage: ${articles.length} articles`);

    // Auto-ingest to backend (once per day, fire-and-forget)
    ingestToBackend(articles);

    // Browser-side enrichment in parallel
    enrichArticlesInBackground(articles, config);
  });
})();
