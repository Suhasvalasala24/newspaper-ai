'use strict';

/**
 * articleStore.js — In-memory article store with tag index and keyword search.
 *
 * Articles are stored per day. At midnight (or on manual reset) today's
 * articles are cleared and the store is ready for a new edition.
 *
 * Retrieval uses a fast keyword scoring algorithm:
 *   - Tag match    → highest score (exact section hit)
 *   - Title match  → high score
 *   - Content match → proportional to frequency
 * This means NO external embedding API is needed — retrieval is instant.
 */

const articles = [];   // { id, title, section, tags[], content, url, language, addedAt, embedding }
let articleCounter = 0;

// ── Stopwords to ignore during keyword scoring ─────────────────────────────
const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','in','on','at','to','for','of',
  'and','or','but','with','this','that','it','its','he','she','they',
  'we','i','you','be','been','has','have','had','do','does','did',
  'will','would','could','should','may','can','not','no','so','if',
  // Common Telugu romanisations that add noise
  'lo','ki','ga','te','ni','ku','ko','nu',
]);

// ── Telugu → English section expansion ────────────────────────────────────
// Mirrors EVERY Telugu trigger + body keyword from the widget's TOPIC_FILTERS.
// When user asks in Telugu, these tokens get expanded to English section names
// so the keyword scorer can match articles tagged with English section labels.
// Covers all 22 sections — add new entries here whenever new sections are added.
const TELUGU_SECTION_MAP = [
  // Sports / క్రీడలు
  { tokens: ['క్రీడ','క్రీడలు','స్పోర్ట్స్','క్రికెట్','ఆట','ఆటలు','మ్యాచ్','ఫుట్బాల్','కబడ్డీ','హాకీ','టెన్నిస్','బ్యాడ్మింటన్','బాక్సింగ్','ఒలింపిక్స్','టోర్నమెంట్','లీగ్','వ్యాయామం','ఐపీఎల్','వికెట్','ఆటగాడు','మెడల్','ట్రోఫీ','చాంపియన్','స్కోర్','సెంచరీ','హాఫ్‌సెంచరీ'], section: 'Sports' },

  // Cinema / సినిమా
  { tokens: ['సినిమా','సినిమాలు','వినోదం','టాలీవుడ్','నటుడు','నటి','చిత్రం','ఓటీటీ','మూవీ','హీరో','హీరోయిన్','దర్శకుడు','రిలీజ్','ట్రైలర్','టీజర్','బాలీవుడ్'], section: 'Cinema' },

  // Telangana / తెలంగాణ
  { tokens: ['తెలంగాణ','హైదరాబాద్','సికింద్రాబాద్','వరంగల్','నిజామాబాద్','కరీంనగర్','రేవంత్','కేటీఆర్','రంగారెడ్డి','ఖమ్మం','నల్లగొండ','మహబూబ్‌నగర్','ఆదిలాబాద్','సిద్దిపేట'], section: 'Telangana' },

  // Andhra Pradesh / ఆంధ్రప్రదేశ్
  { tokens: ['ఆంధ్ర','అమరావతి','విజయవాడ','విజాగ్','విశాఖపట్నం','చంద్రబాబు','జగన్','వైఎస్సార్','వైఎస్సార్సీపీ','వైఎస్‌ జగన్','పవన్ కళ్యాణ్','నెల్లూరు','గుంటూరు','తిరుపతి','ఏపీ','ఏపి','కాకినాడ','రాజమండ్రి','కర్నూలు','పల్నాడు','ప్రకాశం','శ్రీకాకుళం','ఏలూరు','కోనసీమ','ఒంగోలు'], section: 'Andhra Pradesh' },

  // National / జాతీయం
  { tokens: ['జాతీయ','భారత్','ఢిల్లీ','కేంద్ర','కేంద్రం','మోదీ','పార్లమెంట్','లోక్‌సభ','రాజ్యసభ','బీజేపీ','కాంగ్రెస్','కేంద్ర ప్రభుత్వం'], section: 'National' },

  // International / అంతర్జాతీయం
  { tokens: ['అంతర్జాతీయ','ప్రపంచం','అమెరికా','చైనా','రష్యా','విదేశీ','యుద్ధం','ఇరాన్','ఇజ్రాయెల్','పాకిస్తాన్','ట్రంప్','బైడెన్','యూఎన్','నాటో'], section: 'International' },

  // Business / వ్యాపారం
  { tokens: ['వ్యాపారం','ఆర్థిక','మార్కెట్','సెన్సెక్స్','బడ్జెట్','షేర్','ఆర్‌బీఐ','నిఫ్టీ','జీడీపీ','జీఎస్టీ','పన్ను','కంపెనీ','పెట్టుబడి','డాలర్','బంగారం'], section: 'Business' },

  // Politics / రాజకీయాలు
  { tokens: ['రాజకీయ','రాజకీయాలు','ఎన్నికలు','మంత్రి','పార్టీ','ముఖ్యమంత్రి','అసెంబ్లీ','ఎమ్మెల్యే','ఎంపీ','ప్రచారం','ఓటు','ఎమ్మెల్సీ','రాజ్యాంగం'], section: 'Politics' },

  // Agriculture / వ్యవసాయం
  { tokens: ['రైతు','వ్యవసాయం','వ్యవసాయ','పంట','రైతన్న','కిసాన్','సాగు','ఎరువు','కరువు','వరి','పత్తి','విత్తనాలు','పంటల','బీమా','కూలీలు','మత్స్యకార','మత్స్య','మత్స్యపరిశ్రమ','జాలర','జాలర్లు','చేపల','మీనుల'], section: 'Agriculture' },

  // Education / విద్య
  { tokens: ['విద్య','పాఠశాల','కళాశాల','విద్యార్థి','విద్యార్థులు','పరీక్ష','పరీక్షలు','ఫలితాలు','ఎంసెట్','ఎంట్రన్స్','అడ్మిషన్','అడ్మిషన్లు','నీట్','జేఈఈ','విశ్వవిద్యాలయం'], section: 'Education' },

  // Public Health / ఆరోగ్యం
  { tokens: ['ఆరోగ్యం','వైద్యం','ఆసుపత్రి','వ్యాధి','డాక్టర్','వ్యాక్సిన్','వైరస్','వైద్యుడు','మందులు','చికిత్స','రోగి','నేత్ర','క్యాన్సర్'], section: 'Public Health' },

  // Crime & Police / నేరాలు
  { tokens: ['నేరం','నేరాలు','పోలీసు','హత్య','అరెస్టు','మోసం','దొంగతనం','క్రైమ్','దాడి','బాధితుడు','లాకప్','కేసు','నిందితుడు','అత్యాచారం','అపహరణ'], section: 'Crime & Police' },

  // Technology / సాంకేతిక
  { tokens: ['సాంకేతిక','సాంకేతికత','సైబర్','టెక్','మొబైల్','యాప్','ఇంటర్నెట్','డిజిటల్','ఏఐ','సాఫ్ట్‌వేర్','హ్యాకింగ్','స్మార్ట్‌ఫోన్','కృత్రిమ మేధ'], section: 'Technology' },

  // Courts / న్యాయస్థానం
  { tokens: ['న్యాయస్థానం','హైకోర్టు','సుప్రీంకోర్టు','తీర్పు','న్యాయమూర్తి','బెయిల్','పిటిషన్','విచారణ','జడ్జి','వాదన','కోర్టు'], section: 'Courts' },

  // Railways / రైల్వే
  { tokens: ['రైల్వే','రైలు','మెట్రో','వందేభారత్','ట్రెయిన్','స్టేషన్','ఐఆర్‌సీటీసీ','రైల్వే స్టేషన్'], section: 'Railways' },

  // Aviation / విమానాలు
  { tokens: ['విమానం','విమానాశ్రయం','ఫ్లైట్','పైలట్','ఎయిర్‌లైన్','ఇండిగో','స్పైస్‌జెట్','ఎయిర్‌పోర్ట్'], section: 'Aviation' },

  // Women / మహిళలు
  { tokens: ['మహిళ','మహిళలు','స్త్రీ','అమ్మాయి','వరకట్నం','గృహహింస','స్వయం సహాయ సంఘం','ఎస్‌హెచ్‌జి'], section: 'Women' },

  // Irrigation / నీటిపారుదల
  { tokens: ['నీటిపారుదల','డ్యామ్','జలాశయం','వరద','కాలువ','గోదావరి','కృష్ణా','నీటి','ప్రాజెక్ట్','పోలవరం','జలవనరులు'], section: 'Irrigation' },

  // Roads & Buildings / రహదారులు
  { tokens: ['రహదారి','హైవే','ఫ్లైఓవర్','వంతెన','రోడ్డు','ఎక్స్‌ప్రెస్‌వే','నిర్మాణం','భవనం','గుంతలు'], section: 'Roads & Buildings' },

  // Local Bodies / స్థానిక సంస్థలు
  { tokens: ['కార్పొరేషన్','నగరపాలక','పంచాయతీ','మేయర్','వార్డు','జీహెచ్ఎంసీ','జీవీఎంసీ','కౌన్సిలర్','స్థానిక సంస్థ'], section: 'Local Bodies' },

  // Lifestyle / జీవనశైలి
  { tokens: ['జీవనశైలి','ఫ్యాషన్','వంట','ప్రయాణం','యోగా','ఫిట్నెస్','అందం','ఆహారం','ఆరోగ్య చిట్కాలు','సౌందర్యం'], section: 'Lifestyle' },

  // Public Administration / పరిపాలన
  { tokens: ['కలెక్టర్','పరిపాలన','సంక్షేమం','పథకం','లబ్ధిదారులు','ఉత్తర్వు','జీఓ','ప్రభుత్వ','అధికారి','తహసీల్దార్','ఎంఈఓ'], section: 'Public Administration' },
];

/**
 * Expand Telugu query tokens to include English section names AND Telugu content keywords.
 *
 * Two expansions per matched section:
 *   1. English section name ("telangana", "sports", "crime", "police") — matches articles
 *      whose `section` or `tags` field was set to the English section name at ingest time.
 *   2. ALL Telugu tokens from that section's entry — matches articles whose title/body
 *      mentions Hyderabad, Warangal, KTR, etc. even if the section label is "General".
 *      This is essential because RSS feeds often mislabel Telangana articles as "National".
 *
 * e.g. "తెలంగాణ వార్తలు"
 *   → ["తెలంగాణ","వార్తలు","telangana","హైదరాబాద్","వరంగల్","కరీంనగర్","రేవంత్","కేటీఆర్",...]
 */
// ── English keyword → section mapping ────────────────────────────────────────
// Users often ask in English ("sports", "cricket", "cinema") while the AI pill
// is set to Telugu. The scorer only knows section names (English) and Telugu
// article tokens. Without this map, "sports" matches the section label but NOT
// the Telugu article titles (క్రికెట్, మ్యాచ్, ఐపీఎల్…) — giving weak results.
const ENGLISH_SECTION_KEYWORDS = {
  // Sports
  sports:'Sports', cricket:'Sports', football:'Sports', tennis:'Sports',
  badminton:'Sports', hockey:'Sports', kabaddi:'Sports', ipl:'Sports',
  olympics:'Sports', match:'Sports', tournament:'Sports', medals:'Sports',
  // Cinema
  cinema:'Cinema', movies:'Cinema', movie:'Cinema', tollywood:'Cinema',
  bollywood:'Cinema', ott:'Cinema', trailer:'Cinema', release:'Cinema',
  // Telangana
  telangana:'Telangana', hyderabad:'Telangana', secunderabad:'Telangana',
  // Andhra Pradesh
  andhra:'Andhra Pradesh', amaravati:'Andhra Pradesh', vijayawada:'Andhra Pradesh',
  visakhapatnam:'Andhra Pradesh', vizag:'Andhra Pradesh',
  // National
  national:'National', india:'National', delhi:'National', parliament:'National',
  // International
  international:'International', world:'International', global:'International',
  america:'International', russia:'International', china:'International',
  // Business
  business:'Business', economy:'Business', market:'Business', sensex:'Business',
  stock:'Business', finance:'Business', budget:'Business',
  // Politics
  politics:'Politics', election:'Politics', vote:'Politics', minister:'Politics',
  // Crime
  crime:'Crime & Police', police:'Crime & Police', arrest:'Crime & Police',
  murder:'Crime & Police', theft:'Crime & Police',
  // Education
  education:'Education', school:'Education', college:'Education',
  exam:'Education', results:'Education', admission:'Education',
  // Agriculture
  agriculture:'Agriculture', farming:'Agriculture', farmer:'Agriculture',
  crop:'Agriculture', paddy:'Agriculture',
  // Health
  health:'Public Health', hospital:'Public Health', doctor:'Public Health',
  vaccine:'Public Health', disease:'Public Health',
  // Technology
  technology:'Technology', tech:'Technology', cyber:'Technology',
  mobile:'Technology', internet:'Technology', digital:'Technology',
  // Courts
  court:'Courts', courts:'Courts', verdict:'Courts', judge:'Courts',
  // Railways
  railway:'Railways', railways:'Railways', train:'Railways', metro:'Railways',
};

/**
 * Expand query tokens to maximise article recall:
 *   1. Telugu tokens → English section name + all Telugu section keywords
 *   2. English keywords → matching section name + all Telugu section keywords
 * This makes "sports" retrieve articles titled in Telugu (క్రికెట్, మ్యాచ్…)
 * and "క్రికెట్" retrieve articles tagged with the English "Sports" label.
 */
function expandTeluguQuery(queryTokens) {
  const querySet = new Set(queryTokens);
  const extra = [];

  for (const token of queryTokens) {
    // ── Telugu token → match against TELUGU_SECTION_MAP ──────────────────
    for (const entry of TELUGU_SECTION_MAP) {
      if (entry.tokens.some(t => token.includes(t) || t.includes(token))) {
        extra.push(entry.section.toLowerCase());
        entry.section.toLowerCase().split(/[\s&]+/).forEach(w => { if (w.length > 2) extra.push(w); });
        entry.tokens.forEach(t => { if (t.length > 3 && !querySet.has(t)) extra.push(t); });
        break;
      }
    }

    // ── English keyword → look up ENGLISH_SECTION_KEYWORDS ───────────────
    const sectionName = ENGLISH_SECTION_KEYWORDS[token.toLowerCase()];
    if (sectionName) {
      extra.push(sectionName.toLowerCase());
      sectionName.toLowerCase().split(/[\s&]+/).forEach(w => { if (w.length > 2) extra.push(w); });
      const entry = TELUGU_SECTION_MAP.find(e => e.section === sectionName);
      if (entry) entry.tokens.forEach(t => { if (t.length > 3 && !querySet.has(t)) extra.push(t); });
    }
  }

  return [...queryTokens, ...extra];
}

/**
 * Auto-tag an article at ingest time by scanning its title + content
 * against every TELUGU_SECTION_MAP entry.
 *
 * Why: Sakshi's RSS feed often labels Telangana/Sports/Cinema articles as
 * "General" or "National". URL-based detection fixes the section field, but
 * content-based auto-tagging adds an extra tag (e.g. "#telangana") so the
 * article scores +20 on a tag hit instead of only +10 (title) or +2 (content)
 * when the user queries by section in Telugu.
 *
 * The combined text is NOT lowercased — Telugu script has no case, and the
 * TELUGU_SECTION_MAP tokens are already in the correct script for matching.
 * English tokens from the map are short (e.g. "telangana") and appear in
 * Telugu-language articles only when already transliterated — so no case clash.
 */
function autoTagArticle(section, title, content) {
  const combined  = (title || '') + ' ' + (content || '');
  const baseTag   = `#${section.toLowerCase().replace(/[\s&]+/g, '')}`;
  const tagSet    = new Set([baseTag]);

  for (const entry of TELUGU_SECTION_MAP) {
    // Skip if the article is already from this section — tag already added above
    if (entry.section.toLowerCase().replace(/[\s&]+/g,'') === section.toLowerCase().replace(/[\s&]+/g,'')) continue;

    if (entry.tokens.some(t => combined.includes(t))) {
      tagSet.add(`#${entry.section.toLowerCase().replace(/[\s&]+/g, '')}`);
    }
  }

  return [...tagSet];
}

// ── Title normalisation for dedup comparison ──────────────────────────────
// Strip zero-width characters (U+200B–200D, U+FEFF, NBSP), collapse whitespace,
// lowercase. Sakshi titles include U+200C (ZWNJ) after certain consonant clusters;
// an RSS copy omits it while the scraped copy keeps it — causing false mismatches.
function normForDedup(s) {
  return (s || '')
    .replace(/[​-‍﻿ ]/g, '')  // zero-width + NBSP
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ── Tokenise text into searchable keywords ─────────────────────────────────
function tokenise(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\sఀ-౿]/g, ' ')  // keep Telugu Unicode + word chars
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

// ── Score one article against query tokens ─────────────────────────────────
function scoreArticle(article, queryTokens) {
  if (!queryTokens.length) return 1; // no tokens → return everything

  let score = 0;
  const titleLower   = (article.title   || '').toLowerCase();
  const contentLower = (article.content || '').toLowerCase();
  const tagsLower    = article.tags.map(t => t.toLowerCase());
  const sectionLower = (article.section || '').toLowerCase();

  for (const token of queryTokens) {
    // Exact tag match — highest priority
    if (tagsLower.some(t => t.includes(token))) score += 20;

    // Section match
    if (sectionLower.includes(token)) score += 12;

    // Title match — each occurrence
    let idx = titleLower.indexOf(token);
    while (idx !== -1) { score += 10; idx = titleLower.indexOf(token, idx + 1); }

    // Content match — each occurrence (capped at 5 to avoid one-keyword flooding)
    let cnt = 0;
    let cidx = contentLower.indexOf(token);
    while (cidx !== -1 && cnt < 5) { score += 2; cnt++; cidx = contentLower.indexOf(token, cidx + 1); }
  }

  // ── Recency boost — breaking news surfaces above older stories ────────────
  // addedAt is an ISO string set at ingest time. Within today's reset window:
  //   <2 hours old → +8 pts  (just published / breaking)
  //   2–6 hours old → +4 pts  (recent)
  //   6+ hours old  → +0 pts  (standard)
  if (article.addedAt && score > 0) {
    const ageMs = Date.now() - new Date(article.addedAt).getTime();
    if (ageMs < 2 * 3600 * 1000)       score += 8;
    else if (ageMs < 6 * 3600 * 1000)  score += 4;
  }

  return score;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Add an article to today's edition.
 * Returns the stored article with its assigned id.
 */
function addArticle({ title, section, tags = [], content = '', url = '', language = 'te', imageUrl = null }) {
  if (!title || !section) throw new Error('title and section are required');

  // Deduplicate: XML auto-poll and per-pageload widget ingest re-send the same
  // articles repeatedly (Sakshi publishes ≤200/day but polls run every N minutes).
  // Without this the array grows unbounded with duplicates, and every duplicate
  // triggers a paid Sarvam TTS prefetch + HF embed. If the incoming copy has
  // richer content (post-enrichment re-push), update the stored article instead.
  const normTitle = normForDedup(title);
  const normUrl   = (url || '').trim();
  const existing  = articles.find(a =>
    normForDedup(a.title) === normTitle && (a.url === normUrl || (!a.url && !normUrl))
  );
  if (existing) {
    const newContent = (content || '').trim();
    if (newContent.length > (existing.content || '').length) {
      existing.content   = newContent;
      existing.embedding = null; // re-embed with the richer text

      // BUG FIX: previously tags were NEVER recomputed on the dedup path. An article
      // first ingested with a thin RSS summary got few auto-tags; when the enriched
      // full body arrived later it kept the stale tag set, so section queries that the
      // richer text would now match (e.g. "#telangana" from a Hyderabad mention deep in
      // the body) never fired. Re-run auto-tagging on the richer text and MERGE (never
      // drop caller/earlier tags — union only).
      const freshAuto = autoTagArticle(existing.section, existing.title, newContent);
      existing.tags   = [...new Set([...existing.tags, ...freshAuto])];
    }
    // Update imageUrl if we now have one and didn't before
    if (imageUrl && !existing.imageUrl) existing.imageUrl = imageUrl;
    return existing;
  }

  // Enrich tags: start with any caller-supplied tags, then auto-expand by
  // scanning title + content against TELUGU_SECTION_MAP. This means an article
  // about "హైదరాబాద్" labelled "General" still gets a "#telangana" tag, so
  // queries for "తెలంగాణ వార్తలు" score +20 (tag hit) instead of only +2 (content).
  const suppliedTags = Array.isArray(tags) ? tags : (tags ? [tags] : []);
  const autoTags     = autoTagArticle(section.trim(), title, content);
  const mergedTags   = [...new Set([...autoTags, ...suppliedTags])];

  const article = {
    id:        ++articleCounter,
    title:     title.trim(),
    section:   section.trim(),
    tags:      mergedTags,
    content:   content.trim(),
    url:       url.trim(),
    imageUrl:  imageUrl || null,
    language,
    addedAt:   new Date().toISOString(),
    embedding: null,   // set by /api/embed after HuggingFace batch-embedding
  };

  articles.push(article);
  return article;
}

/**
 * Return all articles for today.
 */
function getAllArticles() {
  return [...articles];
}

/**
 * Return stats grouped by section.
 */
function getStats() {
  const bySection = {};
  for (const a of articles) {
    bySection[a.section] = (bySection[a.section] || 0) + 1;
  }
  return { total: articles.length, bySection };
}

/**
 * Find the topN most relevant articles for a given question.
 * Uses keyword scoring — no API call required.
 */
function queryArticles(question, topN = 30) {
  if (!articles.length) return [];

  const queryTokens = expandTeluguQuery(tokenise(question));

  // Score every article
  const scored = articles.map(a => ({
    article: a,
    score:   scoreArticle(a, queryTokens),
  }));

  // Sort descending by score, return top N with score > 0
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(s => ({ ...s.article, _score: s.score }));
}

// ── Embedding / Semantic search (HuggingFace hybrid) ──────────────────────

/**
 * Store a 384-dim embedding vector on an article by ID.
 * Called by the /api/embed background job after HuggingFace processing.
 * Validates the vector to prevent NaN poisoning of cosine similarity.
 */
function setEmbedding(articleId, vector) {
  // Guard: reject malformed, zero-length, or NaN-containing vectors
  if (!Array.isArray(vector) || vector.length !== 384) return false;
  if (!vector.every(v => typeof v === 'number' && isFinite(v))) return false;
  const article = articles.find(a => a.id === articleId);
  if (article) { article.embedding = vector; return true; }
  return false;
}

/**
 * Return articles that don't yet have an embedding vector.
 * Each entry is { id, text } where text = title + section + first 200 chars of content.
 * The text field is what gets sent to HuggingFace for embedding.
 */
function getArticlesForEmbedding() {
  return articles
    .filter(a => !a.embedding)
    .map(a => ({
      id:   a.id,
      // Combine title + section + opening content for richer semantic signal.
      // 500 chars gives ~3–4 sentences — enough for MiniLM to understand the article's topic.
      text: `${a.title}. ${a.section}. ${(a.content || '').slice(0, 500)}`.trim(),
    }));
}

/**
 * Return embedding coverage stats.
 */
function getEmbeddingStats() {
  const withEmbedding = articles.filter(a => a.embedding).length;
  return {
    total:         articles.length,
    withEmbedding,
    coverage:      `${withEmbedding}/${articles.length}`,
    pct:           articles.length ? Math.round(100 * withEmbedding / articles.length) : 0,
  };
}

/**
 * Cosine similarity between two float arrays.
 * Returns value in [0, 1]; higher = more similar.
 * Guards against zero/NaN vectors which cause undefined sort order.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = normA * normB;  // guard: if either is zero vector, denom=0
  if (denom === 0) return 0;    // zero vector → no similarity (not NaN)
  return dot / Math.sqrt(denom);
}

/**
 * Hybrid keyword + semantic search.
 * Used when a plain query embedding is available (from HuggingFace at query time).
 *
 * Scoring:
 *   - Keyword score: 0–100+ (exact matches weighted heavily)
 *   - Semantic score: 0–1 (cosine similarity, scaled to 0–40)
 *   - When keyword score is low (<5), semantic weight is increased to 40
 *   - Combined = kwScore + semScore × weight
 *
 * @param {string} question  — The user's question (for keyword scoring)
 * @param {number[]} queryVector — 384-dim embedding from HuggingFace
 * @param {number} topN
 */
function queryHybrid(question, queryVector, topN = 8) {
  if (!articles.length) return [];

  const queryTokens    = expandTeluguQuery(tokenise(question));
  const hasEmbeddings  = articles.some(a => a.embedding);

  const scored = articles.map(a => {
    const kwScore  = scoreArticle(a, queryTokens);
    const semScore = (hasEmbeddings && queryVector && a.embedding)
      ? cosineSimilarity(queryVector, a.embedding)
      : 0;

    // Give semantic more weight when keyword score is weak
    const semWeight = kwScore < 5 ? 40 : 20;
    const combined  = kwScore + semScore * semWeight;

    return {
      ...a,
      _score:    combined,
      _kwScore:  kwScore,
      _semScore: semScore,
    };
  });

  return scored
    .filter(s => s._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, topN);
}

/**
 * Clear all articles (call at start of each new edition).
 */
function resetArticles() {
  articles.length = 0;
  articleCounter  = 0;
}

/**
 * Remove articles older than maxAgeHours.
 *
 * Called at the start of each doScrape() cycle so the store never accumulates
 * yesterday's articles across scrape intervals. Articles without an addedAt
 * timestamp are treated as old and removed (safe default).
 *
 * Returns { removed, remaining } for logging.
 */
function pruneOldArticles(maxAgeHours = 24) {
  const cutoff  = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const before  = articles.length;
  // Mutate in-place — splice backwards to avoid index shifting
  for (let i = articles.length - 1; i >= 0; i--) {
    const a = articles[i];
    const ts = a.addedAt ? new Date(a.addedAt).getTime() : 0;
    if (ts < cutoff) articles.splice(i, 1);
  }
  const removed   = before - articles.length;
  const remaining = articles.length;
  if (removed > 0) {
    console.log(`[NewsAI Store] 🗑️  Pruned ${removed} articles older than ${maxAgeHours}h — ${remaining} remain`);
  }
  return { removed, remaining };
}

// ── Disk persistence ──────────────────────────────────────────────────────────
// Saves the article store to a JSON file so articles survive backend restarts.
// Call saveToFile() after bulk ingests; loadFromFile() at server startup.

const fs   = require('fs');
const path = require('path');

function saveToFile(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Omit embedding vectors — they're large float arrays and HF re-generates them anyway.
    const slim = articles.map(a => {
      const { embedding: _, ...rest } = a;
      return rest;
    });
    fs.writeFileSync(filePath, JSON.stringify({ articles: slim, articleCounter }, null, 0), 'utf8');
    console.log(`[NewsAI Store] 💾 Saved ${slim.length} articles to disk`);
  } catch (err) {
    console.warn('[NewsAI Store] Save failed:', err.message);
  }
}

function loadFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const raw  = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.articles) || data.articles.length === 0) return 0;
    articles.length = 0;
    articleCounter  = typeof data.articleCounter === 'number' ? data.articleCounter : 0;
    for (const a of data.articles) {
      if (a && a.title && a.section) {
        articles.push({
          ...a,
          // Ensure tags is always an array — older/corrupted disk cache may omit it,
          // causing scoreArticle()'s tags.map() to throw and crash the /api/ai route.
          tags:      Array.isArray(a.tags) ? a.tags : [],
          embedding: null,
        });
      }
    }
    console.log(`[NewsAI Store] 📂 Loaded ${articles.length} articles from disk cache`);
    return articles.length;
  } catch (err) {
    console.warn('[NewsAI Store] Load failed:', err.message);
    return 0;
  }
}

function clearFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.log('[NewsAI Store] 🗑️  Disk cache cleared');
  } catch (err) {
    console.warn('[NewsAI Store] Clear file failed:', err.message);
  }
}

/**
 * Pre-load sample Sakshi articles for demo purposes.
 * Uses real article URLs and content sourced from sakshi.com (30 articles, 29-Jun-2026 edition).
 * URL pattern: https://www.sakshi.com/telugu-news/{section}/{english-slug}-{node-id}
 */
function loadSampleArticles() {
  resetArticles();
  const samples = [
    // ── Sports / క్రీడలు ─────────────────────────────────────────────────────
    {
      title:   'శ్రీలంకతో తొలి టెస్టు.. భారత్‌ బ్యాటింగ్‌',
      section: 'Sports',
      tags:    ['#sports', '#cricket', '#india', '#srilanka', '#test'],
      content: 'గాలే అంతర్జాతీయ స్టేడియంలో ధ్రువ్‌ జురెల్‌ సారథ్యంలో భారత్‌ ఏ జట్టు శ్రీలంక ఏ జట్టుతో తొలి అనధికారిక టెస్టు ప్రారంభించింది. టాస్‌ గెలిచి బ్యాటింగ్‌ ఎంచుకుంది. సాయి సుదర్శన్‌, రుతురాజ్‌ గైక్వాడ్‌, దేవదత్‌ పడిక్కల్‌ తదితరులు జట్టులో ఉన్నారు. వన్డే సిరీస్‌లో విజేతగా నిలిచిన భారత్‌ ఇప్పుడు టెస్టు సిరీస్‌లో పోటీ పడుతోంది.',
      url:     'https://www.sakshi.com/telugu-news/sports/ind-vs-sl-1st-unofficial-test-galle-india-won-toss-opt-bat-2825193',
      language: 'te',
    },
    {
      title:   'రాణించిన నితీశ్‌ రెడ్డి.. కరీంనగర్‌పై నల్గొండ గెలుపు',
      section: 'Sports',
      tags:    ['#sports', '#cricket', '#telangana', '#tg20'],
      content: 'TG20 లీగ్‌ 2026లో Anurag Nalgonda Knights కరీంనగర్‌ డైమండ్స్‌పై విజయం సాధించింది. నితీశ్‌ రెడ్డి అద్భుతమైన బ్యాటింగ్‌తో జట్టు విజయంలో కీలక పాత్ర పోషించాడు. తెలంగాణ క్రికెట్‌ అభిమానులకు రోమాంచకమైన మ్యాచ్‌ అందించారు.',
      url:     'https://www.sakshi.com/telugu-news/sports/tg20-league-2026-anurag-nalgonda-knights-beat-karimnagar-diamonds-2824348',
      language: 'te',
    },
    {
      title:   'లార్డ్స్‌ మైదానంలో సందడి చేసిన కోహ్లి-ధావన్‌ ఫ్యామిలీస్‌!',
      section: 'Sports',
      tags:    ['#sports', '#cricket', '#kohli', '#lords'],
      content: 'లండన్‌లోని లార్డ్స్‌ క్రికెట్‌ గ్రౌండ్‌లో విరాట్‌ కోహ్లి, శిఖర్‌ ధావన్‌ కుటుంబాలు కలసి స్టాండ్స్‌లో కూర్చొని మ్యాచ్‌ ఆనందించారు. ఫ్యామిలీ ఫోటోలు సోషల్‌ మీడియాలో వైరల్‌ అయ్యాయి. అభిమానులు వారి స్నేహాన్ని కొనియాడారు.',
      url:     'https://www.sakshi.com/telugu-news/sports/virat-kohli-shikhar-dhawan-lords-family-2828959',
      language: 'te',
    },
    // ── National / జాతీయం ────────────────────────────────────────────────────
    {
      title:   'ముంబై ఏసీ లోకల్‌ రైళ్లు: 12 కొత్త సర్వీసులు — ప్రయాణికుల నిరసన',
      section: 'National',
      tags:    ['#national', '#railway', '#mumbai', '#trains'],
      content: 'సెంట్రల్‌ రైల్వే మార్గంలో సోమవారం నుండి 12 కొత్త ఏసీ లోకల్‌ సర్వీసులు ప్రారంభమయ్యాయి. అయితే అధిక ధరలు, పాత రైళ్ల తగ్గింపు వల్ల ప్రయాణికులు తీవ్రంగా నిరసన వ్యక్తం చేశారు. రైల్వే మంత్రిత్వ శాఖ ఏసీ రైళ్లు ప్రజలకు మేలు చేస్తాయని సమర్థించింది.',
      url:     'https://www.sakshi.com/telugu-news/national/mumbai-ac-local-trains-12-new-services-full-details-2828883',
      language: 'te',
    },
    {
      title:   'మల్లికార్జున్‌ ఖర్గే రాజ్యసభ సభ్యునిగా ప్రమాణ స్వీకారం',
      section: 'National',
      tags:    ['#national', '#congress', '#kharge', '#rajyasabha'],
      content: 'న్యూఢిల్లీ: కాంగ్రెస్‌ జాతీయ అధ్యక్షుడు మల్లికార్జున్‌ ఖర్గే రాజ్యసభ సభ్యునిగా ప్రమాణ స్వీకారం చేశారు. కర్ణాటక నుండి ఎన్నికైన ఖర్గే ఈ పదవి స్వీకరించడం ప్రతిపక్ష పార్టీకి ముఖ్యమైన క్షణం. రాజ్యసభలో కాంగ్రెస్‌ బలోపేతం అవుతుందని అంచనా.',
      url:     'https://www.sakshi.com/telugu-news/national/mallikarjun-kharge-takes-oath-rajya-sabha-mp-2828874',
      language: 'te',
    },
    {
      title:   'టమాటా ధరలు ₹70/కేజీ దాటాయి — ప్రభుత్వం సబ్సిడీ అమ్మకాలకు దిగింది',
      section: 'National',
      tags:    ['#national', '#prices', '#tomato', '#inflation'],
      content: 'దేశంలో టమాటా ధరలు కిలో ₹70 దాటాయి. ముంబై, ఢిల్లీ, బెంగళూరు మార్కెట్లలో అత్యధిక ధరలు నమోదయ్యాయి. ప్రభుత్వం సబ్సిడీ ధరల్లో టమాటాల అమ్మకాన్ని నగరాల్లో ప్రారంభించింది. మదర్‌ డెయిరీ, సఫల్‌ కేంద్రాల ద్వారా ₹40/కేజీకి అందించనున్నారు.',
      url:     'https://www.sakshi.com/telugu-news/national/tomato-prices-soar-past-70kg-government-steps-subsidised-sales-2825176',
      language: 'te',
    },
    {
      title:   'అమిత్‌ షా జూలై 9న మేజర్‌ భేటీ — అక్రమ వలసదారులపై పెద్ద చర్య',
      section: 'National',
      tags:    ['#national', '#amitshah', '#security', '#crackdown'],
      content: 'దేశ భద్రతను దెబ్బతీస్తున్న అక్రమ వలసదారులను గుర్తించేందుకు హోం మంత్రి అమిత్‌ షా జూలై 9న అన్ని ఏజెన్సీలతో కీలక సమావేశం ఏర్పాటు చేశారు. సీబీఐ, ఐబీ, ఎన్‌ఐఏ, సీఐఎస్‌ఎఫ్‌ అధికారులు పాల్గొనే ఈ భేటీలో జాతీయ భద్రతా వ్యూహాన్ని రూపొందించనున్నారు.',
      url:     'https://www.sakshi.com/telugu-news/national/amit-shahs-mega-july-9-crackdown-top-agencies-unite-flush-out-illegal-2828799',
      language: 'te',
    },
    {
      title:   'సురత్‌ స్టేషన్‌లో హైడ్రామా: ప్రయాణికుడిని చితకబాదిన రైల్వే పోలీసు — వీడియో వైరల్‌',
      section: 'National',
      tags:    ['#national', '#railway', '#police', '#viral'],
      content: 'సూరత్‌ రైల్వే స్టేషన్‌లో ఒక SI ప్రయాణికుడిని కొట్టిన వీడియో సోషల్‌ మీడియాలో తీవ్రంగా వైరల్‌ అయింది. రాత్రిపూట జరిగిన ఈ ఘటనలో పోలీసు అధికారి అభ్యంతరకరంగా ప్రవర్తించాడు. రైల్వే మంత్రిత్వ శాఖ విచారణ ఆదేశించింది.',
      url:     'https://www.sakshi.com/telugu-news/national/surat-station-railway-cop-beats-passenger-video-viral-2828806',
      language: 'te',
    },
    {
      title:   'వందేభారత్‌ మిస్‌ అయితే — కొత్త ఎమర్జెన్సీ గైడ్‌లైన్లు',
      section: 'National',
      tags:    ['#national', '#vandebharat', '#railway', '#guidelines'],
      content: 'వందేభారత్‌ రైలు తలుపులు మూసుకున్న తర్వాత ఏం చేయాలో రైల్వే కొత్త నిబంధనలు విడుదల చేసింది. గార్డు కోచ్‌లో ప్రయాణించే అవకాశం, స్టేషన్‌ సూపరింటెండెంట్‌ సహాయం, రీఫండ్‌ పొందే పద్ధతి వివరించింది. ప్రయాణికుల సౌకర్యానికి ప్రాధాన్యత ఇస్తున్నామని రైల్వే తెలిపింది.',
      url:     'https://www.sakshi.com/telugu-news/national/missed-vande-bharat-use-guards-coach-board-2828803',
      language: 'te',
    },
    {
      title:   'అయోధ్య రామాలయ విరాళాల కేసు: తక్షణ విచారణకు సుప్రీం నిరాకరణ',
      section: 'National',
      tags:    ['#national', '#supremecourt', '#temple', '#ayodhya'],
      content: 'న్యూఢిల్లీ: అయోధ్య రామాలయానికి భక్తులు సమర్పించిన విరాళాల దుర్వినియోగ కేసులో తక్షణ విచారణకు సుప్రీంకోర్టు నిరాకరించింది. పిటిషన్‌దారు వినతిని తోసిపుచ్చిన కోర్టు.. సాధారణ ప్రక్రియ ద్వారా వినాలని స్పష్టం చేసింది.',
      url:     'https://www.sakshi.com/telugu-news/national/sc-rejects-urgent-hearing-ram-temple-donation-theft-plea-2828826',
      language: 'te',
    },
    {
      title:   'బెంగాల్‌లో యోగీ స్టైల్‌ గుండా నిరోధక బిల్లు — సువేందు దూకుడు',
      section: 'National',
      tags:    ['#national', '#bengal', '#politics', '#bjp'],
      content: 'కోల్‌కతా: పశ్చిమ బెంగాల్‌ విపక్ష నేత సువేందు అధికారీ యోగీ ఆదిత్యనాథ్‌ మోడల్లో గుండా నిరోధక చట్టం అమలు చేయాలని డిమాండ్‌ చేశారు. చట్ట శాంతి భద్రతల పరిస్థితి దిగజారిందని ఆరోపించిన ఆయన ఈ బిల్లు ప్రవేశపెట్టాలని ముఖ్యమంత్రిని కోరారు.',
      url:     'https://www.sakshi.com/telugu-news/national/bengal-introduce-yogi-style-anti-goonda-bill-2828823',
      language: 'te',
    },
    {
      title:   'AIADMK మరో ఎమ్మెల్యే రాజీనామా — పళని వెనుదెబ్బ',
      section: 'National',
      tags:    ['#national', '#tamilnadu', '#aiadmk', '#politics'],
      content: 'చెన్నై: తమిళనాడు రాజకీయాల్లో కీలక పరిణామంగా AIADMK ఆరో ఎమ్మెల్యే విజయభాస్కర్‌ పార్టీ నుండి రాజీనామా చేశారు. విపక్ష పాత్ర వహించడంలో పళని వైఫల్యాన్ని ఆయన తన నిష్క్రమణకు కారణంగా పేర్కొన్నారు.',
      url:     'https://www.sakshi.com/telugu-news/national/mr-vijaya-bhaskar-has-resigned-aiadmk-2828834',
      language: 'te',
    },
    {
      title:   'జమ్ముకశ్మీర్‌ పోలియో బ్రోచర్‌లో పాకిస్తాన్‌ నినాదం — వివాదం',
      section: 'National',
      tags:    ['#national', '#kashmir', '#polio', '#pakistan'],
      content: 'శ్రీనగర్‌: జమ్ముకశ్మీర్‌ ఆరోగ్య శాఖ పోలియో నిర్మూలన బ్రోచర్‌లో పొరపాటున "పోలియో ఫ్రీ పాకిస్తాన్‌" అనే నినాదం చేర్చారు. ఈ తప్పుడు సమాచారం వెలుగులోకి రావడంతో పెద్ద వివాదం చెలరేగింది. సంబంధిత అధికారులపై విచారణ ఆదేశించారు.',
      url:     'https://www.sakshi.com/telugu-news/national/jk-polio-brochure-sparks-row-over-polio-free-pakistan-slogan-2829777',
      language: 'te',
    },
    // ── International / అంతర్జాతీయం ────────────────────────────────────────
    {
      title:   'యూరప్‌లో భారీ హీట్‌వేవ్‌ — పట్టాలు కరిగేంత వేడి',
      section: 'International',
      tags:    ['#international', '#europe', '#heatwave', '#climate'],
      content: 'యూరప్‌ అంతటా తీవ్రమైన హీట్‌వేవ్‌ ప్రవేశించింది. స్పెయిన్‌, ఫ్రాన్స్‌, ఇటలీలో 47°C దాటిన ఉష్ణోగ్రతలు నమోదయ్యాయి. రైల్వే పట్టాలు కరగడం, విద్యుత్‌ కోతలు జరుగుతున్నాయి. వేలమంది ప్రజలు ఆసుపత్రుల్లో చేరారు. ఇది యూరప్‌ చరిత్రలో అత్యంత తీవ్రమైన వేసవి.',
      url:     'https://www.sakshi.com/telugu-news/international/massive-heat-wave-effet-across-europe-2828822',
      language: 'te',
    },
    {
      title:   'డ్రాగన్‌ మార్క్‌ ప్రతీకారం: జపనీస్‌ కంపెనీలపై చైనా ఆంక్షలు',
      section: 'International',
      tags:    ['#international', '#china', '#japan', '#trade'],
      content: 'బీజింగ్‌: జపాన్‌ను ఆర్థికంగా దెబ్బతీసేందుకు చైనా మరిన్ని జపాన్‌ కంపెనీలను ఎగుమతి నియంత్రణ జాబితాలో చేర్చింది. సెమీకండక్టర్‌, ఆటోమోటివ్‌ రంగాల్లో జపాన్‌ సంస్థలు ఈ నిషేధం పరిధిలోకి వచ్చాయి. ద్వైపాక్షిక సంబంధాలు మరింత దిగజారే అవకాశం ఉంది.',
      url:     'https://www.sakshi.com/telugu-news/international/china-adds-more-japanese-entities-export-control-list-2829789',
      language: 'te',
    },
    {
      title:   'Meta కొత్తరకం AI స్మార్ట్‌ గ్లాసెస్‌: 12MP కెమెరా, రియల్‌టైమ్‌ అనువాదం',
      section: 'International',
      tags:    ['#international', '#meta', '#technology', '#ai'],
      content: 'Meta కంపెనీ తదుపరి తరం AI స్మార్ట్‌ గ్లాసెస్‌ను ప్రకటించింది. 12MP కెమెరా, రియల్‌టైమ్‌ భాషా అనువాదం, WhatsApp ఇంటిగ్రేషన్‌ ఫీచర్లతో వచ్చే ఈ గ్లాసెస్‌ $299లో అందుబాటులో ఉంటాయి. Ray-Ban తో కలిసి తయారు చేసిన ఈ ఉత్పత్తి 2026 సెప్టెంబర్‌లో రిలీజ్‌ అవుతుంది.',
      url:     'https://www.sakshi.com/telugu-news/international/meta-unveils-next-gen-ai-smart-glasses-12mp-camera-2825201',
      language: 'te',
    },
    // ── Andhra Pradesh / ఆంధ్రప్రదేశ్ ─────────────────────────────────────
    {
      title:   'పవన్‌ కళ్యాణ్‌ అత్యంత హాస్యాస్పద వ్యక్తి అని జాడ శ్రావణ్‌',
      section: 'Andhra Pradesh',
      tags:    ['#andhrapradesh', '#pawankalyan', '#politics', '#tdp'],
      content: 'వైఎస్సార్‌ కాంగ్రెస్‌ నేత జాడ శ్రావణ్‌ పవన్‌ కళ్యాణ్‌పై తీవ్రంగా విరుచుకుపడ్డారు. వారిని "అత్యంత హాస్యాస్పద రాజకీయ నేత" అని అభివర్ణించారు. ప్రభుత్వ విధానాల పట్ల తమ పార్టీ అభ్యంతరాలను వెల్లడిరచారు.',
      url:     'https://www.sakshi.com/telugu-news/andhra-pradesh/pawan-highly-comical-fellow-says-jada-sravan-2822419',
      language: 'te',
    },
    // ── Telangana / తెలంగాణ ──────────────────────────────────────────────────
    {
      title:   'బూపాలపల్లి రోడ్డు ప్రమాదంలో వెంకన్న మృతి',
      section: 'Telangana',
      tags:    ['#telangana', '#accident', '#road', '#death'],
      content: 'తెలంగాణలోని బూపాలపల్లి జిల్లాలో రోడ్డు ప్రమాదంలో వెంకన్న అనే వ్యక్తి మృతి చెందారు. జాతీయ రహదారిపై తీవ్రవేగంతో వెళ్తున్న వాహనాల ఢీకొనడంతో ఈ ప్రమాదం జరిగింది. రోడ్డు భద్రతా నిబంధనలు పాటించాలని అధికారులు విజ్ఞప్తి చేశారు.',
      url:     'https://www.sakshi.com/telugu-news/telangana/venkanna-dead-bupalapalli-road-accident-2822398',
      language: 'te',
    },
    // ── Cinema / సినిమా ───────────────────────────────────────────────────────
    {
      title:   'ఇడుపు కాయితం నటి, జానపద నృత్యకారిణి నాగదుర్గ గురించి ఆసక్తికర విషయాలు',
      section: 'Cinema',
      tags:    ['#cinema', '#tollywood', '#actress', '#folk'],
      content: 'సోషల్‌ మీడియాలో ట్రెండింగ్‌లో ఉన్న ఇడుపు కాయితం సినిమా నటి నాగదుర్గ గురించి ఆసక్తికర విషయాలు వెలుగులోకి వచ్చాయి. తెలంగాణ సంప్రదాయ జానపద నృత్యకారిణిగా పేరుపొందిన ఆమె ఈ సినిమాలో ముఖ్యమైన పాత్ర పోషించింది. చిత్రం రిలీజ్‌ తర్వాత పెద్ద చర్చ జరుగుతోంది.',
      url:     'https://www.sakshi.com/telugu-news/movies/interesting-facts-about-idupu-kayitham-movie-actress-folk-dancer-naga-durga',
      language: 'te',
    },
    {
      title:   'కొల్లీవుడ్‌ నటి త్రిష పుట్టినరోజు — CM విజయ్‌ శుభాకాంక్షలు',
      section: 'Cinema',
      tags:    ['#cinema', '#kollywood', '#trisha', '#birthday'],
      content: 'తమిళ సినిమా నటి త్రిష కృష్ణన్‌ పుట్టినరోజు సందర్భంగా తమిళనాడు ముఖ్యమంత్రి విజయ్‌ ఆమెకు శుభాకాంక్షలు తెలిపారు. అభిమానులు సోషల్‌ మీడియాలో ఆమెను వేనోళ్ళ కొనియాడారు. త్రిష తన కెరీర్‌లో 25 సంవత్సరాలు పూర్తి చేసుకుంది.',
      url:     'https://www.sakshi.com/telugu-news/movies/kollywood-actress-trisha-birthday-wishes-cm-vijay-2823583',
      language: 'te',
    },
    {
      title:   'మలయాళ నటుడు బాల కొట్టిన లాటరీ — సరదాగా టికెట్స్‌ కొంటే..',
      section: 'Cinema',
      tags:    ['#cinema', '#mollywood', '#lottery', '#actor'],
      content: 'మలయాళ సినిమా నటుడు బాల సరదాగా లాటరీ టికెట్లు కొనగా తనకు భారీ బహుమతి వచ్చింది. కేరళలో లాటరీ కొనడం సాధారణ సంస్కృతి. ఈ విషయాన్ని ఆయన సోషల్‌ మీడియాలో పంచుకున్నారు. నటుడికి అనూహ్య అదృష్టం కలసివచ్చింది.',
      url:     'https://www.sakshi.com/telugu-news/movies/malayalam-actor-bala-won-lottery-tickets-and-gifts-2827019',
      language: 'te',
    },
    // ── Business / వ్యాపారం ─────────────────────────────────────────────────
    {
      title:   'బంగారం ధరలు మళ్ళీ తగ్గాయి — మీ నగరంలో తాజా రేట్లు చెక్‌ చేయండి',
      section: 'Business',
      tags:    ['#business', '#gold', '#prices', '#finance'],
      content: 'సోమవారం బంగారం ధరలు తగ్గాయి. 10 గ్రాముల 24 కారెట్‌ బంగారం ₹72,450కి తగ్గింది. హైదరాబాద్‌, ముంబై, చెన్నై, ఢిల్లీ నగరాల్లో రేట్లు భిన్నంగా ఉన్నాయి. అంతర్జాతీయ మార్కెట్లో డాలర్‌ బలపడటం వల్ల బంగారం ధర తగ్గిందని నిపుణులు చెప్పారు.',
      url:     'https://www.sakshi.com/telugu-news/business/gold-prices-drop-again-check-latest-rates-your-city-2823591',
      language: 'te',
    },
    {
      title:   'పాత బంగారం అమ్ముతున్న వారి సంఖ్య పెరుగుతోంది — షాకింగ్‌ రిపోర్ట్‌',
      section: 'Business',
      tags:    ['#business', '#gold', '#economy', '#market'],
      content: 'బంగారం ధరలు పెరిగినా దేశంలో పాత బంగారం అమ్మేవారి సంఖ్య గణనీయంగా పెరుగుతోంది. జీవన వ్యయాలు పెరగడం, ఆర్థిక అవసరాల వల్ల ప్రజలు నగలు అమ్ముకుంటున్నారు. ఈ ట్రెండ్‌ దేశ ఆర్థిక పరిస్థితిని ప్రతిబింబిస్తోందని విశ్లేషకులు తెలిపారు.',
      url:     'https://www.sakshi.com/telugu-news/business/shocking-report-old-gold-country-2829767',
      language: 'te',
    },
    // ── Family / కుటుంబం ─────────────────────────────────────────────────────
    {
      title:   'టోక్యో వీధుల్లో భారతీయ మహిళ ఎర్ర చీర — జపనీయులు ఆగిపోయారు',
      section: 'Family',
      tags:    ['#family', '#lifestyle', '#japan', '#saree', '#viral'],
      content: 'జపాన్‌ రాజధాని టోక్యో వీధుల్లో ఎర్ర రంగు చీర ధరించి నడుస్తున్న భారతీయ మహిళ వీడియో వైరల్‌ అయింది. ట్రాఫిక్‌ సిగ్నల్‌ పడినప్పుడు జపనీయులందరూ ఆమెను చూసి ఆగిపోయారు. భారతీయ దుస్తుల సంస్కృతికి అంతర్జాతీయ గుర్తింపు లభించింది.',
      url:     'https://www.sakshi.com/telugu-news/family/saree-japan-indian-woman-stuns-tokyo-locals-viral-video-2827772',
      language: 'te',
    },
    {
      title:   'ఐవీఎఫ్‌ ప్రయాణం అంత సులభం కాదు — ఏకంగా 150 ఇంజెక్షన్లు',
      section: 'Family',
      tags:    ['#family', '#health', '#ivf', '#bollywood'],
      content: 'బాలీవుడ్‌ నటి అనుష్క రంజన్‌ తన IVF ప్రయాణం గురించి మనసు విప్పి మాట్లాడింది. 150 ఇంజెక్షన్లు, నెలల తరబడి చికిత్స, భావోద్వేగ ఒడిదుడుకులు అనుభవించానని వెల్లడించింది. IVF గురించి సమాజంలో అవగాహన పెంచేందుకు తన అనుభవాన్ని పంచుకుంది.',
      url:     'https://www.sakshi.com/telugu-news/family/mom-be-anushka-ranjan-ivf-journey-2828918',
      language: 'te',
    },
    {
      title:   'మధుమేహ మందులకు ప్రత్యామ్నాయంగా కాకరకాయ వాడొచ్చా?',
      section: 'Family',
      tags:    ['#family', '#health', '#diabetes', '#ayurveda'],
      content: 'చాలా మంది మధుమేహ రోగులు కాకరకాయ జ్యూస్‌ తాగితే మందులు వదిలిపెట్టవచ్చని భావిస్తారు. ఇది ఏ మేరకు నిజమో వైద్యులు వివరించారు. కాకరకాయ రక్తంలో చక్కెర స్థాయులను కొంత తగ్గించగలదు, కానీ మందులకు పూర్తి ప్రత్యామ్నాయం కాదని స్పష్టం చేశారు.',
      url:     'https://www.sakshi.com/telugu-news/family/health-tips-many-people-think-bitter-melon-can-replace-diabetes-medication',
      language: 'te',
    },
    {
      title:   'అమ్మ కారణంగానే ఆ ఉద్యోగం — గాజులు తాకట్టు పెట్టి కూతురి ఫీజు కట్టింది',
      section: 'Family',
      tags:    ['#family', '#inspiration', '#mother', '#bengaluru'],
      content: 'బెంగళూరుకు చెందిన మహిళ తన అమ్మ గురించి హృదయ స్పందమైన విషయం పంచుకుంది. ఆమె అడ్మిషన్‌ ఫీజు కట్టలేని పరిస్థితిలో తల్లి తన బంగారు గాజులను తాకట్టు పెట్టింది. ఇప్పుడు ఆ కూతురు సాఫ్ట్‌వేర్‌ ఇంజినీర్‌గా మంచి ఉద్యోగంలో స్థిరపడింది.',
      url:     'https://www.sakshi.com/telugu-news/family/bengaluru-woman-recalls-mother-pawning-gold-bangles-pay-admission-fee-2828886',
      language: 'te',
    },
    {
      title:   'అమెరికా NRI "ప్రసాదు" ఇంట్లో పెళ్లి కాలేదు — మ్యాచ్‌మేకర్‌ వెల్లడించిన షాకింగ్‌ కారణం',
      section: 'Family',
      tags:    ['#family', '#nri', '#marriage', '#usa'],
      content: 'అమెరికాలో స్థిరపడిన సాఫ్ట్‌వేర్‌ ఇంజినీర్‌కు పెళ్లి కాలేదు. కారణం తెలిస్తే ఆశ్చర్యమేస్తుంది. భారత మహిళలు తనను తిరస్కరించారని ఆయన మ్యాచ్‌మేకర్‌కు చెప్పాడు. ఆ కారణాలు విచిత్రంగా ఉన్నాయని మ్యాచ్‌మేకర్‌ వెల్లడించింది. NRI వివాహ మార్కెట్లో ప్రస్తుత ట్రెండ్‌లు తెలుస్తున్నాయి.',
      url:     'https://www.sakshi.com/telugu-news/family/us-techie-rejected-indian-women-matchmaker-reveals-shocking-reason-2828848',
      language: 'te',
    },
    {
      title:   'దుబాయ్‌లో నెయిల్‌ ఆర్టిస్ట్‌గా నెలకు ₹10 లక్షలు సంపాదించే 32 ఏళ్ళ మహిళ',
      section: 'Family',
      tags:    ['#family', '#lifestyle', '#career', '#dubai', '#women'],
      content: 'దుబాయ్‌లో నివసించే 32 ఏళ్ళ భారతీయ మహిళ నెయిల్‌ ఆర్ట్‌ నిపుణురాలిగా మారి నెలకు ₹10 లక్షలు సంపాదిస్తోంది. కొద్ది నెలల్లోనే ఆమె తన స్వంత సెలూన్‌ ప్రారంభించింది. సాంప్రదాయేతర కెరీర్లలో కూడా విజయం సాధించవచ్చని ఆమె నిరూపించింది.',
      url:     'https://www.sakshi.com/telugu-news/family/32-year-old-dubai-nail-artist-earns-over-rs-10-lakh-2828814',
      language: 'te',
    },
    {
      title:   'పశ్చిమ బెంగాల్‌ హల్దియా రిఫైనరీలో మంటలు — కార్మికులు చిక్కుకున్నారు',
      section: 'National',
      tags:    ['#national', '#fire', '#bengal', '#accident'],
      content: 'కోల్‌కతా: పశ్చిమ బెంగాల్‌లోని హల్దియా రిఫైనరీలో తీవ్రమైన మంటలు చెలరేగాయి. అనేక మంది కార్మికులు మంటల్లో చిక్కుకున్నారు. NDRF బృందాలు సహాయక చర్యలు చేపట్టాయి. గాయపడిన వారిని సమీప ఆసుపత్రులకు తరలించారు. సంఘటనకు గల కారణాలు దర్యాప్తు జరుగుతోంది.',
      url:     'https://www.sakshi.com/telugu-news/national/massive-fire-breaks-out-west-bengals-haldia-refinery-several-workers-injured',
      language: 'te',
    },
  ];

  for (const s of samples) addArticle(s);
  return articles.length;
}

module.exports = {
  addArticle,
  getAllArticles,
  getStats,
  queryArticles,
  queryHybrid,
  cosineSimilarity,
  resetArticles,
  pruneOldArticles,
  loadSampleArticles,
  // Disk persistence
  saveToFile,
  loadFromFile,
  clearFile,
  // Embedding API
  setEmbedding,
  getArticlesForEmbedding,
  getEmbeddingStats,
  // Section vocabulary — exported so routes (ai.js) can test section relevance
  // against the SAME token lists used for auto-tagging at ingest time.
  TELUGU_SECTION_MAP,
  ENGLISH_SECTION_KEYWORDS,
};
