'use strict';

/**
 * scrape-sakshi.js — Server-side Sakshi.com scraper
 *
 * Replicates the 3-phase DOM scraping from extension/content.js but runs
 * entirely on the backend using node-fetch + cheerio.
 *
 * Exports:
 *   doScrape()       — standalone function called by the auto-poll loop in server.js
 *   scrapeSakshi()   — Express route handler (POST /api/scrape-sakshi) wraps doScrape()
 *
 * Auto-polling is configured in server.js via SAKSHI_SCRAPE_INTERVAL_HOURS env var.
 * Default: ON, every 2 hours, no manual config needed.
 */

const path    = require('path');
const fetch   = require('node-fetch');
const cheerio = require('cheerio');
const store   = require('../store/articleStore');
const { pruneOldArticles } = store;
const { clearCache } = require('./gemini-cache');   // invalidate context cache after fresh ingest
const { isSafeUrl } = require('../utils/safeUrl');  // SSRF guard for article-body fetches

// ── Scraper config — section pages, sitemap URL, and RSS feeds live in ────────
// configs/sakshi.json so a second newspaper client can be added without code changes.
const scraperConfig = require(path.join(__dirname, '../../configs/sakshi.json')).scraper;

// ── Section pages — exact URLs the Chrome extension uses (sourced from config) ─
// Matched from extension/content.js fetchSectionPages() + homepage
const SECTION_PAGES = scraperConfig.sectionPages;

// ── News sitemap URL — contains today's 100-200 article URLs + titles ─────────
const NEWS_SITEMAP_URL = scraperConfig.sitemapUrl;

// ── Sakshi RSS feed URLs — supplement scraper with actual article summaries ───
// RSS <description> tags contain a 2-3 sentence summary not available in
// the sitemap or __NEXT_DATA__ section pages. We fetch these in parallel with
// the main scrape and use them to fill the `summary` field for matching articles.
const RSS_FEEDS = scraperConfig.rssFeeds;

// ── Headline sanitiser ─────────────────────────────────────────────────────────
// Sakshi article cards sometimes render the publication date inside the same
// DOM element as the headline (e.g. in a <span> or appended text).
// Strip those datelines so they don't pollute the stored title or what Gemini sees.
function cleanHeadline(raw) {
  return (raw || '')
    .replace(/\s+/g, ' ')
    // "Sat, Jul 18 2026 6:53 AM" / "Saturday, 18 July 2026" and close variants
    .replace(/\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[,.]?\s+[A-Za-z]*\s*\d{1,2}[,.]?\s*\d{4}[^a-zA-Zఀ-౿]*/gi, '')
    // Stand-alone time "6:53 AM" / "10:30 PM" (in case date was already stripped)
    .replace(/\s*\b\d{1,2}:\d{2}\s*(AM|PM)\b/gi, '')
    // "Updated on ..." CMS labels
    .replace(/\s*updated\s+on\s+[^—]+/gi, '')
    .trim();
}

// ── Same selector list as content.js (order matters) ────────────────────────
const SELECTORS = [
  'h2 a', 'h3 a', 'h4 a',
  'article h2 a', 'article h3 a',
  '[class*="card"] a[href]', '[class*="item"] a[href]',
  'a[href*="/sports/"]', 'a[href*="/entertainment/"]',
  'a[href*="/cinema/"]', 'a[href*="/cricket/"]',
  'a[href*="/news/"]', 'a[href*="/story/"]', 'a[href*="/article/"]',
  '.story-title a', '.storydesc a', '.storycard a',
  '[class*="story"] a', '[class*="headline"] a',
  '[class*="news-head"] a', '[class*="newshead"] a',
  '[class*="heading"] a', '[class*="title"] a',
  '.card-title a', '.entry-title a',
  'h1 a',
];

// ── SECTION_MAP — ported verbatim from extension/content.js ─────────────────
const SECTION_MAP = [
  { re: /supreme court|high court|sessions court|district court|judge|verdict|judgment|bail denied|acquitted|convicted|petition|contempt|\bHC\b|\bSC\b|remand|chargesheet|prosecution|acquittal|sentence|appeal|stay order/i, s: 'Courts' },
  { re: /\bghmc\b|\bgvmc\b|municipality|municipal corporation|panchayat|\bward\b|\bmayor\b|councillor|sarpanch|gram panchayat/i, s: 'Local Bodies' },
  { re: /railway|train|\bmetro\b|rail|irctc|vande.bharat|express.train|locomotive|station|passenger|ticket|derail/i, s: 'Railways' },
  { re: /airport|aviation|airline|flight|aircraft|airbus|boeing|indigo|spicejet|air india|air traffic|pilot/i, s: 'Aviation' },
  { re: /women|woman|girl|female|mahila|ladies|gender|self.help.group|\bSHG\b|domestic violence|dowry|maternity/i, s: 'Women' },
  { re: /murder|killed|robbery|theft|rape|fraud|scam|arrested|police|jail|custody|bail|warrant|chargesheet|suspect|investigation|kidnap|abduction|assault|firing|gang|dacoity|loot|fake|trap|attack|stabbing|explosion/i, s: 'Crime & Police' },
  { re: /health|hospital|doctor|disease|medicine|vaccine|surgery|cancer|dengue|malaria|covid|aarogya|virus|fever|tb|diabetes|bp|cardiac|nurse|treatment|outbreak/i, s: 'Public Health' },
  { re: /lifestyle|fashion|beauty|food recipe|yoga|fitness|wellness|skincare|haircare|diet|weight loss|health tips/i, s: 'Lifestyle' },
  { re: /technology|software|\bai\b|artificial intelligence|internet|mobile|app|cyber|digital|startup|isro|nasa|satellite|drone|robot|automation|smartphone|hack|fintech|it sector/i, s: 'Technology' },
  { re: /education|school|college|university|exam|student|admission|scholarship|eamcet|jee|neet|inter|btech|mba|phd|teacher|principal|hostel|results|rank/i, s: 'Education' },
  { re: /farmer|agriculture|crop|paddy|harvest|drought|ryot|urea|fertilizer|pesticide|kisan|fasal bima|sowing|yield|rytu|agricultural/i, s: 'Agriculture' },
  { re: /cricket|football|\bipl\b|sport|match|tournament|wicket|innings|\brun\b|player|team|league|trophy|fifa|olympic|badminton|boxing|kabaddi|hockey|tennis|volleyball|swimmer|athlete|stadium|coach|captain|batting|bowling|fielding|boundary|six|century/i, s: 'Sports' },
  { re: /cinema|film|movie|tollywood|bollywood|\bott\b|serial|television|album|actor|actress|director|release|trailer|teaser|box.office|collection|netflix|amazon prime|hotstar|shooting|producer/i, s: 'Cinema' },
  { re: /andhra|amaravati|vijayawada|jagan|chandrababu|guntur|vizag|visakhapatnam|nellore|kadapa|kurnool|tirupati|anantapur|eluru|rajahmundry|kakinada|ongole|lokesh|pawan kalyan|polavaram/i, s: 'Andhra Pradesh' },
  { re: /telangana|hyderabad|secunderabad|revanth|\bktr\b|\bbrs\b|warangal|nizamabad|karimnagar|khammam|medak|nalgonda|mahabubnagar|rangareddy|kcr|owaisi|harish rao/i, s: 'Telangana' },
  { re: /irrigation|reservoir|dam|canal|water level|flood|godavari|krishna river|srisailam|nagarjuna sagar|tungabhadra/i, s: 'Irrigation' },
  { re: /road|highway|flyover|overbridge|underpass|bridge|expressway|pothole|traffic jam|toll/i, s: 'Roads & Buildings' },
  { re: /lok sabha|rajya sabha|central government|modi|amit shah|rahul gandhi|president of india|vice president|prime minister|union budget/i, s: 'National' },
  { re: /international|world|global|america|russia|china|\busa\b|\buk\b|europe|pakistan|israel|ukraine|gaza|nato|un summit|diplomat|ambassador|foreign|war|conflict|nuclear/i, s: 'International' },
  { re: /business|market|economy|sensex|nifty|stock|finance|budget|tax|\brbi\b|\bgdp\b|inflation|trade|import|export|ipo|investment|profit|loss|gst|income tax|company|corporate/i, s: 'Business' },
  { re: /politics|political|election|vote|candidate|minister|parliament|assembly|party|manifesto|\btdp\b|\bysrcp\b|\bbjp\b|congress|\bbrs\b|janasena|\baap\b|\bmim\b|rally|padayatra|bypolls/i, s: 'Politics' },
  { re: /national|india|parliament|delhi/i, s: 'National' },
  { re: /collector|district administration|\bias\b|\bips\b|government order|circular|beneficiaries|secretariat|revenue department|district office/i, s: 'Public Administration' },
];

// ── TELUGU_MAP — ported verbatim from extension/content.js ──────────────────
const TELUGU_MAP = [
  { re: /సుప్రీంకోర్టు|హైకోర్టు|జిల్లా కోర్టు|న్యాయమూర్తి|తీర్పు|న్యాయస్థానం|కోర్టు విచారణ|బెయిల్ నిరాకరణ|రిమాండ్|పిటిషన్|స్టే ఆర్డర్|అప్పీల్|జైలు శిక్ష|నిర్దోషి|దోషి|లాయర్|అడ్వొకేట్|హైకోర్టు ఆదేశం|న్యాయ విచారణ/, s: 'Courts' },
  { re: /కార్పొరేషన్|నగరపాలక|పురపాలక|పంచాయతీ|వార్డు|మేయర్|మున్సిపల్|జీహెచ్ఎంసీ|జీవీఎంసీ|నగరపాలక సంస్థ|పట్టణ పాలన|కౌన్సిలర్|డివిజన్|సర్పంచ్|గ్రామపంచాయతీ|జడ్పీ|మండల|జిల్లా పరిషత్/, s: 'Local Bodies' },
  { re: /రైల్వే|రైలు|మెట్రో|వందే భారత్|రైల్వే స్టేషన్|ట్రెయిన్|ఐఆర్సీటీసీ|రైలు ప్రమాదం|రైలు ఆలస్యం|ప్రయాణికులు|రైలు సేవలు|పాసింజర్|రైలు టిక్కెట్|మెట్రో రైలు|రైలు పట్టాలు|లోకల్ రైలు|ఎక్స్‌ప్రెస్ రైలు/, s: 'Railways' },
  { re: /విమానం|విమానాశ్రయం|ఏవియేషన్|విమాన సేవలు|ఫ్లైట్|పైలట్|విమాన ప్రమాదం|ఎయిర్‌పోర్ట్|ఇండిగో|ఎయిర్ ఇండియా|విమాన చార్జీలు|విమాన రద్దు|ఏరో/, s: 'Aviation' },
  { re: /మహిళ|స్త్రీ|మహిళలు|అమ్మాయి|స్వయం సహాయక సంఘం|మహిళా|గర్భిణి|బాలిక|విద్యార్థిని|మహిళా సంఘం|నారీ|మహిళా శక్తి|వరకట్న వేధింపు|గృహ హింస|మహిళా పోలీసు/, s: 'Women' },
  { re: /ఆరోగ్యం|వైద్యం|ఆసుపత్రి|వ్యాధి|మందు|టీకా|చికిత్స|డాక్టర్|రోగి|వైరస్|జ్వరం|కరోనా|మలేరియా|డెంగీ|టీబీ|బీపీ|షుగర్|క్యాన్సర్|గుండె వ్యాధి|ఆరోగ్య సేవ|నర్సు|వైద్యుడు|శస్త్రచికిత్స|ఔషధం|వ్యాక్సిన్|ఇంజెక్షన్|ఆరోగ్య కేంద్రం|యాంటీబయాటిక్|సీజనల్ జ్వరాలు|ఫ్లూ/, s: 'Public Health' },
  { re: /జీవనశైలి|ఫ్యాషన్|వంట|రెసిపీ|టూరిజం|పర్యటన స్థలం|యోగా|ఫిట్నెస్|హెల్త్ టిప్స్|వంటకం|ఆహారం|బ్యూటీ|అందం|జుట్టు|చర్మం|సౌందర్యం|వెయిట్ లాస్|డైట్|వ్యాయామం|ట్రెండ్|ఫేస్‌పాక్|స్కిన్ కేర్/, s: 'Lifestyle' },
  { re: /వ్యవసాయం|రైతు|రైతన్న|రైతులు|పంట నష్టం|పంట బీమా|పంట|కరువు|సాగు|నీటిపారుదల|యూరియా|ఎరువు|పురుగు మందు|వ్యవసాయ|కూరగాయలు|ధాన్యం|వరి పంట|వరి సాగు|మొక్కజొన్న|చెరకు|పత్తి|మిర్చి|ఉల్లి|టమాటా|వ్యవసాయ రుణం|కిసాన్|రైతు భరోసా|ఆర్బీకే|కౌలు రైతు|పీఎం కిసాన్|ఫసల్ బీమా|వ్యవసాయ మార్కెట్|రైతు సమావేశం|అగ్రి/, s: 'Agriculture' },
  { re: /సైబర్ మోసం|సైబర్ నేరం|సైబర్ అటాక్|హ్యాకింగ్|హ్యాకర్|ఆన్‌లైన్ మోసం|ఆన్‌లైన్ స్కాం|డేటా లీక్|ర్యాన్సమ్‌వేర్/, s: 'Technology' },
  { re: /నేరం|హత్య|మర్డర్|దొంగతనం|అత్యాచారం|మోసం|పోలీసు|జైలు|అరెస్టు|నిందితుడు|దర్యాప్తు|వారెంట్|కిడ్నాప్|అపహరణ|దాడి|కాల్పులు|బాంబు|తస్కరణ|కాల్చి చంపారు|హత్యా యత్నం|దోపిడీ|నకిలీ నోట్లు|ట్రాప్|క్రైమ్|గ్యాంగ్|చార్జ్‌షీట్|పోలీస్ కస్టడీ|సీఐ|ఎస్పీ|డీఎస్పీ|ఎస్ఐ/, s: 'Crime & Police' },
  { re: /విద్య|పాఠశాల|కళాశాల|విశ్వవిద్యాలయం|విద్యార్థి|పరీక్ష|ఫలితాలు|ర్యాంక్|ఇంటర్ పరీక్ష|టెన్త్|ఎంపీసీ|బైపీసీ|బీటెక్|ఎంటెక్|ఎంబీఏ|పీహెచ్డీ|అడ్మిషన్|స్కాలర్‌షిప్|హాస్టల్|ఉపాధ్యాయుడు|టీచర్|ప్రిన్సిపల్|ఈఏఎంసెట్|జేఈఈ|నీట్|పీజీ|యూజీ|విద్యా సంస్థ|ఫీజు|స్కూల్|కాలేజ్/, s: 'Education' },
  { re: /టెక్నాలజీ|సాంకేతిక|సైబర్|ఇంటర్నెట్|మొబైల్|స్మార్ట్‌ఫోన్|యాప్|ఆన్‌లైన్|డిజిటల్|ఆర్టిఫిషియల్ ఇంటెలిజెన్స్|ఏఐ|సాఫ్ట్‌వేర్|డ్రోన్|రోబో|ఆటోమేషన్|సాటిలైట్|ఇస్రో|కంప్యూటర్|లాప్‌టాప్|ఐటీ|స్టార్టప్|ఫిన్‌టెక్|క్రిప్టో|బ్లాక్‌చెయిన్|5జీ/, s: 'Technology' },
  { re: /క్రీడ|బ్యాటింగ్|బౌలింగ్|మ్యాచ్|టోర్నమెంట్|వికెట్|క్రికెట్|ఆటగాడు|శతకం|అర్ధ శతకం|పరుగులు|స్కోర|ఆలౌట్|ఫైనల్|సెమీఫైనల్|చాంపియన్|ఇన్నింగ్స్|ఆటలు|ఆటగాళ్లు|ఫుట్‌బాల్|బ్యాడ్మింటన్|కుస్తీ|బాక్సింగ్|టెస్ట్ మ్యాచ్|వన్డే|టీ20|ఐపీఎల్|ఆసియా కప్|వరల్డ్ కప్|స్పోర్ట్స్|అథ్లెట్|ఒలింపిక్స్|మెడల్|ట్రోఫీ|క్రీడాకారుడు|కెప్టెన్|కోచ్|టీమ్ ఇండియా|పిచ్|స్టేడియం|ఆటగత్తె|ఫీల్డింగ్|క్యాచ్|రన్ అవుట్|బౌండరీ|సిక్సర్|నో బాల్|వైడ్|ఓపెనర్|స్పిన్నర్|పేసర్|కబడ్డీ|వాలీబాల్|హాకీ|టెన్నిస్|షటిల్|ఈత|హాఫ్ సెంచరీ|రన్స్/, s: 'Sports' },
  { re: /సినిమా|నటుడు|నటి|దర్శకుడు|రిలీజ్|పాట|వినోదం|హీరో|హీరోయిన్|చిత్రం|ట్రైలర్|ఓటీటీ|అవార్డ్|నటన|టాలీవుడ్|బాలీవుడ్|మ్యూజిక్|ఆల్బం|ప్రోమో|సినీ|తెలుగు చిత్రం|ఫిల్మ్|మూవీ|షూటింగ్|క్లైమాక్స్|ఫస్ట్ లుక్|టీజర్|రివ్యూ|రేటింగ్|బాక్సాఫీస్|కలెక్షన్|నిర్మాత|సంగీతం|నృత్యం|గీతం|వెబ్ సిరీస్|నెట్‌ఫ్లిక్స్|అమెజాన్ ప్రైమ్|హాట్‌స్టార్|జీ5|సన్ నెక్స్ట్|గ్లామర్|స్టార్/, s: 'Cinema' },
  { re: /జలాశయం|డ్యామ్|కాలువ|నీటి మట్టం|వరద నీరు|వరద|ఆనకట్ట|నీటి వనరులు|నదీ జలాలు|శ్రీశైలం|నాగార్జున సాగర్|గోదావరి నది|కృష్ణా నది|తుంగభద్ర|నీటి విడుదల|జల విద్యుత్|జలయజ్ఞం|పులిచింతల|శ్రీరాంసాగర్/, s: 'Irrigation' },
  { re: /రహదారి|హైవే|ఫ్లైఓవర్|వంతెన|ఓవర్‌బ్రిడ్జ్|రహదారులు|రోడ్డు|అండర్‌పాస్|ఎక్స్‌ప్రెస్‌వే|జాతీయ రహదారి|వంతెన నిర్మాణం|భవనం|అపార్ట్‌మెంట్|కూల్చివేత|అక్రమ నిర్మాణం|గుంతలు|ట్రాఫిక్ జామ|టోల్ప్లాజా|రోడ్డు నిర్మాణం/, s: 'Roads & Buildings' },
  { re: /ఆంధ్ర|అమరావతి|విజయవాడ|జగన్|చంద్రబాబు|విజాగ్|విశాఖపట్నం|నెల్లూరు|కడప|కర్నూలు|తిరుపతి|అనంతపురం|ఏలూరు|రాజమండ్రి|కాకినాడ|ఒంగోలు|గుంటూరు|లోకేష్|పవన్ కళ్యాణ్|పోలవరం|గన్నవరం|ఏపీ/, s: 'Andhra Pradesh' },
  { re: /హైదరాబాద్|తెలంగాణ|సికింద్రాబాద్|రేవంత్|కేటీఆర్|బీఆర్ఎస్|వరంగల్|నిజామాబాద్|కరీంనగర్|ఖమ్మం|మెదక్|నల్గొండ|మహబూబ్‌నగర్|రంగారెడ్డి|మేడ్చల్|సంగారెడ్డి|ఆసిఫాబాద్|కేసీఆర్|అక్బరుద్దీన్|మల్లారెడ్డి|హరీష్ రావు|ఓవైసీ/, s: 'Telangana' },
  { re: /కేంద్ర ప్రభుత్వం|లోక్‌సభ|రాజ్యసభ|కేంద్ర బడ్జెట్|భారత ప్రభుత్వం|మోదీ|అమిత్ షా|రాహుల్ గాంధీ|రాష్ట్రపతి|ఉపరాష్ట్రపతి|కేంద్ర మంత్రి|జాతీయ విధానం|కేంద్ర/, s: 'National' },
  { re: /విదేశీ|అంతర్జాతీయ|యుద్ధం|అమెరికా|రష్యా|చైనా|యూరప్|పాకిస్తాన్|ఇజ్రాయెల్|గాజా|ఉక్రెయిన్|బ్రిటన్|ఫ్రాన్స్|జపాన్|కొరియా|బంగ్లాదేశ్|నేపాల్|అఫ్ఘానిస్తాన్|ఐఎమ్ఎఫ్|ఐక్యరాజ్యసమితి|నాటో|రాయబారి|దౌత్యం|విదేశాంగ|ట్రంప్|పుతిన్|జిన్‌పింగ్/, s: 'International' },
  { re: /వ్యాపారం|ఆర్థిక|బ్యాంక్|షేర్|మార్కెట్|పన్ను|ఎకానమీ|ఇన్వెస్ట్‌మెంట్|లాభం|నష్టం|ద్రవ్యోల్బణం|జీడీపీ|ఐపీఓ|ఫండ్|ఆర్బీఐ|సెన్సెక్స్|నిఫ్టీ|ఉద్యోగం|ఉపాధి|కంపెనీ|కార్పొరేట్|ఎగుమతి|దిగుమతి|వాణిజ్యం|జీఎస్టీ|ఆదాయపు పన్ను|స్టాక్|వ్యాపార|ఫిన్‌టెక్|వ్యాపారవేత్త|ఎంఎస్ఎంఈ|బడ్జెట్/, s: 'Business' },
  { re: /అధికారి|కలెక్టర్|పరిపాలన|సంక్షేమ|ప్రభుత్వ పథకం|లబ్ధిదారు|జీఓ|ఐఏఎస్|ఐపీఎస్|జిల్లా కలెక్టర్|ప్రభుత్వ ఉద్యోగ|కార్యాలయం|ప్రభుత్వ నిధులు|సెక్రటేరియట్|రెవెన్యూ విభాగం|సర్కారు|ప్రభుత్వ ఉత్తర్వు/, s: 'Public Administration' },
  { re: /రాజకీయ|ఎన్నికలు|మంత్రి|నేత|పార్టీ|శాసనసభ|ముఖ్యమంత్రి|గవర్నర్|ఎమ్మెల్యే|ఎంపీ|సీఎం|ఎలక్షన్|ఓటు|మతదారులు|నియోజకవర్గం|టీడీపీ|వైఎస్ఆర్సీపీ|బీజేపీ|కాంగ్రెస్|బీఆర్ఎస్|జనసేన|ఆప్|ఎమ్ఐఎమ్|కూటమి|ప్రతిపక్షం|అధికారపక్షం|పార్టీ సభ|ప్రజాసభ|సెషన్|మీటింగ్|ర్యాలీ|పాద యాత్ర|ఓటుహక్కు|ఉప ఎన్నిక|ప్రచారం/, s: 'Politics' },
  { re: /భారత్|జాతీయ|ఢిల్లీ|పార్లమెంట్/, s: 'National' },
];

// ── URL → section override (same as ingest.js) ───────────────────────────────
const URL_SECTION_MAP = [
  { paths: ['/telangana'],                          section: 'Telangana' },
  { paths: ['/andhra-pradesh', '/andhra/'],          section: 'Andhra Pradesh' },
  { paths: ['/sports', '/cricket/'],                 section: 'Sports' },
  { paths: ['/movies', '/cinema', '/entertainmen'],  section: 'Cinema' },
  { paths: ['/business', '/economy', '/finance'],    section: 'Business' },
  { paths: ['/national', '/india/'],                 section: 'National' },
  { paths: ['/international', '/world/'],            section: 'International' },
  { paths: ['/politics', '/political'],              section: 'Politics' },
  { paths: ['/education'],                           section: 'Education' },
  { paths: ['/agriculture', '/farming'],             section: 'Agriculture' },
  { paths: ['/crime', '/police/', '/law/'],          section: 'Crime & Police' },
  { paths: ['/technology', '/tech/', '/cyber'],      section: 'Technology' },
  { paths: ['/health', '/medical'],                  section: 'Public Health' },
  { paths: ['/courts', '/legal', '/judiciary'],      section: 'Courts' },
  { paths: ['/railways', '/railway/', '/metro/'],    section: 'Railways' },
  { paths: ['/family', '/lifestyle'],                section: 'Family' },
  { paths: ['/women', '/mahila'],                    section: 'Women' },
];

function sectionFromUrl(url) {
  if (!url) return null;
  const path = url.toLowerCase();
  for (const entry of URL_SECTION_MAP) {
    if (entry.paths.some(p => path.includes(p))) return entry.section;
  }
  return null;
}

function classifyHeadline(text) {
  for (const { re, s } of SECTION_MAP) { if (re.test(text)) return s; }
  for (const { re, s } of TELUGU_MAP)  { if (re.test(text)) return s; }
  return 'General';
}

// ── Module-level normHead — used for both dedup AND RSS key matching ─────────
// Strips zero-width characters (U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM, U+00A0 NBSP),
// collapses whitespace, lowercases. Sakshi CMS embeds ZWNJ in Telugu titles; the
// RSS feed version of the same article often omits it. Without stripping them,
// a scraped headline "కేబీఆర్‌" won't match its RSS counterpart "కేబీఆర్",
// leaving those articles without a summary.
//
// Also used by normHead() inside _doScrapeWork() — the local alias is kept for
// backward compatibility with the existing seenHeads dedup there.
function normHead(s) {
  return (s || '').replace(/[​-‍﻿ ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── Next.js __NEXT_DATA__ extractor ──────────────────────────────────────────
// Next.js embeds all SSR page data as JSON in <script id="__NEXT_DATA__">.
// This contains the full article list before JS hydration — much more complete
// than what cheerio CSS selectors can find in the static HTML.
function extractNextData(html, baseUrl, forcedSection) {
  const results = [];
  const seen    = new Set();

  // Find the __NEXT_DATA__ script block
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return results;

  let data;
  try { data = JSON.parse(m[1]); } catch (_) { return results; }

  // Recursively harvest objects that look like articles
  // We don't know the exact structure, so we traverse all objects and collect
  // any that have a Telugu-looking "title" (or "name"/"heading") + a url/alias/path.
  function harvest(node, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      for (const item of node) harvest(item, depth + 1);
      return;
    }

    // Candidate article object: has a title-like field that's a Telugu string
    const titleField = node.title || node.name || node.heading || node.headline
      || node.field_title || node.node_title || node.article_title;

    if (typeof titleField === 'string' && titleField.length >= 15 && titleField.length <= 400) {
      const teluguCount = (titleField.match(/[ఀ-౿]/g) || []).length;
      if (teluguCount >= 3) {  // must have at least 3 Telugu chars
        const rawUrl = node.url || node.alias || node.path || node.slug || node.link
          || node.field_url || node.canonical_url || '';
        const href = rawUrl
          ? (rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, baseUrl).href)
          : '';

        const headlineClean = cleanHeadline(titleField);
        if (!seen.has(headlineClean)) {
          seen.add(headlineClean);
          const section = forcedSection
            || (href ? sectionFromUrl(href) : null)
            || classifyHeadline(headlineClean);

          // ⚠️ We intentionally DO NOT pull body/description from __NEXT_DATA__ nodes.
          // The recursive harvest picks up related-article objects whose body field
          // contains a DIFFERENT article's text, causing Gemini to use the wrong
          // description. Storing an empty summary is safer — buildArticleContext()
          // will mark it "(not available)" and Gemini shows just the headline.
          results.push({ headline: headlineClean, section, summary: '', url: href });
        }
      }
    }

    // Recurse into all child objects/arrays
    for (const val of Object.values(node)) {
      if (val && typeof val === 'object') harvest(val, depth + 1);
    }
  }

  harvest(data, 0);
  return results;
}

// ── News sitemap parser — reliable source of today's 100-200 article URLs ─────
// Google News sitemaps contain <loc> (URL) + <news:title> for every recent article.
// This runs once per scrape cycle alongside the section-page fetches.
async function fetchFromNewsSitemap(sitemapUrl) {
  const results = [];
  try {
    const res = await fetchPage(sitemapUrl);
    // Extract <url><loc>URL</loc>...<news:title>TITLE</news:title>...</url> blocks
    const urlBlocks = res.match(/<url>[\s\S]*?<\/url>/gi) || [];
    const seen = new Set();

    for (const block of urlBlocks) {
      const locM   = block.match(/<loc>\s*(.*?)\s*<\/loc>/i);
      const titleM = block.match(/<news:title>\s*(.*?)\s*<\/news:title>/i)
        || block.match(/<title>\s*(.*?)\s*<\/title>/i);

      if (!locM || !titleM) continue;
      const href  = locM[1].replace(/&amp;/g, '&').trim();
      const title = titleM[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

      if (!title || title.length < 15 || seen.has(title)) continue;
      if (!href.includes('sakshi.com')) continue;

      // Sitemap may include English articles — skip pure-English on Telugu site
      const teluguCount = (title.match(/[ఀ-౿]/g) || []).length;
      if (teluguCount === 0) continue;

      seen.add(title);
      const section = sectionFromUrl(href) || classifyHeadline(title);
      results.push({ headline: title, section, summary: '', url: href });
    }
    console.log(`[NewsAI Scrape]   ✓ news-sitemap → ${results.length} articles`);
  } catch (err) {
    console.warn(`[NewsAI Scrape]   ✗ news-sitemap: ${err.message}`);
  }
  return results;
}

// ── Fetch one page with a browser-like UA ────────────────────────────────────
// Optional `signal` lets callers wire in an AbortController (e.g. the per-request
// timeout in fetchArticleBodies). Existing callers pass no options and are unaffected.
async function fetchPage(url, { signal } = {}) {
  const res = await fetch(url, {
    timeout: 15000,
    signal,
    headers: {
      'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'te-IN,te;q=0.9,en-IN;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control':   'no-cache',
      'Pragma':          'no-cache',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── Parse one HTML page and return article objects ───────────────────────────
// Strategy: __NEXT_DATA__ first (comprehensive) → CSS selectors (fallback)
function extractFromHtml(html, baseUrl, forcedSection) {
  // Try __NEXT_DATA__ first — gives 10-30 articles per page reliably
  const nextDataArticles = extractNextData(html, baseUrl, forcedSection);
  if (nextDataArticles.length > 0) {
    console.log(`[NewsAI Scrape]     __NEXT_DATA__: ${nextDataArticles.length} articles from ${baseUrl}`);
  }

  // Always also run cheerio selectors — they catch articles not in __NEXT_DATA__
  const $       = cheerio.load(html);
  const results = [...nextDataArticles];  // start with __NEXT_DATA__ results
  const seen    = new Set(nextDataArticles.map(a => a.headline));

  for (const selector of SELECTORS) {
    try {
      $(selector).each((_, el) => {
        if (results.length >= 200) return false;

        const $el     = $(el);
        const $anchor = $el.is('a') ? $el : $el.find('a').first();

        const rawText  = ($anchor.length ? $anchor : $el).text().replace(/\s+/g, ' ').trim();
        const headline = cleanHeadline(rawText.replace(/^\+\d+\s+/, '').replace(/^\d+s\s+/, ''));

        if (!headline || headline.length < 20 || headline.length > 300) return;
        if (seen.has(headline)) return;
        if (/^\[(Story|Video|Ad|Sponsored|Watch)\]/i.test(headline)) return;

        // sakshi.com is a Telugu paper — skip pure-English headlines (ad injections)
        const teluguCount = (headline.match(/[ఀ-౿]/g) || []).length;
        if (teluguCount === 0) return;
        if (/\(ఫొటోలు\)$/.test(headline.trim())) return;

        seen.add(headline);

        let href = ($anchor.attr('href') || '').trim();
        if (href && !href.startsWith('http')) {
          try { href = new URL(href, baseUrl).href; } catch (_) { href = ''; }
        }
        if (!href || href.endsWith('#') || href.startsWith('#')) return;
        try {
          const parts = new URL(href).pathname.split('/').filter(Boolean);
          if (parts.length < 2) return;
        } catch (_) {}

        const $parent  = $el.closest('article, [class*="card"], [class*="story"], [class*="item"], li, .col');
        const summary  = $parent.length
          ? ($parent.find('p').first().text().trim() ||
             $parent.find('[class*="desc"],[class*="summary"],[class*="intro"],[class*="excerpt"]').first().text().trim() || '')
          : '';

        const section = forcedSection || sectionFromUrl(href) || classifyHeadline(headline);

        results.push({ headline, section, summary: summary.slice(0, 300), url: href });
      });
    } catch (_) {}

    if (results.length >= 300) break;
  }

  return results;
}

// ── RSS feed parser — fetches summaries for matched articles ─────────────────
// Returns Map<normalised_title, { summary, url, section }>
// Matched against the merged article list in doScrape() to populate summaries.
async function fetchRssSummaries() {
  const summaryMap = new Map(); // normTitle → { summary, url, section }

  await Promise.allSettled(RSS_FEEDS.map(async ({ url, section: forcedSection }) => {
    try {
      const xml = await fetchPage(url);

      // Parse <item> blocks. RSS 2.0 structure:
      //   <item><title>…</title><link>…</link><description>…</description></item>
      const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

      for (const item of items) {
        const titleM = item.match(/<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i);
        const descM  = item.match(/<description>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/description>/i);
        const linkM  = item.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i)
                    || item.match(/<guid[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/guid>/i);

        if (!titleM) continue;
        const rawTitle = titleM[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
        const title    = cleanHeadline(rawTitle);
        if (!title || title.length < 15) continue;

        // Strip HTML from description, decode entities, take first 300 chars
        let summary = '';
        if (descM) {
          summary = descM[1]
            .replace(/<[^>]+>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 300);
          // Skip if summary is just the headline repeated
          if (summary.toLowerCase().startsWith(title.toLowerCase().slice(0, 30))) {
            summary = '';
          }
        }

        const url2   = linkM ? linkM[1].trim() : '';
        const section = forcedSection || (url2 ? sectionFromUrl(url2) : null) || classifyHeadline(title);
        // Use normHead() — strips ZWNJ so RSS titles match their scraped equivalents.
        // Without this, "కేబీఆర్‌" (with ZWNJ from scraper) ≠ "కేబీఆర్" (RSS),
        // causing the summary lookup in doScrape() to always miss.
        const key    = normHead(title);

        if (!summaryMap.has(key) && summary) {
          summaryMap.set(key, { summary, url: url2, section });
        }
      }
      console.log(`[NewsAI Scrape]   ✓ RSS ${url.replace('https://www.sakshi.com', '')||'/'} → ${summaryMap.size} total summaries so far`);
    } catch (err) {
      console.warn(`[NewsAI Scrape]   ✗ RSS ${url}: ${err.message}`);
    }
  }));

  return summaryMap;
}

// ── Article body fetcher — fills empty summaries from article pages ───────────
// After the merge we have 100+ articles, many with summary=''. This function
// fetches the individual article pages under a concurrency cap (3 at a time)
// and extracts the first paragraph as the summary.
// We only process articles that (a) have a URL and (b) have no summary yet.
// We cap at MAX_BODY_FETCHES to keep doScrape() total time under ~3 minutes.
const MAX_BODY_FETCHES      = 40;
const BODY_FETCH_CONCUR     = 3;      // max simultaneous body fetches (semaphore cap)
const BODY_FETCH_TIMEOUT_MS = 8000;   // per-request abort deadline — one slow page can't stall the scrape

async function fetchArticleBodies(articles) {
  const needsBody = articles.filter(a => !a.summary && a.url).slice(0, MAX_BODY_FETCHES);
  if (!needsBody.length) return;

  console.log(`[NewsAI Scrape] 📄 Fetching bodies for ${needsBody.length} articles (max ${BODY_FETCH_CONCUR} concurrent, ${BODY_FETCH_TIMEOUT_MS}ms timeout)…`);

  // ── Counter-based semaphore ───────────────────────────────────────────────
  // Caps concurrent body fetches at BODY_FETCH_CONCUR. `active` tracks in-flight
  // fetches; when at capacity, acquire() parks the caller by pushing its resolver
  // onto `queue`. release() wakes the next waiter. No external library needed.
  let active = 0;
  const queue = [];
  function acquire() {
    if (active < BODY_FETCH_CONCUR) { active++; return Promise.resolve(); }
    return new Promise(resolve => queue.push(resolve));
  }
  function release() {
    active--;
    const next = queue.shift();
    if (next) { active++; next(); }   // hand the freed slot straight to the next waiter
  }

  // Fetch a single article body under the semaphore, guarded by an 8s timeout.
  async function fetchOne(a) {
    await acquire();
    try {
      // ── SSRF guard ────────────────────────────────────────────────────────
      // Article URLs come from scraped HTML/sitemap/RSS and are attacker-influenceable.
      // A poisoned link to localhost, 169.254.169.254 (cloud metadata), or an internal
      // service would otherwise be fetched by the backend. Skip anything unsafe.
      // (release() still runs in the finally below.)
      if (!isSafeUrl(a.url)) {
        console.warn(`[NewsAI Scrape] ⛔ Body fetch blocked (unsafe URL): ${a.url}`);
        return;
      }
      // Per-request timeout: abort the fetch if Sakshi is slow / rate-limiting us.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BODY_FETCH_TIMEOUT_MS);
      try {
        const html = await fetchPage(a.url, { signal: controller.signal });
        const body = extractBodyFromArticlePage(html, a.headline);
        if (body) a.summary = body;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      // Timeout (AbortError) or fetch failure — skip this body silently, don't crash.
      const reason = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'error';
      console.warn(`[NewsAI Scrape]   ⚠️  body fetch skipped (${reason}): ${a.url}`);
    } finally {
      release();
    }
  }

  // Kick off all fetches; the semaphore keeps only BODY_FETCH_CONCUR running at once.
  await Promise.all(needsBody.map(fetchOne));

  const filled = needsBody.filter(a => a.summary).length;
  console.log(`[NewsAI Scrape]   ✓ Body fetch: ${filled}/${needsBody.length} filled`);
}

// ── Article-body extractor (Bug 1 fix) ───────────────────────────────────────
// Sakshi.com runs Drupal 10 (NOT Next.js — confirmed in configs/sakshi.json
// _notes.cms). The old __NEXT_DATA__ approach therefore never matched, which is
// exactly what the "__NEXT_DATA__ NOT found" logs showed, and the cheerio
// fallback selectors didn't match the real markup either → 0 bodies stored.
//
// New strategy order (first hit wins), all returning PLAIN TEXT ≥ 50 chars and
// never merely echoing the headline:
//   1. JSON-LD  — Drupal's schema.org metatag module emits
//                 <script type="application/ld+json"> with a NewsArticle whose
//                 `articleBody` (or `description`) is the real story text.
//   2. Cheerio  — Drupal body-field containers (.field--name-body, article, …).
//   3. Generic  — class-agnostic harvest of the Telugu <p> run left after the
//                 nav/related/footer chrome is stripped (works on any theme;
//                 this is what a readability pass keys off, and it always works).
//   4. Meta     — og:description / meta[name=description] as a short last resort.
//   5. __NEXT_DATA__ (legacy) — kept ONLY so a future Next.js client still works;
//                 virtually never matches on Sakshi.
//
// ── Debug logging (Bug 1 diagnosis) ──────────────────────────────────────────
// Trace only the first BODY_DBG_MAX pages to avoid 40× log spam. The trace now
// reports which of the strategies above produced (or failed to produce) a body.
let _bodyDbgCount = 0;
const BODY_DBG_MAX = 8;
const BODY_MAX_CHARS = 500;   // was 300 — a fuller lead gives the AI real context

// Walk a parsed JSON-LD value (object, array, or @graph wrapper) and return the
// first NewsArticle/Article `articleBody` (preferred) or `description` string.
function findInJsonLd(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findInJsonLd(n); if (r) return r; }
    return null;
  }
  if (Array.isArray(node['@graph'])) {
    const r = findInJsonLd(node['@graph']);
    if (r) return r;
  }
  const type = node['@type'];
  const isArticle = type && (Array.isArray(type)
    ? type.some(t => /article/i.test(String(t)))
    : /article/i.test(String(type)));
  if (isArticle) {
    if (typeof node.articleBody === 'string' && node.articleBody.trim().length > 50) return node.articleBody;
    if (typeof node.description === 'string' && node.description.trim().length > 50) return node.description;
  }
  // Some emitters attach articleBody without an @type — accept it too.
  if (typeof node.articleBody === 'string' && node.articleBody.trim().length > 50) return node.articleBody;
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') { const r = findInJsonLd(v); if (r) return r; }
  }
  return null;
}

function extractBodyFromArticlePage(html, headline) {
  const dbgOn = _bodyDbgCount++ < BODY_DBG_MAX;
  const log = (...a) => { if (dbgOn) console.log('[NewsAI Scrape][body-debug]', ...a); };

  const hl = (headline || '').trim();

  // Decode entities + strip tags → plain text.
  const toText = (s) => (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  // A candidate is usable only if it is ≥ 50 chars AND is not just the headline.
  const norm = (s) => (s || '').toLowerCase().replace(/[\s​-‍]/g, '');
  const isUsable = (t) => {
    const clean = toText(t);
    if (clean.length < 50) return false;
    if (hl && clean.length <= hl.length + 20 && norm(clean) === norm(hl)) return false;
    return true;
  };
  const clip = (t) => toText(t).slice(0, BODY_MAX_CHARS);

  // ── Strategy 1: JSON-LD (schema.org NewsArticle) ─────────────────────────
  const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldBlocks) {
    const jsonText = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch (_) { continue; }
    const found = findInJsonLd(parsed);
    if (found && isUsable(found)) {
      log(`JSON-LD articleBody OK (${toText(found).length} chars) for "${hl.slice(0, 40)}"`);
      return clip(found);
    }
  }

  // ── Strategy 2: cheerio on the Drupal article body ───────────────────────
  const $ = cheerio.load(html);
  // Strip page chrome so unrelated paragraphs can't leak into the body.
  $('script, style, nav, header, footer, aside, form, noscript, iframe, figure, figcaption, '
    + '.comment, [class*="related"], [class*="recommend"], [class*="also-read"], '
    + '[class*="trending"], [class*="widget"], [class*="advert"], [class*="social"], '
    + '[class*="breadcrumb"], [class*="tags"], [class*="author"]').remove();

  const bodySelectors = [
    '[property="schema:text"]',
    '.field--name-body', '.field-name-body', '.field-name-field-body',
    '.node__content .field--type-text-with-summary',
    '.story-content', '.article-body', '.article-content', '.articleBody',
    '.content-area', '.entry-content', '.node__content',
    'article',
  ];
  for (const sel of bodySelectors) {
    const $c = $(sel).first();
    if (!$c.length) continue;
    // Join the Telugu paragraphs inside this container (real story text).
    const paras = $c.find('p').map((_, p) => toText($(p).text())).get()
      .filter(t => t.length > 30 && /[ఀ-౿]/.test(t));
    const joined = [...new Set(paras)].join(' ');
    if (isUsable(joined)) {
      log(`cheerio body via "${sel}" (${paras.length} paras, ${toText(joined).length} chars)`);
      return clip(joined);
    }
    // Some themes drop the text straight into the container (no <p> wrappers).
    if (paras.length === 0) {
      const raw = toText($c.text());
      if (isUsable(raw)) { log(`cheerio body via "${sel}" (container text, ${raw.length} chars)`); return clip(raw); }
    }
  }

  // ── Strategy 3: generic Telugu-paragraph harvest (theme-agnostic) ─────────
  // After the chrome removal above, the remaining <p> run in document order is
  // the article lead. This is what a readability pass extracts and it reliably
  // works even when the theme's class names differ from the list above.
  const genParas = [...new Set(
    $('p').map((_, p) => toText($(p).text())).get()
      .filter(t => t.length > 40 && /[ఀ-౿]/.test(t))
  )].slice(0, 8);
  const genJoined = genParas.join(' ');
  if (isUsable(genJoined)) {
    log(`cheerio generic paragraph harvest (${genParas.length} paras, ${toText(genJoined).length} chars)`);
    return clip(genJoined);
  }

  // ── Strategy 4: meta description (short, but always present in the head) ──
  const metaDesc =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') || '';
  if (isUsable(metaDesc)) { log(`meta description fallback (${toText(metaDesc).length} chars)`); return clip(metaDesc); }

  // ── Strategy 5 (legacy): __NEXT_DATA__ — Sakshi is Drupal, so this virtually
  // never matches; retained so a future Next.js-based client still extracts.
  const ndMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (ndMatch) {
    try {
      const body = findDeepestBody(JSON.parse(ndMatch[1]), headline, 0);
      if (isUsable(body)) { log(`__NEXT_DATA__ legacy body (${toText(body).length} chars)`); return clip(body); }
    } catch (_) {}
  }

  log(`no body found (JSON-LD / cheerio / generic / meta / __NEXT_DATA__) for "${hl.slice(0, 40)}" (htmlLen=${html.length})`);
  return '';
}

// Recursively find a body string that's substantially longer than the headline
// and appears to be narrative text (has Telugu chars or >80 ASCII chars).
//
// Headline-token validation: before accepting a candidate body, verify it shares
// at least one significant word (>4 chars) with the headline. This prevents
// "related article" objects embedded in __NEXT_DATA__ from contaminating the
// result with a different article's body text — the same cross-article issue we
// fixed for section pages, but now applied to individual article pages too.
function findDeepestBody(node, headline, depth, _ctx) {
  // Root call: build the shared context (headline tokens + a fallback slot).
  // _ctx is threaded through the whole recursion so `fallback` — the best body we
  // saw that had real content but didn't literally share a headline token — is
  // remembered across branches and can be accepted if nothing better turns up.
  if (!_ctx) {
    _ctx = {
      tokens:   (headline || '').split(/\s+/).filter(t => t.length > 4),
      fallback: null,
    };
  }

  if (!node || typeof node !== 'object' || depth > 8) return null;

  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findDeepestBody(v, headline, depth + 1, _ctx);
      if (r) return r;
    }
    return (depth === 0 && _ctx.fallback) ? _ctx.fallback : null;
  }

  // Check candidate body fields on this node
  const bodyFields = ['body', 'articleBody', 'field_body', 'content', 'description', 'field_description'];
  for (const f of bodyFields) {
    let val = node[f];
    // Unwrap CMS rich-text fields that store the body as an object/array rather
    // than a plain string (e.g. { value, format } / { processed } / { rendered },
    // or an array of block objects). Without this the body path silently misses.
    if (val && typeof val === 'object') {
      if      (typeof val.value     === 'string') val = val.value;
      else if (typeof val.processed === 'string') val = val.processed;
      else if (typeof val.rendered  === 'string') val = val.rendered;
      else if (typeof val.html      === 'string') val = val.html;
      else if (typeof val.text      === 'string') val = val.text;
    }
    if (typeof val === 'string' && val.length > (headline || '').length + 40) {
      // Strip HTML tags and decode entities
      const clean = val.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      // Must have Telugu chars OR be substantial ASCII text
      const hasContent = /[ఀ-౿]/.test(clean) || clean.length > 100;
      if (!hasContent) continue;
      // ── Headline-token PREFERENCE (not a hard reject) ──────────────────────
      // A body that shares a significant word with the headline is almost
      // certainly THIS article's body → accept immediately. One that doesn't may
      // be a related/sidebar node OR simply a Telugu lead that paraphrases the
      // headline. We can't tell them apart, so we remember the first such body as
      // a fallback and keep searching for a token match. Previously this was a
      // hard `continue`, which rejected legitimate paraphrased leads and zeroed
      // out every body (the "0/40 filled" bug).
      if (_ctx.tokens.length > 0) {
        const cleanLower = clean.toLowerCase();
        const hasSharedToken = _ctx.tokens.some(t => cleanLower.includes(t.toLowerCase()));
        if (hasSharedToken) return clean;
        if (!_ctx.fallback) _ctx.fallback = clean;   // remember, but prefer a token match
        continue;
      }
      return clean;
    }
  }
  // Recurse into object values
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const r = findDeepestBody(v, headline, depth + 1, _ctx);
      if (r) return r;
    }
  }
  // Root call with no token match anywhere → accept the best-effort fallback body.
  return (depth === 0 && _ctx.fallback) ? _ctx.fallback : null;
}

// ── Core scrape logic — called directly by the auto-poll loop ────────────────
// Returns { scraped, ingested, skipped, sections, total, elapsed }
//
// Concurrency guard: startup, the 2-hour poll interval, and the manual trigger
// can all fire simultaneously. Without this flag, two concurrent doScrape() runs
// would double the outbound bandwidth and body-fetching load on Sakshi.com.
// The guard keeps a reference to the active promise so callers can await it too.
let _scrapePromise = null;

async function doScrape() {
  if (_scrapePromise) {
    console.log('[NewsAI Scrape] Already running — returning existing promise');
    return _scrapePromise;
  }
  _scrapePromise = _doScrapeWork().finally(() => { _scrapePromise = null; });
  return _scrapePromise;
}

async function _doScrapeWork() {
  const t0 = Date.now();

  // Reset body-fetch debug counter so each scrape cycle gets its own 8-page trace.
  // Without this, after the first 8 article-body fetches (ever), _bodyDbgCount stays
  // ≥ BODY_DBG_MAX and ALL future scrapes have zero body-debug output.
  _bodyDbgCount = 0;

  // Prune articles older than 24 hours before ingesting new ones.
  // Keeps the store lean (only today's content) and prevents Gemini from being
  // shown stale yesterday's articles that survived a server restart.
  pruneOldArticles(24);

  // Fetch section pages + news sitemap + RSS feeds in parallel
  const [pageResults, sitemapArticles, rssSummaries] = await Promise.all([
    Promise.allSettled(
      SECTION_PAGES.map(async ({ url, section }) => {
        try {
          const html     = await fetchPage(url);
          const articles = extractFromHtml(html, url, section);
          console.log(`[NewsAI Scrape]   ✓ ${url.replace('https://www.sakshi.com', '')||'/'} → ${articles.length}`);
          return articles;
        } catch (err) {
          console.warn(`[NewsAI Scrape]   ✗ ${url}: ${err.message}`);
          return [];
        }
      })
    ),
    fetchFromNewsSitemap(NEWS_SITEMAP_URL),
    fetchRssSummaries(),
  ]);

  // Merge — deduplicate by headline across all pages + sitemap
  const merged    = [];
  const seenUrls  = new Set();
  const seenHeads = new Set();

  // normHead() is now module-scope (defined near classifyHeadline) — used here directly.


  function mergeArticle(a) {
    const hn = normHead(a.headline);
    if (seenHeads.has(hn)) return;
    if (a.url && seenUrls.has(a.url)) return;
    seenHeads.add(hn);
    if (a.url) seenUrls.add(a.url);
    merged.push(a);
  }

  // Section pages first (they have section hints), then sitemap (fills gaps)
  for (const r of pageResults) {
    if (r.status !== 'fulfilled') continue;
    for (const a of r.value) mergeArticle(a);
  }
  for (const a of sitemapArticles) mergeArticle(a);

  console.log(`[NewsAI Scrape] 📊 Merged: ${merged.length} unique articles`);

  // ── Enrich summaries from RSS feeds ────────────────────────────────────────
  // RSS <description> fields give us real article summaries. Match by normalised
  // title and fill in the `summary` field for any article that doesn't have one.
  let rssEnriched = 0;
  for (const a of merged) {
    if (a.summary) continue;                         // already has content
    // normHead() strips ZWNJ so the scraped headline matches its RSS counterpart.
    const key = normHead(a.headline);
    const hit = rssSummaries.get(key);
    if (hit && hit.summary) {
      a.summary = hit.summary;
      if (!a.section || a.section === 'General') a.section = hit.section || a.section;
      rssEnriched++;
    }
  }
  if (rssEnriched) console.log(`[NewsAI Scrape]   ✓ RSS enriched ${rssEnriched} article summaries`);

  // ── Fetch article bodies for remaining no-summary articles ─────────────────
  await fetchArticleBodies(merged);

  // Ingest into store
  let ingested  = 0;
  let skipped   = 0;
  const sections = new Set();

  for (const a of merged) {
    try {
      const before = store.getStats().total;
      store.addArticle({
        title:    a.headline,
        section:  a.section,
        tags:     [],
        content:  a.summary,
        url:      a.url,
        language: 'te',
      });
      if (store.getStats().total > before) { ingested++; sections.add(a.section); }
      else skipped++;
    } catch (_) { skipped++; }
  }

  // ── Invalidate the Gemini context cache after a fresh ingest ───────────────
  // The context cache has a 23-hour TTL. Without invalidation, newly-scraped
  // articles stay invisible to chat users — every request takes the cache-overlay
  // path (which holds the OLD article set) instead of building fresh context.
  // Clearing here makes getCacheId() return null so the next chat request rebuilds
  // context from the current store; server.js's runPostScrapePipeline() then rebuilds
  // the Gemini cache immediately after doScrape() resolves.
  // Only clear when we actually added new articles — a dupe-only run keeps the
  // existing cache warm and avoids a needless delete+recreate cycle.
  if (ingested > 0) {
    clearCache();
    console.log('[NewsAI Scrape] 🧹 Gemini context cache invalidated (fresh articles ingested)');
  }

  const elapsed = Date.now() - t0;
  return {
    scraped:  merged.length,
    ingested,
    skipped,
    sections: [...sections].sort(),
    total:    store.getStats().total,
    elapsed:  `${elapsed}ms`,
  };
}

// ── Express route handler — POST /api/scrape-sakshi ─────────────────────────
async function scrapeSakshi(req, res) {
  console.log('[NewsAI Scrape] 🌐 Manual scrape triggered via portal…');
  try {
    const result = await doScrape();
    console.log(`[NewsAI Scrape] ✅ ${result.ingested} new, ${result.skipped} dupes, ${result.elapsed}`);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[NewsAI Scrape] ❌ Failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = { doScrape, scrapeSakshi };
