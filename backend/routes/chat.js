'use strict';

/**
 * POST /api/chat
 *
 * Smart context router for the NewsAI widget.
 *
 * Receives the user's question, detects which section they're asking about,
 * retrieves ONLY those articles from today's briefing store, and returns a
 * ready-made context string that the widget injects directly into the LLM
 * system prompt.
 *
 * Because the context comes from fully-ingested articles (real body text),
 * hallucination is structurally impossible — the LLM can only reference
 * what's in the context.
 *
 * Body:    { question: string, lang?: "te"|"en" }
 * Returns: { context: string|null, section, source, articleCount, total, date }
 *
 *   context: null → widget falls back to DOM-scraped content
 *   context: string → widget uses this as TODAY'S ARTICLES in system prompt
 */

const briefing = require('../store/briefingStore');

// ── Section trigger map ────────────────────────────────────────────────────
// Maps section names to trigger keywords (English + Telugu).
// First match wins — order matters (specific before generic).
const SECTION_TRIGGERS = [
  {
    section:  'Sports',
    triggers: ['sport','sports','cricket','ipl','t20','odi','test match','football','badminton','boxing','tennis','kabaddi','hockey','volleyball','olympic','match','tournament','league','trophy','player','athlete','స్పోర్ట్స్','క్రీడ','క్రీడలు','క్రికెట్','మ్యాచ్','టోర్నమెంట్','ఫుట్‌బాల్','బ్యాడ్మింటన్','బాక్సింగ్','ఒలింపిక్స్','ఐపీఎల్'],
  },
  {
    section:  'Cinema',
    triggers: ['cinema','movie','film','tollywood','bollywood','ott','actor','actress','director','release','trailer','teaser','box office','netflix','amazon prime','hotstar','సినిమా','నటుడు','నటి','చిత్రం','రిలీజ్','టాలీవుడ్','ట్రైలర్','వినోదం','హీరో','హీరోయిన్'],
  },
  {
    section:  'Telangana',
    triggers: ['telangana','hyderabad','secunderabad','revanth','ktr','brs','warangal','nizamabad','karimnagar','khammam','kcr','హైదరాబాద్','తెలంగాణ','రేవంత్','కేటీఆర్','వరంగల్'],
  },
  {
    section:  'Andhra Pradesh',
    triggers: ['andhra','ap','amaravati','vijayawada','vizag','visakhapatnam','chandrababu','jagan','tdp','ysrcp','pawan kalyan','lokesh','ఆంధ్ర','అమరావతి','విజయవాడ','చంద్రబాబు','జగన్','ఏపీ'],
  },
  {
    section:  'National',
    triggers: ['national','india','central','modi','bjp','congress','parliament','lok sabha','rajya sabha','delhi','జాతీయ','కేంద్ర','మోదీ','భారత్','పార్లమెంట్','లోక్‌సభ'],
  },
  {
    section:  'International',
    triggers: ['international','world','global','usa','america','china','russia','war','iran','israel','pakistan','trump','ukraine','అంతర్జాతీయ','విదేశీ','ప్రపంచం','అమెరికా','చైనా','యుద్ధం'],
  },
  {
    section:  'Business',
    triggers: ['business','market','sensex','nifty','rbi','stock','economy','gdp','budget','tax','gst','company','వ్యాపారం','ఆర్థిక','మార్కెట్','సెన్సెక్స్','బడ్జెట్','షేర్'],
  },
  {
    section:  'Crime & Police',
    triggers: ['crime','murder','killed','robbery','fraud','arrested','police','investigation','cbi','నేరం','హత్య','పోలీసు','అరెస్టు','మోసం','దర్యాప్తు','సీబీఐ'],
  },
  {
    section:  'Education',
    triggers: ['education','school','college','exam','student','result','admission','eamcet','jee','neet','విద్య','పాఠశాల','కళాశాల','విద్యార్థి','పరీక్ష','ఫలితాలు','అడ్మిషన్','ఈఏఎంసెట్'],
  },
  {
    section:  'Public Health',
    triggers: ['health','hospital','disease','doctor','medicine','vaccine','cancer','virus','outbreak','ఆరోగ్యం','వైద్యం','ఆసుపత్రి','వ్యాధి','వైద్యుడు','వ్యాక్సిన్'],
  },
  {
    section:  'Agriculture',
    triggers: ['farmer','agriculture','crop','paddy','drought','fertilizer','రైతు','వ్యవసాయం','పంట','ఎరువు','కరువు','రైతన్న'],
  },
  {
    section:  'Courts',
    triggers: ['court','high court','supreme court','judge','verdict','bail','petition','న్యాయస్థానం','హైకోర్టు','సుప్రీంకోర్టు','తీర్పు','బెయిల్','పిటిషన్'],
  },
  {
    section:  'Technology',
    triggers: ['technology','cyber','software','app','mobile','internet','ai','startup','it sector','సాంకేతిక','సైబర్','యాప్','మొబైల్','ఇంటర్నెట్','స్టార్టప్'],
  },
  {
    section:  'Irrigation',
    triggers: ['irrigation','dam','reservoir','flood','canal','godavari','krishna','జలాశయం','డ్యామ్','వరద','కాలువ','నీటి మట్టం','గోదావరి','కృష్ణ'],
  },
  {
    section:  'Railways',
    triggers: ['railway','train','metro','irctc','రైల్వే','రైలు','మెట్రో','ట్రెయిన్'],
  },
];

// ── Detect which section the user is asking about ─────────────────────────

function detectSection(question) {
  if (!question) return null;
  const lower = question.toLowerCase();
  for (const { section, triggers } of SECTION_TRIGGERS) {
    if (triggers.some(t => lower.includes(t))) return section;
  }
  return null;
}

// ── Build context string from articles ────────────────────────────────────

function buildContext(articles, section, date) {
  const label = section ? `${section} articles` : 'all articles';
  const dateStr = date || new Date().toLocaleDateString('en-IN', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  if (!articles.length) {
    return section
      ? `ఈ రోజు ${section} వార్తలు అందుబాటులో లేవు. No ${section} articles found in today's edition.`
      : 'No articles available for today.';
  }

  let ctx = `Today's ${label} | ${dateStr} | ${articles.length} article(s)\n\n`;

  for (const a of articles) {
    const headline = a.headline || a.title || '';
    const body     = (a.bodyTe || a.body || '').trim();

    ctx += `Headline: ${headline}\n`;
    if (body.length > 80 && body !== headline) {
      ctx += `Body: ${body.slice(0, 600)}\n`;
    } else {
      ctx += `Body: [HEADLINE ONLY — DO NOT ADD ANY DESCRIPTION]\n`;
    }
    if (a.url) ctx += `URL: ${a.url}\n`;
    ctx += '\n';
  }

  return ctx;
}

// ── Route handler ──────────────────────────────────────────────────────────

async function chat(req, res) {
  const { question } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'question is required' });
  }

  // Load today's briefing
  const allArticles = briefing.load();

  if (!allArticles.length) {
    // No briefing yet — tell widget to use its own DOM content
    return res.json({
      context:      null,
      section:      null,
      source:       'none',
      articleCount: 0,
      total:        0,
      message:      'No briefing ingested yet. Widget will use DOM-scraped content.',
    });
  }

  // Detect section and filter articles
  const section  = detectSection(question);
  const filtered = section
    ? allArticles.filter(a => a.section === section)
    : allArticles;

  const stats = briefing.getStats(allArticles);
  const ctx   = buildContext(filtered, section, stats.date);

  console.log(`[Chat] "${question.slice(0, 60)}" → section="${section || 'all'}" | ${filtered.length}/${allArticles.length} articles | withBody=${filtered.filter(a=>(a.body||'').length>80).length}`);

  res.json({
    context:      ctx,
    section:      section || null,
    source:       'briefing',
    articleCount: filtered.length,
    total:        stats.total,
    date:         stats.date,
  });
}

/**
 * GET /api/chat/sections — list which sections have articles today
 */
function listSections(req, res) {
  const articles = briefing.load();
  const stats    = briefing.getStats(articles);
  res.json({ stats, available: Object.keys(stats.bySection) });
}

module.exports = { chat, listSections };
