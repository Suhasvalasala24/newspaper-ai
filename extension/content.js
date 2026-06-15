/**
 * NewsAI Extension — Content Script for eenadu.net
 *
 * Strategy: Instead of fetching an RSS feed, we read the articles that are
 * ALREADY on the page (eenadu.net is loaded right in front of us).
 * This is 100% reliable and needs no backend or external API.
 *
 * Two-phase scraping:
 *   Phase 1 — immediate scrape on page load.
 *   Phase 2 — re-scrape after 4 s to catch dynamically loaded content,
 *              then push updates to the widget via postMessage.
 */
(function () {
  'use strict';

  if (window.__newsaiInjected) return;
  window.__newsaiInjected = true;

  // ── 1. Scrape articles from the already-loaded eenadu.net DOM ──────────────
  function extractPageArticles() {
    const articles = [];
    const seen = new Set();

    // Selectors — eenadu.net specific first, then generic fallbacks.
    // Order matters: more specific selectors run first; loop breaks at 30 articles.
    const SELECTORS = [
      // eenadu.net / Telugu news site patterns
      '.story-title a', '.storydesc a', '.storycard a',
      '[class*="story"] a', '[class*="headline"] a',
      '[class*="news-head"] a', '[class*="newshead"] a',
      '[class*="heading"] a', '[class*="hed"] a',
      // Internal article links (works on any Indian news site)
      'a[href*="/story/"]', 'a[href*="/news/"]', 'a[href*="/article/"]',
      'a[href*="eenadu.net/"]',
      // Generic patterns
      '[class*="news"] h2 a', '[class*="news"] h3 a',
      '[class*="title"] a',
      'article h2 a', 'article h3 a', 'article h1 a',
      '.card-title a', '.entry-title a',
      'h2.title a', 'h3.title a',
      // Broad fallback — catches any headlined link
      'h1 a', 'h2 a', 'h3 a', 'h4 a',
    ];

    // Section map — ordered specific → general. First match wins.
    const SECTION_MAP = [
      // Courts (before Crime so court judgments don't get lumped with police news)
      { re: /supreme court|high court|sessions court|district court|judge|verdict|judgment|bail denied|acquitted|convicted|petition|contempt|\bHC\b|\bSC\b/i, s: 'Courts' },
      // Crime & Police
      { re: /murder|killed|robbery|theft|rape|fraud|scam|arrested|police|jail|custody|bail|warrant|chargesheet|suspect|investigation/i, s: 'Crime & Police' },
      // Women
      { re: /women|woman|girl|female|mahila|ladies|gender|self.help.group|\bSHG\b|domestic violence/i, s: 'Women' },
      // Lifestyle
      { re: /lifestyle|fashion|beauty|food recipe|travel|yoga|fitness|wellness/i, s: 'Lifestyle' },
      // Railways
      { re: /railway|train|\bmetro\b|rail|irctc|vande.bharat|express.train|locomotive/i, s: 'Railways' },
      // Aviation
      { re: /airport|aviation|airline|flight|aircraft|airbus|boeing|indigo|spicejet/i, s: 'Aviation' },
      // Roads & Buildings
      { re: /road|highway|flyover|overbridge|underpass|bridge|construction|expressway/i, s: 'Roads & Buildings' },
      // Irrigation
      { re: /irrigation|reservoir|dam|canal|water level|flood|project|godavari|krishna river/i, s: 'Irrigation' },
      // Local Bodies
      { re: /\bghmc\b|\bgvmc\b|municipality|municipal corporation|panchayat|\bward\b|\bmayor\b/i, s: 'Local Bodies' },
      // Public Administration
      { re: /collector|district administration|\bias\b|\bips\b|government order|\bgo\b|circular|welfare scheme|beneficiaries/i, s: 'Public Administration' },
      // Public Health
      { re: /health|hospital|doctor|disease|medicine|vaccine|surgery|cancer|dengue|malaria|covid|aarogya/i, s: 'Public Health' },
      // Education
      { re: /education|school|college|university|exam|student|admission|scholarship|eamcet|jee|neet/i, s: 'Education' },
      // Technology
      { re: /technology|software|\bai\b|artificial intelligence|internet|mobile|app|cyber|digital|startup|isro|nasa|satellite/i, s: 'Technology' },
      // Sports
      { re: /cricket|football|\bipl\b|sport|match|tournament|wicket|innings|\brun\b|player|team|league|trophy|fifa|olympic|badminton|boxing/i, s: 'Sports' },
      // Cinema
      { re: /cinema|film|movie|tollywood|bollywood|\bott\b|serial|television|album|actor|actress|director|release/i, s: 'Cinema' },
      // Business
      { re: /business|market|economy|sensex|nifty|stock|finance|budget|tax|\brbi\b|\bgdp\b|inflation|trade|import|export/i, s: 'Business' },
      // International
      { re: /international|world|global|america|russia|china|\busa\b|\buk\b|europe|pakistan|israel|\bwar\b|conflict|\bun\b|\bnato\b/i, s: 'International' },
      // Agriculture
      { re: /farmer|agriculture|crop|paddy|harvest|drought|ryot/i, s: 'Agriculture' },
      // Politics
      { re: /politics|political|election|vote|candidate|minister|parliament|assembly|party|manifesto/i, s: 'Politics' },
      // Andhra Pradesh (before generic National)
      { re: /andhra|amaravati|vijayawada|jagan|chandrababu|\btdp\b|\bysrcp\b|guntur|krishna|vizag|visakhapatnam/i, s: 'Andhra Pradesh' },
      // Telangana
      { re: /telangana|hyderabad|secunderabad|revanth|\bktr\b|\bbrs\b|warangal|nizamabad|karimnagar/i, s: 'Telangana' },
      // National
      { re: /national|india|parliament|delhi|central government|modi|\bbjp\b|congress/i, s: 'National' },
    ];

    // Telugu keyword overlays — run after English to catch Telugu-only headlines
    const TELUGU_MAP = [
      { re: /సుప్రీంకోర్టు|హైకోర్టు|జిల్లా కోర్టు|న్యాయమూర్తి|తీర్పు/, s: 'Courts' },
      { re: /నేరం|హత్య|దొంగతనం|అత్యాచారం|మోసం|పోలీసు|జైలు|అరెస్టు|నిందితుడు|దర్యాప్తు|వారెంట్/, s: 'Crime & Police' },
      { re: /మహిళ|స్త్రీ|మహిళలు|అమ్మాయి|స్వయం సహాయక సంఘం/, s: 'Women' },
      { re: /జీవనశైలి|ఫ్యాషన్|వంట|రెసిపీ|పర్యటన|యోగా|ఫిట్నెస్/, s: 'Lifestyle' },
      { re: /రైల్వే|రైలు|మెట్రో|వందే భారత్/, s: 'Railways' },
      { re: /విమానం|విమానాశ్రయం|ఏవియేషన్/, s: 'Aviation' },
      { re: /రహదారి|హైవే|ఫ్లైఓవర్|నిర్మాణం|వంతెన|ఓవర్బ్రిడ్జ్/, s: 'Roads & Buildings' },
      { re: /జలాశయం|డ్యామ్|కాలువ|నీటి మట్టం|వరద|ప్రాజెక్ట్|ఆనకట్ట|నీటి వనరులు/, s: 'Irrigation' },
      { re: /కార్పొరేషన్|నగరపాలక|పురపాలక|పంచాయతీ|వార్డు|మేయర్|మున్సిపల్/, s: 'Local Bodies' },
      { re: /అధికారి|కలెక్టర్|పరిపాలన|సంక్షేమం|పథకం|లబ్ధిదారులు|జీఓ/, s: 'Public Administration' },
      { re: /ఆరోగ్యం|వైద్యం|ఆసుపత్రి|వ్యాధి|మందు|టీకా|చికిత్స|డాక్టర్|రోగి/, s: 'Public Health' },
      { re: /విద్య|పాఠశాల|కళాశాల|విశ్వవిద్యాలయం|విద్యార్థి|పరీక్ష|ఫలితాలు|ర్యాంక్/, s: 'Education' },
      { re: /టెక్నాలజీ|సాంకేతిక|సైబర్|ఇంటర్నెట్|మొబైల్/, s: 'Technology' },
      { re: /క్రీడ|బ్యాటింగ్|బౌలింగ్|మ్యాచ్|టోర్నమెంట్|వికెట్|క్రికెట్|ఆటగాడు/, s: 'Sports' },
      { re: /సినిమా|నటుడు|నటి|దర్శకుడు|రిలీజ్|పాట|వినోదం|హీరో|హీరోయిన్/, s: 'Cinema' },
      { re: /వ్యాపారం|ఆర్థిక|బ్యాంక్|షేర్|మార్కెట్|బడ్జెట్|పన్ను/, s: 'Business' },
      { re: /విదేశీ|అంతర్జాతీయ|యుద్ధం|అమెరికా|రష్యా|చైనా|యూరప్/, s: 'International' },
      { re: /వ్యవసాయం|రైతు|పంట|కరువు|సాగు|నీటిపారుదల/, s: 'Agriculture' },
      { re: /రాజకీయ|ఎన్నికలు|మంత్రి|నేత|పార్టీ|శాసనసభ|ముఖ్యమంత్రి|గవర్నర్/, s: 'Politics' },
      { re: /ఆంధ్ర|అమరావతి|విజయవాడ|జగన్|చంద్రబాబు|విజయవాడ|విజాగ్/, s: 'Andhra Pradesh' },
      { re: /హైదరాబాద్|తెలంగాణ|సికింద్రాబాద్|రేవంత్|కేటీఆర్|బీఆర్ఎస్|వరంగల్/, s: 'Telangana' },
      { re: /కేంద్ర|లోక్సభ|రాజ్యసభ|భారత్|కేంద్ర ప్రభుత్వం/, s: 'National' },
    ];

    function getSection(text, el) {
      // 1. Check parent element's CSS class or data attribute for section hint
      const sectionEl = el.closest('[class*="section"], [class*="category"], [class*="topic"], [data-section], [data-category]');
      if (sectionEl) {
        const label = (sectionEl.dataset.section || sectionEl.dataset.category || sectionEl.className || '').toLowerCase();
        for (const { re, s } of SECTION_MAP) { if (re.test(label)) return s; }
      }
      // 2. English keyword match on headline
      for (const { re, s } of SECTION_MAP) { if (re.test(text)) return s; }
      // 3. Telugu keyword match on headline
      for (const { re, s } of TELUGU_MAP) { if (re.test(text)) return s; }
      return 'General';
    }

    for (const selector of SELECTORS) {
      try {
        document.querySelectorAll(selector).forEach(el => {
          if (articles.length >= 80) return;

          const anchor = el.tagName === 'A' ? el : el.querySelector('a');
          const headline = (anchor || el).textContent.replace(/\s+/g, ' ').trim();
          // Min length 10 to skip nav labels; max 300 to skip concatenated junk
          if (!headline || headline.length < 10 || headline.length > 300) return;
          if (seen.has(headline)) return;
          seen.add(headline);

          const href = anchor?.href || '';
          // Skip nav/anchor-only links that stay on the same page
          if (href && href.startsWith('#')) return;

          const parent = el.closest('article, [class*="card"], [class*="story"], [class*="item"], li, .col') || el.parentElement;
          const summary = parent ? (
            parent.querySelector('p')?.textContent?.trim() ||
            parent.querySelector('[class*="desc"], [class*="summary"], [class*="intro"], [class*="excerpt"]')?.textContent?.trim() ||
            ''
          ) : '';

          const authorEl = parent
            ? parent.querySelector('.author, .byline, [class*="author"], [class*="reporter"], [class*="journalist"]')
            : null;
          const author = authorEl ? authorEl.textContent.trim().replace(/^by\s*/i, '') : '';

          articles.push({
            headline,
            section:     getSection(headline, el),
            summary:     summary.slice(0, 300),
            body:        summary,
            author:      author.slice(0, 80),
            url:         href || window.location.href,
            publishedAt: new Date().toISOString().slice(0, 10),
          });
        });
      } catch (_) {}

      if (articles.length >= 40) break;
    }

    return articles;
  }

  // ── 2. Build the content string for the AI ─────────────────────────────────
  function buildContentString(articles) {
    if (!articles.length) return '';
    const bySection = {};
    articles.forEach(a => { (bySection[a.section] = bySection[a.section] || []).push(a); });

    let out = `[${window.location.hostname} | ${new Date().toLocaleDateString()}]\n\n`;
    let count = 0;
    for (const [section, items] of Object.entries(bySection)) {
      out += `\n=== ${section.toUpperCase()} ===\n`;
      items.forEach(a => {
        count++;
        out += `[${count}] ${a.headline}\n`;
        if (a.summary) out += `  ${a.summary.slice(0, 200)}\n`;
        if (a.url && a.url !== window.location.href) out += `  Link: ${a.url}\n`;
      });
    }
    return out;
  }

  // ── 3. Load API key from chrome.storage ───────────────────────────────────
  function getStoredKey() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get(['newsai_groq_key'], result => {
          resolve((result && result.newsai_groq_key) || '');
        });
      } catch (e) {
        console.warn('[NewsAI] chrome.storage unavailable:', e.message);
        resolve('');
      }
    });
  }

  // ── 4. Inject CSS ──────────────────────────────────────────────────────────
  function injectStyle() {
    if (document.getElementById('newsai-styles')) return;
    const link = document.createElement('link');
    link.id = 'newsai-styles';
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('widget/newsai-widget.css');
    document.head.appendChild(link);
  }

  // ── 5. Inject a script file into the main world ────────────────────────────
  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      (document.head || document.documentElement).appendChild(s);
    });
  }

  // ── 6. Push a content refresh to the main-world widget via postMessage ─────
  function pushContentRefresh(articles) {
    // postMessage crosses the extension isolated-world / main-world boundary.
    // newsai-content.js in the main world listens for this and updates NewsAI.todayContent.
    try {
      window.postMessage({
        type:     'NEWSAI_CONTENT_REFRESH',
        articles: articles,
        hostname: window.location.hostname,
      }, window.location.origin || '*');
    } catch (e) {
      console.warn('[NewsAI] postMessage failed:', e.message);
    }
  }

  // ── Detect LLM provider from key prefix ───────────────────────────────────
  function detectProvider(key) {
    if (!key) return 'groq';
    if (key.startsWith('AIza'))    return 'gemini';
    if (key.startsWith('sk-ant-')) return 'anthropic';
    return 'groq'; // gsk_* or unknown
  }

  // ── 7. Main init ──────────────────────────────────────────────────────────
  async function init() {
    const apiKey = await getStoredKey();

    // Phase 1 — immediate scrape with whatever is in the DOM right now
    const articles = extractPageArticles();
    const todayContent = buildContentString(articles);

    console.log(`[NewsAI] Phase 1 scrape: ${articles.length} articles`);
    if (articles.length === 0) {
      console.warn('[NewsAI] No articles found — will retry in 4 s.');
    }

    const ALL_SECTIONS = [
      'National', 'Telangana', 'Andhra Pradesh', 'International',
      'Sports', 'Business', 'Cinema', 'Politics',
      'Crime & Police', 'Courts', 'Education', 'Public Health',
      'Technology', 'Agriculture', 'Women', 'Lifestyle',
      'Railways', 'Aviation', 'Roads & Buildings', 'Irrigation',
      'Local Bodies', 'Public Administration',
    ];

    const configPayload = {
      config: {
        brand: {
          name: 'Eenadu AI',
          shortName: 'E',
          primaryColor: '#C0392B',
          welcomeMessage: 'నమస్కారం! నేను ఈనాడు AI. ఈ రోజు పేపర్ గురించి ఏదైనా అడగండి!',
          welcomeMessageEn: "Hello! I'm your Eenadu AI assistant. Ask me anything about today's paper!",
        },
        languages:       ['te', 'en'],
        defaultLanguage: 'te',
        sections:        ALL_SECTIONS,
        contentSource:   { type: 'preloaded' },
        apiKey:          apiKey,   // provider-agnostic field; widget detects provider from prefix
        llmModel:        'llama-3.1-8b-instant',
        position:        'bottom-right',
      },
      preloadedContent:  todayContent,
      preloadedArticles: articles,
    };

    // sessionStorage bridge: content script (isolated world) → injected scripts (main world)
    try {
      sessionStorage.setItem('newsai_bridge_config', JSON.stringify(configPayload));
    } catch (e) {
      console.warn('[NewsAI] sessionStorage write failed:', e.message);
    }
    document.documentElement.setAttribute('data-newsai-config', JSON.stringify(configPayload));

    injectStyle();
    await injectScript(chrome.runtime.getURL('widget/newsai-config-loader.js'));
    await injectScript(chrome.runtime.getURL('widget/newsai-content.js'));
    await injectScript(chrome.runtime.getURL('widget/newsai-widget.js'));

    // Phase 2 — re-scrape after 4 s to catch dynamically rendered articles.
    // Push an update whenever we got at least as many articles as before —
    // the content may have changed even if the count is the same.
    setTimeout(() => {
      const fresh = extractPageArticles();
      console.log(`[NewsAI] Phase 2 scrape: ${fresh.length} articles (was ${articles.length})`);
      if (fresh.length >= articles.length && fresh.length > 0) {
        pushContentRefresh(fresh);
      }
    }, 4000);
  }

  // Wait for page to be fully loaded so DOM scraping gets all articles
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
