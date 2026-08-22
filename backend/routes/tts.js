'use strict';

/**
 * POST /api/tts
 * Body: { text: string, lang: "te" | "en", voice?: string }
 * Returns: audio/wav — Sarvam Bulbul v3 WAV audio
 *
 * Uses Sarvam AI Bulbul v3 TTS (https://api.sarvam.ai/text-to-speech)
 * Set SARVAM_API_KEY in backend/.env
 *
 * Features:
 *   - Emotion-aware pace (grief / controversy / business / cinema / sports / neutral)
 *   - Auto-chunking for texts > 2400 chars with parallel synthesis
 *   - WAV PCM concatenation for seamless multi-chunk audio
 *   - pace is the ONLY prosody control in bulbul:v3 (pitch/loudness are v2-only)
 */

const https  = require('https');
const crypto = require('crypto');

// ── TTS audio cache (streaming route) ─────────────────────────────────────────
// The /api/tts/stream route emits an SSE sequence (meta → chunk[] → done, each
// carrying base64 WAV). Re-synthesising the SAME text (breaking-news pre-warm,
// replays, identical section digests) burns paid Sarvam calls. We cache the full
// SSE payload per (lang+speaker+text) key and replay it verbatim on a hit — the
// client's SSE parser is unchanged.
//
// NOTE (divergence from spec): the streaming route is SSE-based, NOT a raw
// audio/mpeg body, so we cache/replay the SSE bytes (Content-Type
// text/event-stream) rather than an audio/mpeg Buffer. Same cache semantics.
// TTS_CACHE_ENABLED — set false to skip Sarvam calls for cache-building and
// credit accumulation. Re-enable when credits are replenished.
const TTS_CACHE_ENABLED = false;
const _ttsCache     = new Map();          // key → { sse: Buffer, cachedAt: number }
const TTS_CACHE_TTL = 30 * 60 * 1000;     // 30 minutes
const TTS_CACHE_MAX = 100;

function ttsCacheKey(lang, text) {
  return crypto.createHash('sha1').update(lang + ':' + text).digest('hex');
}
function _ttsCacheGet(key) {
  const e = _ttsCache.get(key);
  if (!e) return null;
  if (Date.now() - e.cachedAt > TTS_CACHE_TTL) { _ttsCache.delete(key); return null; }
  return e;
}
function _ttsCacheSet(key, sse) {
  if (_ttsCache.size >= TTS_CACHE_MAX) {
    _ttsCache.delete(_ttsCache.keys().next().value);  // evict oldest
  }
  _ttsCache.set(key, { sse, cachedAt: Date.now() });
}

// ── Sarvam AUDIO CHUNK cache (all routes) ────────────────────────────────────
// Separate from the SSE-payload cache above. This one caches the raw WAV Buffer
// returned by Sarvam for a single (text, voice, pace) triple, so the SAME chunk
// text — closing phrases ("ఏ వార్త గురించి మరింత తెలుసుకోవాలంటే అడగండి"),
// section labels, repeated headlines across digests — is never re-synthesised.
// This is the single biggest Sarvam-credit saver: it works at chunk granularity,
// so a response only has to share ONE phrase with a previous response to save a call.
//
// Key: sha1(text.trim()) + '_' + voice + '_' + round(pace*10)
//   pace is rounded to 1 decimal so minor float drift (1.1600000000000001 vs 1.16)
//   still hits the same entry.
// Eviction: plain LRU — on read we re-insert to move the entry to the tail of the
// Map's insertion order; on overflow we delete the head (least recently used).
const AUDIO_CACHE_MAX = 200;
const _audioCache = new Map();   // key → Buffer (raw WAV bytes from Sarvam)

function audioCacheKey(text, voice, pace) {
  return crypto.createHash('sha1').update(String(text).trim()).digest('hex')
       + '_' + voice
       + '_' + Math.round(Number(pace) * 10);
}

function audioCacheGet(key) {
  const buf = _audioCache.get(key);
  if (!buf) return null;
  _audioCache.delete(key);        // LRU touch — re-insert at tail
  _audioCache.set(key, buf);
  console.log(`[TTS-Cache] HIT key=${key} size=${buf.length}bytes`);
  return buf;
}

function audioCacheSet(key, buf) {
  // Only successful, non-empty responses are cacheable.
  if (!Buffer.isBuffer(buf) || buf.length === 0) return;
  if (_audioCache.has(key)) _audioCache.delete(key);
  else if (_audioCache.size >= AUDIO_CACHE_MAX) {
    _audioCache.delete(_audioCache.keys().next().value);   // evict least-recently-used
  }
  _audioCache.set(key, buf);
}

const SARVAM_TTS_HOST = 'api.sarvam.ai';
const SARVAM_TTS_PATH = '/text-to-speech';
const MAX_CHUNK_CHARS = 480;    // Sarvam actual limit: 500 chars/input — leave 20 char margin

// ── Shared HTTPS agent ────────────────────────────────────────────────────────
// BUG FIX: callSarvamOnce previously did `new https.Agent()` on every call. Under
// high traffic (many concurrent + sequential TTS requests) that allocates a brand
// new Agent object per chunk — needless GC churn and, on some Node versions, lingering
// agent/socket objects until GC catches up.
//
// keepAlive:false already guarantees the property we actually need: sockets are never
// pooled or reused, so no TLS *connection* is shared between two parallel chunk requests
// (the original "bad_record_mac" trigger). maxCachedSessions:0 additionally disables TLS
// session-ticket resumption, so every request performs a fresh handshake — exactly the
// old per-call behaviour, but with a single reusable agent instead of one-per-call.
const sarvamAgent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });

// ── Speaker map ───────────────────────────────────────────────────────────────
// Sarvam Bulbul v3 confirmed speaker list:
// Female: ritu, priya, neha, pooja, simran, kavya, ishita, shreya, roopa, tanya, shruti, suhani
// Male:   aditya, ashutosh, rahul, rohan, amit, dev, ratan, varun, manan, sumit, kabir,
//         aayan, shubh, advait, anand, tarun, sunny, mani, gokul, vijay, mohit, rehan, soham
// NOTE: anushka/vidya/abhilash/karun are NOT in bulbul:v3 (they belong to a different model tier)
const SPEAKER_MAP = {
  'te':        'ishita',    // Telugu female — warm, melodic (overrideable via config ttsVoice)
                           // Alternatives to try: kavya, priya, suhani, tanya, shruti
  'te-female': 'roopa',
  'te-male':   'rahul',   // Telugu male
  'en':        'neha',    // English female
  'en-female': 'neha',
  'en-male':   'rohan',   // English male
};
const ALLOWED_SPEAKERS = new Set(Object.values(SPEAKER_MAP));

// ── Language code map ─────────────────────────────────────────────────────────
const LANG_CODE_MAP = {
  te: 'te-IN',
  en: 'en-IN',
};

// ── Emotion-aware pace detection (scoring model) ──────────────────────────────
// bulbul:v3 supports ONLY pace (0.5–2.0).
// pitch and loudness are bulbul:v2 ONLY — never pass them with v3.
//
// Uses a SCORING approach instead of first-match:
//   - Every matching keyword adds weight to its category
//   - Telugu keywords score 2 (exact match), English score 1 (whole-word)
//   - Category with highest total score wins
//   - Minimum score of 2 required to avoid single-word false positives
//   - Prevents false positives: a cinema article mentioning "death scene" gets
//     grief score=2 but cinema score=8 → cinema pace correctly wins
//
// Pace values — MINIMUM FLOOR IS 1.00 (human news-anchor baseline):
//   1.02 = grief / disaster / obituary  (solemn but not dragged)
//   1.05 = neutral / politics           (standard news pace)
//   1.08 = controversy / arrest / legal (measured, serious)
//   1.08 = business / economy           (clear, authoritative)
//   1.10 = breaking / urgent / alert    (tense, deliberate)
//   1.14 = cinema / culture / festival  (warm, engaging)
//   1.16 = celebration / inauguration   (uplifting)
//   1.20 = sports / victory             (energetic, upbeat)

const EMOTION_CATS = {
  grief: {
    pace: 1.02,   // solemn but not dragged — floor is 1.00
    te: [
      // core
      'మరణం','మృతి','ప్రమాదం','విషాదం','నిర్యాణం','దుర్ఘటన','కన్నీరు','విపత్తు','శోకం',
      'హత్య','వరద','భూకంపం','తుఫాను','ఆత్మహత్య','అగ్నిప్రమాదం','పేలుడు','మృతదేహం',
      'మరణించ','శవాలు','బాధితులు','గాయాలు','కాల్పులు','నష్టం','దారుణం','దుఃఖం',
      'పరిహారం','రక్తపాతం','సంతాపం','అశ్రువులు','విగతజీవి',
      // expanded Telugu newspaper vocabulary
      'మృతులు','మరణించారు','చనిపోయారు','బలైపోయారు','అమరులు','సమాధి','కాలం చేశారు',
      'దివంగతులు','అంత్యక్రియలు','శ్మశానం','దహనం','దహనసంస్కారాలు','గాయపడ్డారు',
      'క్షతగాత్రులు','చికిత్స','ఆసుపత్రి','తీవ్రంగా','ముంపు','కొట్టుకుపోయారు','ఉప్పెన',
      'వడగళ్లు','కరువు','కాటకం','మంట','విషాద వార్త','దురదృష్టం','విలపించారు',
      'నిరాశ్రయులు','శిథిలాలు','శిథిలం','ప్రాణనష్టం','ఆస్తినష్టం','సహాయ','వెతుకులాట',
      'గాలింపు','రక్షించారు','సహాయక బృందాలు','నష్టపోయారు','తుఫాన్','ప్రకృతి వైపరీత్యం',
      'వరద నీళ్లు','ముంచెత్తింది','కూలిపోయింది','కుప్పకూలింది','ధ్వంసమైంది',
      // task-expansion — disasters, accidents, deaths
      'తుది శ్వాస','కన్నుమూశారు','దేహం','శిశువు మరణం','రోడ్డు ప్రమాదం','తలకొట్టుకుపోయారు',
      'మిషన్ ఆగిపోయింది','నీట మునిగారు','పర్వతారోహణ ప్రమాదం','గ్యాస్ లీకేజ్','కోవిడ్ మరణాలు',
      'ఔషధ విషం','ఆహార విషం','విద్యుత్ షాక్','సర్పదంశం','అగ్నిప్రమాదంలో మృతి','రైలు ప్రమాదం',
      'పడవ మునక','విమాన ప్రమాదం','జలప్రళయం','బిల్డింగ్ కూలిపోయింది','మట్టి కొండచరియలు',
      'తుఫాన్ తాకిడి','పిల్లల మరణం','యువకుడి మృతి','మహిళ మరణం','అనారోగ్యంతో మరణం',
      'గుండెపోటుతో మరణం','ప్రాణాలు కోల్పోయారు','విగత జీవులు','కన్నుమూత','అకాల మరణం',
      'ప్రమాదంలో మృతి','దుర్మరణం','బలవన్మరణం','ఉరి వేసుకుని','ఆత్మహత్యాయత్నం','కాలిన గాయాలు',
      'పిడుగుపాటు','వరద బీభత్సం','ఉపద్రవం','దుర్భర పరిస్థితి','కుటుంబ విషాదం','శోకసంద్రం',
    ],
    en: [
      // core
      'death','died','killed','fatal','casualty','victim','flood','earthquake','cyclone',
      'tsunami','tornado','suicide','explosion','blast','attack','fire','shooting','stabbing',
      'massacre','accident','crash','collapsed','tragedy','mourning','memorial','funeral',
      'passes away','found dead','body found','perished','drowned',
      // expanded
      'landslide','avalanche','drowning','suffocation','wildfire','chemical leak','toxic',
      'dam burst','bridge collapse','train derailment','pile-up','sinking','missing persons',
      'hostage','kidnapping','murder','homicide','manslaughter','corpse','remains','deceased',
      'bereavement','condolences','obituary','tributes','last rites','disaster','calamity',
      'catastrophe','devastation','destroyed','washed away','swept away','trapped','rescued',
      'survivors','casualties','critically injured','hospitalized','intensive care',
      'dead on arrival','grieving','heartbreak','loss of life','mass casualty','fatalities',
    ],
  },
  controversy: {
    pace: 1.08,
    te: [
      // core
      'అరెస్టు','నిషేధం','వివాదం','ఆరోపణ','మోసం','ఘర్షణ','కాంట్రవర్సీ','తిరుగుబాటు',
      'నిరసన','సమ్మె','విమర్శ','కుంభకోణం','దర్యాప్తు','అభిశంసన','రద్దు','నిలిపివేత',
      'ఎఫ్ఐఆర్','ఛార్జ్‌షీట్','విచారణ','జైలు','అదుపు','తీవ్రవాది','అల్లర్లు','బంద్',
      'హర్తాల్','సస్పెండ్','తొలగింపు','శిక్ష','అక్రమం','అవినీతి',
      // expanded
      'కేసు నమోదు','పోలీసులు','రిమాండ్','బెయిల్','బెయిల్ నిరాకరణ','న్యాయవాది','కోర్టు',
      'హైకోర్టు','సుప్రీంకోర్టు','తీర్పు','పిటిషన్','అభ్యంతరం','ఆందోళన','ధర్నా',
      'రాస్తారోకో','ఆందోళనకారులు','నిర్బంధం','లాఠీఛార్జ్','అక్రమ వసూళ్లు','రాజీనామా',
      'పదవీ చ్యుతి','సస్పెన్షన్','తొలగించారు','బర్తరఫ్','అనర్హత','తప్పుడు సాక్ష్యం',
      'రాజకీయ కుట్ర','నిందితుడు','బాధిత','ఆర్థిక మోసం','అవినీతి కేసు',
      'ప్రభుత్వ నిర్లక్ష్యం','అక్రమ నిర్మాణం','వేధింపులు','అక్రమ సంబంధం',
      'జాతీయ భద్రత','రాజద్రోహం','మానవ హక్కులు','అటవీ అక్రమాలు',
      // task-expansion — political, legal, crime
      'ఆంక్షలు','కస్టడీ','జప్తు','నోటీసులు','దర్యాప్తు సంస్థలు','ఎన్‌ఫోర్స్‌మెంట్','ఆర్థిక నేరాలు',
      'నేర చరిత్ర','మోసగాళ్లు','కల్తీ','నకిలీ','మాయం','పారిపోయారు','వెల్లడి','సీజ్',
      'చట్టవ్యతిరేక','అక్రమ అమ్మకాలు','వేధింపు కేసు','అత్యాచారం','దోపిడీ','కిడ్నాప్','వేధింపు',
      'బ్లాక్‌మెయిల్','సైబర్ మోసం','దాడి కేసు','కుట్ర','ఫిర్యాదు','విజిలెన్స్','ఏసీబీ దాడులు',
      'లంచం','చేతివాటం','నగదు స్వాధీనం','అక్రమ రవాణా','స్మగ్లింగ్','మత్తు పదార్థాలు','గంజాయి',
      'బూటకపు కంపెనీలు','నకిలీ పత్రాలు','ఫోర్జరీ','ల్యాండ్ మాఫియా','భూ కబ్జా','నిర్బంధ చర్యలు',
      'హింసాకాండం','దౌర్జన్యం','బెదిరింపులు','దురుసుగా','అల్లరిమూకలు','ప్రజా ఆస్తుల ధ్వంసం',
    ],
    en: [
      // core
      'arrested','detained','charged','accused','fraud','scam','protest','strike','crisis',
      'resign','suspended','investigation','scandal','impeached','cancelled','banned',
      'crackdown','raided','FIR','lawsuit','verdict','convicted','acquitted','bail',
      'controversy','riot','shutdown','dismissed','terminated','jailed',
      // expanded
      'allegations','probe','hearing','tribunal','contempt','affidavit','petition','PIL',
      'notice','show cause','inquiry','enforcement','CBI','ED','income tax raid','seizure',
      'blacklisted','deregistered','revoked','expelled','disqualified','embezzlement',
      'misappropriation','siphoned','forged','counterfeit','corruption','bribery','extortion',
      'blackmail','coercion','illegal','unauthorized','encroachment','demolition','questioned',
      'summoned','custody','remand','chargesheet','supplementary chargesheet','obstruction',
      'witness tampering','money laundering','hawala','narcotics','drugs bust',
    ],
  },
  urgent: {
    pace: 1.10,
    te: [
      // core
      'బ్రేకింగ్','అత్యవసర','అలర్ట్','హెచ్చరిక','జాగ్రత్త','వెంటనే','తక్షణమే',
      'అప్రమత్తం','ముప్పు','రెడ్ అలర్ట్','ఎమర్జెన్సీ','ప్రమాద హెచ్చరిక',
      'తుఫాను హెచ్చరిక','వరద హెచ్చరిక',
      // expanded
      'సైన్యం','బలగాలు','మోహరింపు','కర్ఫ్యూ','నిషేధాజ్ఞలు','తక్షణ','హాట్ న్యూస్',
      'స్పీడ్ న్యూస్','ఇప్పుడే','సిద్ధంగా ఉండండి','ప్రమాద స్థాయి','సీరియస్',
      'అధిక వేగం','హై అలర్ట్','జాతీయ అత్యవసర స్థితి','సంక్షోభం','తక్షణ చర్య',
      'ప్రమాదకర స్థితి','సురక్షిత స్థానానికి','తరలింపు','ప్రాణాపాయ స్థితి',
    ],
    en: [
      // core
      'breaking','urgent','alert','immediate','emergency','red alert','critical',
      'evacuation','curfew','lockdown','blackout','flood warning','cyclone warning',
      'earthquake alert',
      // expanded
      'army deployed','security forces','high alert','nationwide alert','crisis situation',
      'flash flood','rapidly developing','developing story','just in','live updates',
      'exclusive breaking','unprecedented situation','massive operation','security breach',
      'terror threat','bomb threat','bomb squad','fire brigade','coast guard','NDRF',
      'SDRF','rescue operation','search and rescue','helpline activated','control room',
      'yellow alert','orange alert','IMD warning','NDMA','disaster management',
    ],
  },
  business: {
    pace: 1.08,
    te: [
      // core
      'మార్కెట్','సెన్సెక్స్','ఆర్థిక','బడ్జెట్','జీఎస్టీ','ద్రవ్యోల్బణం','వడ్డీ రేటు',
      'స్టాక్','పెట్టుబడి','ఆర్బీఐ','ట్రేడ్','ఎగుమతి','దిగుమతి','రూపాయి','డాలర్',
      'జీడీపీ','రెపో రేట్','లాభాలు','నష్టాలు','వృద్ధి రేటు','పన్ను','ఆదాయం',
      'కంపెనీ','ఐపీఓ','బాండ్','ఫండ్','ట్రేడింగ్','ఆర్థిక వ్యవస్థ',
      // expanded
      'నిఫ్టీ','బీఎస్‌ఈ','ఎన్‌ఎస్‌ఈ','కరెన్సీ','ఫోరెక్స్','రేటు','ధర','తగ్గింది',
      'పెరిగింది','ఉత్పత్తి','తయారీ','పరిశ్రమ','వ్యాపారం','లావాదేవీ','రాబడి','మదుపు',
      'మ్యూచువల్ ఫండ్','షేర్లు','డివిడెండ్','వ్యాపార','బ్యాంకు','ఆర్థిక ఫలితాలు',
      'క్వార్టర్లీ ఫలితాలు','ప్రభుత్వ వ్యయం','ద్రవ్య విధానం','విత్త లోటు',
      'వాణిజ్య లోటు','సుంకాలు','దిగుమతి సుంకం','ఎగుమతి ప్రోత్సాహం','ఉపాధి',
      'నిరుద్యోగం','జీతాలు','వేతనాలు','ఉత్పాదకత','వ్యాపార వాతావరణం','పరిశ్రమలు',
      'స్టార్టప్','ఆర్థిక సర్వేక్షణ','ఆర్థిక నివేదిక','లాభదాయకత','నికర లాభం',
      // task-expansion — economy, trade, corporate
      'ఎగుమతులు','దిగుమతులు','పెట్టుబడులు','విలీనం','స్వాధీనం','ఆర్థిక సంక్షోభం','రుణాలు',
      'వడ్డీ రేట్లు','యూనికార్న్','మార్కెట్ క్యాప్','టర్నోవర్','ఉద్యోగాలు','తయారీ రంగం',
      'వ్యవసాయ ఉత్పత్తి','ఎగుమతి ఆదాయం','విదేశీ పెట్టుబడులు','ఎఫ్‌డీఐ','నిధుల సమీకరణ',
      'మూలధనం','వాటాదారులు','షేర్ ధర','బోనస్ షేర్లు','ఐపీవో','క్రెడిట్ రేటింగ్','దివాలా',
      'ఎన్‌పీఏ','బ్యాంకింగ్ రంగం','వాణిజ్యం','సరఫరా గొలుసు','ద్రవ్య లభ్యత','కరెన్సీ మారకం',
      'బంగారం ధర','పసిడి ధర','పెట్రోల్ ధరలు','డీజిల్ ధరలు','నిత్యావసరాలు','ధరల పెరుగుదల',
      'జీఎస్టీ వసూళ్లు','ఆదాయపు పన్ను','కార్పొరేట్ ఫలితాలు','వార్షిక వృద్ధి','ఆర్థిక ప్యాకేజీ',
      'సబ్సిడీ','రాయితీలు','వాణిజ్య ఒప్పందం','పారిశ్రామిక వృద్ధి',
    ],
    en: [
      // core
      'market','sensex','nifty','economy','budget','GST','inflation','interest rate',
      'stock','investment','RBI','trade','export','import','rupee','dollar','GDP',
      'fiscal','revenue','profit','loss','growth rate','tax','earnings','IPO',
      'quarterly','annual report','corporate','merger','acquisition',
      // expanded
      'BSE','NSE','balance sheet','EBITDA','net profit','gross profit','market cap',
      'PE ratio','EPS','dividend','bonus shares','rights issue','FDI','FPI','forex',
      'monetary policy','credit rating','NPA','write-off','capital','EMI','loan',
      'mortgage','insurance','premium','claim','startup','unicorn','valuation',
      'funding round','venture capital','private equity','listed','delisted',
      'circuit breaker','bull run','bear market','rally','correction','volatility',
      'trade deficit','current account','fiscal deficit','divestment','PSU','subsidy',
      'excise','customs','tariff','anti-dumping','repo rate','reverse repo','CRR','SLR',
      'mutual fund','SIP','SEBI','IRDAI','TRAI','CCI','RoE','RoI',
    ],
  },
  sports: {
    pace: 1.20,
    te: [
      // core
      'క్రికెట్','విజయం','రికార్డు','ఛాంపియన్','హ్యాట్రిక్','గెలిచ','ఐతిహాసిక',
      'అద్భుత','స్వర్ణ పతకం','రజత పతకం','కాంస్య పతకం','ట్రోఫీ','టైటిల్','పతకం',
      'ఆల్-టైమ్','ఫుట్‌బాల్','బ్యాడ్మింటన్','టెన్నిస్','రన్స్','వికెట్','సెంచరీ',
      'ఫిఫ్టీ','ఐపీఎల్','వరల్డ్ కప్','ఒలింపిక్స్','సిక్సర్','బౌండరీ','ఆటగాడు',
      'మ్యాచ్','టోర్నమెంట్','కబడ్డీ','హాకీ',
      // expanded
      'క్రీడలు','క్రీడాకారుడు','క్రీడాకారిణి','ఆట','స్కోర్','పరుగులు','బంతులు',
      'వికెట్లు','ఓవర్లు','ఇన్నింగ్స్','నాటౌట్','ఆల్ రౌండర్','వికెట్ కీపర్',
      'స్పిన్నర్','పేస్ బౌలర్','ఓపెనర్','కెప్టెన్','కోచ్','జట్టు','సిరీస్',
      'ఫైనల్','సెమీఫైనల్','క్వార్టర్ ఫైనల్','నాకౌట్','ర్యాంకింగ్','ఫిఫా',
      'ఆసియా కప్','టి20','వన్డే','టెస్ట్','స్టేడియం','అభిమానులు','కుస్తీ',
      'షటిల్','గ్రాండ్ స్లామ్','మారథాన్','అథ్లెటిక్స్','స్విమ్మింగ్',
      'జిమ్నాస్టిక్స్','వెయిట్ లిఫ్టింగ్','జావెలిన్','రెజ్లింగ్','బాక్సింగ్',
      'గోల్','పెనాల్టీ','డ్రా','టై','సూపర్ ఓవర్','డక్‌వర్త్-లూయిస్',
      // task-expansion — cricket, football, kabaddi, athletics
      'బ్యాటింగ్','బౌలింగ్','ఫీల్డింగ్','హాఫ్‌సెంచరీ','ఓవర్','మైదానం','లీగ్','ప్లేఆఫ్',
      'అర్ధ శతకం','శతకం','చతుష్టయ','పంచ','ఆరు','రన్‌ రేట్','నెట్ రన్‌రేట్','బంగారు పతకం',
      'వెండి పతకం','డబుల్ సెంచరీ','ట్రిపుల్ సెంచరీ','మెయిడెన్ ఓవర్','పవర్‌ప్లే','క్లీన్ స్వీప్',
      'వైట్‌వాష్','వరుస విజయాలు','పరాజయం','ఓటమి','టాస్','బ్యాట్స్‌మన్','బౌలర్','ఫీల్డర్',
      'రిటైర్డ్ హర్ట్','ఇన్‌జూరీ','కమ్‌బ్యాక్','ప్రపంచ రికార్డు','జాతీయ రికార్డు','పోడియం',
      'రిలే','స్ప్రింట్','లాంగ్ జంప్','హై జంప్','షాట్‌పుట్','డిస్కస్ త్రో','ఆర్చరీ','షూటింగ్',
      'చెస్','క్యారమ్','వాలీబాల్','ఖోఖో','ప్రో కబడ్డీ','రైడర్','డిఫెండర్','ఛేజింగ్','తుది పోరు',
    ],
    en: [
      // core
      'cricket','won','wins','victory','champion','champions','hat-trick','record',
      'gold medal','silver medal','bronze medal','trophy','title','medal','football',
      'badminton','tennis','century','fifty','IPL','World Cup','Olympics','tournament',
      'semifinal','final','qualifier','innings','wicket','boundary','six','over',
      // expanded
      'runs','balls','wickets','batting','bowling','fielding','LBW','runout','stumped',
      'caught','no-ball','wide','maiden','powerplay','spin','swing','seam','DLS method',
      'super over','Test cricket','ODI','T20','T10','FIFA','UEFA','Champions League',
      'Premier League','La Liga','Serie A','Bundesliga','ATP','WTA','Grand Slam',
      'Wimbledon','French Open','US Open','Australian Open','Paralympics',
      'Commonwealth Games','Asian Games','wrestle','gymnastics','athletics','swimming',
      'boxing','wrestling','judo','taekwondo','shooting','archery','javelin','marathon',
      'sprint','relay','comeback','injury','ban','suspension','doping','hat trick',
      'penalty shootout','extra time','goal','assist','clean sheet','shutout','debut',
    ],
  },
  cinema: {
    pace: 1.14,
    te: [
      // core
      'సినిమా','చిత్రం','నటుడు','నటి','హీరో','హీరోయిన్','దర్శకుడు','రిలీజ్','అవార్డు',
      'ట్రెయిలర్','ఓటీటీ','టాలీవుడ్','బాలీవుడ్','మూవీ','షూటింగ్','బాక్స్ ఆఫీస్',
      'కలెక్షన్','ప్రీమియర్','ఫస్ట్ లుక్','సాంగ్','ఆల్బమ్','సంగీతం','నృత్యం',
      'సీరియల్','వెబ్ సిరీస్','కమెడియన్','నటన','ఫిల్మ్','స్క్రీన్','సినీ','స్టార్',
      // expanded
      'నటించారు','స్క్రీన్‌ప్లే','రచన','నిర్మాత','నిర్మాణం','ప్రివ్యూ','ప్రి-రిలీజ్',
      'ప్రమోషన్స్','ఆడియో లాంచ్','పోస్టర్','టీజర్','మోషన్ పోస్టర్','లిరికల్ వీడియో',
      'నేపథ్య గాయకుడు','నేపథ్య గాయని','పాట','నేపథ్య సంగీతం','మ్యూజిక్ డైరెక్టర్',
      'కొరియోగ్రాఫర్','ఆర్ట్ డైరెక్టర్','సినిమాటోగ్రాఫర్','ఎడిటర్','కాస్టింగ్',
      'డబ్బింగ్','కమర్షియల్','హిట్','సూపర్ హిట్','బ్లాక్ బస్టర్','ఫ్లాప్',
      'గ్రాండ్ సక్సెస్','హల్లీవుడ్','బయోపిక్','రీమేక్','సీక్వెల్','ప్రీక్వెల్',
      'ఓటీటీ రిలీజ్','థియేటర్','మల్టీప్లెక్స్','హౌస్‌ఫుల్','ఆడియన్స్',
      'నటసింహం','మెగాస్టార్','పవర్‌స్టార్','టాప్ హీరో','స్టాలిన్','పాన్ ఇండియా',
      // task-expansion — releases, music, genres, crew
      'సినిమా విడుదల','బాక్సాఫీస్','కలెక్షన్లు','వెబ్ సీరీస్','సంగీత దర్శకుడు','లిరిసిస్ట్',
      'కెమెరామన్','ట్రైలర్','రొమాంటిక్','యాక్షన్','థ్రిల్లర్','కామెడీ','డ్రామా','ఫ్యామిలీ డ్రామా',
      'హారర్','సస్పెన్స్','ఫస్ట్ డే కలెక్షన్','ఓపెనింగ్స్','వసూళ్లు','షూటింగ్ ప్రారంభం',
      'ముహూర్తం','పూజా కార్యక్రమం','క్లైమాక్స్','ఫైట్ సీన్','డ్యూయెట్','మాస్ సాంగ్','ఐటెం సాంగ్',
      'రీ రికార్డింగ్','డబ్బింగ్ పూర్తి','సెన్సార్','యూ సర్టిఫికేట్','విడుదల తేదీ','థియేటర్లలో',
      'ఓటీటీలో విడుదల','స్ట్రీమింగ్','రివ్యూ','రేటింగ్','ప్రేక్షకుల స్పందన','కథానాయకుడు',
      'కథానాయిక','విలన్','క్యారెక్టర్ ఆర్టిస్ట్','జూనియర్ ఆర్టిస్టులు','దర్శకనిర్మాత','సినీ పరిశ్రమ',
    ],
    en: [
      // core
      'movie','film','actor','actress','director','release','trailer','OTT','Tollywood',
      'Bollywood','Hollywood','box office','premiere','first look','album','celebrity',
      'entertainer','comedian','web series','streaming','music','dance','drama','sitcom',
      'sequel','franchise','blockbuster',
      // expanded
      'casting','production','post-production','VFX','CGI','cinematography','editing',
      'music composer','choreographer','playback singer','dubbing','subtitles',
      'advance booking','multiplex','PVR','INOX','houseful','flop','average','hit',
      'superhit','disaster','gross','nett','worldwide','dubbed','remake','biopic',
      'documentary','short film','lyrical','motion poster','teaser','lyric video',
      'item song','background score','award function','Filmfare','SIIMA','CineMAA',
      'National Award','BAFTA','Oscar nomination','SAG Awards','first day collection',
      'opening day','week collection','overseas','theatrical run','star cast',
    ],
  },
  celebration: {
    pace: 1.16,
    te: [
      // core
      'పండుగ','ఉత్సవం','వేడుక','వివాహం','శుభకారం','శుభవార్త','అభినందన','జయంతి',
      'వర్షాంతర','గర్వం','సంతోషం','ఆనందం','విజయోత్సవం','రజతోత్సవం','స్వర్ణోత్సవం',
      'జాతరలు','దసరా','దీపావళి','సంక్రాంతి','ఈద్','క్రిస్మస్',
      // expanded
      'స్వాతంత్ర్య దినోత్సవం','గణతంత్ర దినోత్సవం','బాపూ జయంతి','అంబేడ్కర్ జయంతి',
      'ఉగాది','రామనవమి','జన్మాష్టమి','వినాయక చవితి','నవరాత్రులు','మహాశివరాత్రి',
      'పోంగల్','ఓణం','హోళీ','బైసాఖీ','ఈద్ ఉల్ ఫిత్ర్','ఈద్ ఉల్ అధా','క్రిస్మస్ ఈవ్',
      'న్యూ ఇయర్','పుట్టిన రోజు','వార్షికోత్సవం','వజ్రోత్సవం','శతాబ్ది','ద్విశతాబ్ది',
      'ప్రారంభోత్సవం','లాంఛనప్రాయంగా','శంకుస్థాపన','ప్రతిష్ఠాపన','అభిషేకం',
      'తీర్థయాత్ర','రథయాత్ర','ప్రదర్శన','ఉత్సాహంగా','హర్షాతిరేకంతో',
      'అభివాదాలు','శుభాకాంక్షలు','మన్ననలు','పురస్కారం','సత్కారం','సన్మానం',
      // task-expansion — festivities, achievements, honours
      'విజయోత్సవాలు','సంబరాలు','సందడి','హర్షం','ఆనందోత్సాహాలు','ఘనంగా','వైభవంగా','కోలాహలం',
      'పండగ వాతావరణం','శుభ ముహూర్తం','ప్రారంభం','ప్రారంభించారు','ఆవిష్కరణ','ఆవిష్కరించారు',
      'జెండా ఆవిష్కరణ','పతకం సాధించారు','రికార్డు సృష్టించారు','ఘనత','కీర్తి','గౌరవం',
      'పురస్కారం అందుకున్నారు','అవార్డు గెలుచుకున్నారు','సన్మానించారు','ఘన స్వాగతం','స్వాగతం',
      'ఊరేగింపు','ర్యాలీ','బ్యాండ్ మేళాలు','బాణసంచా','టపాసులు','దీపాలంకరణ','ముగ్గులు',
      'పూలమాలలు','హారతులు','భక్తిశ్రద్ధలతో','వైభవోపేతంగా','అట్టహాసంగా','కన్నుల పండువగా',
      'గోల్డెన్ జూబ్లీ','డైమండ్ జూబ్లీ','శుభాభినందనలు','జయజయధ్వానాలు','వేడుకగా','ఉత్సవ శోభ',
    ],
    en: [
      // core
      'festival','celebration','wedding','award','congratulations','jubilee','anniversary',
      'felicitation','proud','joy','honored','triumph','launch','inauguration','diwali',
      'christmas','eid','ugadi',
      // expanded
      'independence day','republic day','gandhi jayanti','ambedkar jayanti','pongal','onam',
      'holi','navratri','dussehra','ganesh chaturthi','janmashtami','ramnavami',
      'shivaratri','eid al fitr','eid al adha','milad','guru nanak jayanti','new year',
      'birthday','centenary','bicentennial','diamond jubilee','platinum jubilee',
      'foundation stone','inauguration ceremony','inaugural function','felicitation ceremony',
      'tribute','honor','recognize','achievement','milestone','landmark','historic',
      'record-breaking','first time','historic occasion','memorable','pride','glory',
      'success','winning','felicitate','honor','cultural program','procession',
    ],
  },
};

// Returns { cat, score, pace } — exported so route handler can use score for override logic
function scoreText(text) {
  const scores = {};
  for (const [cat, { te, en }] of Object.entries(EMOTION_CATS)) {
    let score = 0;
    for (const kw of te) { if (text.includes(kw)) score += 2; }
    for (const kw of en) {
      if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, 'i').test(text)) score += 1;
    }
    scores[cat] = score;
  }

  let bestCat = 'neutral';
  let bestScore = 1;  // threshold: single strong Telugu keyword (score=2) wins over neutral
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; bestCat = cat; }
  }

  const rawPace = bestCat === 'neutral' ? 1.05 : EMOTION_CATS[bestCat].pace;
  return {
    cat:   bestCat,
    score: bestScore,
    pace:  Math.max(1.00, rawPace),   // hard floor — nothing slower than 1.00 (human anchor baseline)
  };
}

// detectPace: simple wrapper — classifies a single text block
function detectPace(text) {
  return scoreText(text).pace;
}

// chunkPaceWithContext: context-aware chunk classification.
// The FULL response text sets the base emotion (e.g. "political digest → 0.92").
// A chunk overrides only when its own score is ≥ OVERRIDE_THRESHOLD — meaning
// it has several strong independent signals, not just one stray keyword.
// This prevents a cinema article with one "death scene" mention from reading at grief pace.
const OVERRIDE_THRESHOLD = 5;  // lowered from 6 — a chunk with a moderately strong
                                // dominant emotion is now allowed to colour the pace.
                                // Below this, the base (full-response) pace is used verbatim.

// TWO-TIER blend. The old flat 80/20 was too conservative: breaking news and a
// cricket score read at the same speed as a routine political statement. Now the
// blend weight scales with how confident we are in the chunk's own emotion:
//
//   score < 5        → base pace only (no override; single stray keyword can't move it)
//   5 <= score < 8   → 70% base + 30% chunk  (moderate emotional variation)
//   score >= 8       → 50% base + 50% chunk  (high urgency/emotion punches through)
//
// A 50/50 cap (rather than letting the chunk win outright) keeps multi-article
// digests sounding like ONE anchor rather than a speaker swap mid-bulletin.
const HIGH_EMOTION_THRESHOLD = 8;
const BLEND_BASE_MODERATE    = 0.70;
const BLEND_BASE_HIGH        = 0.50;

function chunkPaceWithContext(chunk, baseResult) {
  const chunkResult = scoreText(chunk);
  // Override base if: chunk has a dominant emotion AND it differs from base
  if (chunkResult.score >= OVERRIDE_THRESHOLD && chunkResult.cat !== baseResult.cat) {
    const chunkPace = Math.max(1.00, chunkResult.pace);
    const baseWeight = chunkResult.score >= HIGH_EMOTION_THRESHOLD
      ? BLEND_BASE_HIGH
      : BLEND_BASE_MODERATE;
    return Math.max(1.00, baseWeight * baseResult.pace + (1 - baseWeight) * chunkPace);
  }
  // Otherwise inherit the base emotion (full response context is more reliable)
  return Math.max(1.00, baseResult.pace);
}

// ── WAV PCM concatenation ─────────────────────────────────────────────────────
// Sarvam returns raw WAV. For multi-chunk audio we strip individual headers,
// concatenate the raw PCM, and rebuild a single valid WAV header.

function parseWavPcm(buf) {
  if (buf.length < 44) throw new Error('WAV buffer too short');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not a RIFF file');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAVE file');

  let offset = 12;
  while (offset < buf.length - 8) {
    const chunkId   = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return {
        pcmData:       buf.slice(offset + 8, offset + 8 + chunkSize),
        sampleRate:    buf.readUInt32LE(24),
        numChannels:   buf.readUInt16LE(22),
        bitsPerSample: buf.readUInt16LE(34),
      };
    }
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;  // WAV chunk sizes are word-aligned
  }
  throw new Error('No data chunk in WAV response');
}

function buildWav(pcmData, sampleRate = 22050, numChannels = 1, bitsPerSample = 16) {
  const dataSize   = pcmData.length;
  const byteRate   = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const hdr        = Buffer.alloc(44);

  hdr.write('RIFF',  0, 'ascii');
  hdr.writeUInt32LE(36 + dataSize,  4);
  hdr.write('WAVE',  8, 'ascii');
  hdr.write('fmt ', 12, 'ascii');
  hdr.writeUInt32LE(16,            16);  // PCM fmt chunk = 16 bytes
  hdr.writeUInt16LE(1,             20);  // audio format: 1 = PCM
  hdr.writeUInt16LE(numChannels,   22);
  hdr.writeUInt32LE(sampleRate,    24);
  hdr.writeUInt32LE(byteRate,      28);
  hdr.writeUInt16LE(blockAlign,    32);
  hdr.writeUInt16LE(bitsPerSample, 34);
  hdr.write('data', 36, 'ascii');
  hdr.writeUInt32LE(dataSize,      40);

  return Buffer.concat([hdr, pcmData]);
}

// ── PCM fade-in / fade-out ────────────────────────────────────────────────────
// Applies a short linear ramp at the start and end of each WAV chunk's raw PCM.
//
// Why this matters:
//   When two WAV chunks are placed back-to-back (batch route: separated only by a
//   300ms silence gap; streaming route: back-to-back via AudioContext scheduling)
//   a non-zero sample value at the chunk boundary creates a step discontinuity
//   → an audible click or pop. Fading to/from zero at both ends eliminates this
//   without affecting perceptible speech quality (3ms and 5ms are inaudible as
//   silence but large enough to smooth any level transition).
//
//   Only handles 16-bit PCM (the format Sarvam returns). 8-bit or float PCM fall
//   back to returning the buffer unchanged.
function applyPcmFades(pcmBuf, sampleRate, bitsPerSample) {
  if (bitsPerSample !== 16) return pcmBuf;
  const out            = Buffer.from(pcmBuf);   // copy — never mutate the original
  const totalSamples   = Math.floor(out.length / 2);   // 2 bytes per 16-bit sample
  const fadeInSamples  = Math.min(Math.ceil(sampleRate * 0.003), totalSamples >> 2);  // 3 ms
  const fadeOutSamples = Math.min(Math.ceil(sampleRate * 0.005), totalSamples >> 2);  // 5 ms

  for (let i = 0; i < fadeInSamples; i++) {
    const offset = i * 2;
    const sample = out.readInt16LE(offset);
    out.writeInt16LE(Math.round(sample * (i / fadeInSamples)), offset);
  }
  for (let i = 0; i < fadeOutSamples; i++) {
    const offset = (totalSamples - fadeOutSamples + i) * 2;
    const sample = out.readInt16LE(offset);
    out.writeInt16LE(Math.round(sample * ((fadeOutSamples - 1 - i) / fadeOutSamples)), offset);
  }
  return out;
}

// ── TTS Preprocessing — Telugu context ───────────────────────────────────────
// Sarvam's enable_preprocessing doesn't handle English sports abbreviations
// embedded inside Telugu text. We expand them here before sending.
//
// Rules:
//  • Only applied when lang = 'te-IN' (Telugu TTS)
//  • Word-boundary anchors (\b) prevent partial matches (e.g. "INDIA" ≠ "IND")
//  • Order matters — longer patterns before shorter (T20 before T)
//
const TE_ABBREV = [
  // ── Telugu-script sport formats (must come FIRST — before English T20 rules)
  // "టీ20" appears in Telugu headlines where "టీ" is already transliterated but
  // "20" is still digits — Sarvam reads "20" as "రెండు సున్న" (digit-by-digit).
  [/టీ20/g,          'టీ-ట్వెంటీ'],
  [/టీ10/g,          'టీ-టెన్'],
  [/టీ100/g,         'టీ-హండ్రెడ్'],
  [/వన్డే/g,         'వన్‌డే'],   // ensure clean pronunciation of ODI transliteration
  // ── Scores / numbers attached to English letters ───────────────────────────
  // "T20" → "టీ-ట్వెంటీ"
  [/\bT20\b/g,       'టీ-ట్వెంటీ'],
  [/\bT10\b/g,       'టీ-టెన్'],
  [/\bT100\b/g,      'టీ-హండ్రెడ్'],
  [/\bODI\b/g,       'వన్‌డే'],
  [/\bODIs\b/g,      'వన్‌డేలు'],

  // ── Cricket team codes ────────────────────────────────────────────────────
  [/\bIND\b/g,       'ఇండియా'],
  [/\bSL\b/g,        'శ్రీలంక'],
  [/\bPAK\b/g,       'పాకిస్తాన్'],
  [/\bAUS\b/g,       'ఆస్ట్రేలియా'],
  [/\bENG\b/g,       'ఇంగ్లండ్'],
  [/\bNZ\b/g,        'న్యూజిలాండ్'],
  [/\bSA\b/g,        'దక్షిణాఫ్రికా'],
  [/\bWI\b/g,        'వెస్టిండీస్'],
  [/\bBAN\b/g,       'బంగ్లాదేశ్'],
  [/\bZIM\b/g,       'జింబాబ్వే'],
  [/\bAFG\b/g,       'ఆఫ్ఘనిస్తాన్'],
  [/\bIRE\b/g,       'ఐర్లాండ్'],
  [/\bSCO\b/g,       'స్కాట్లాండ్'],
  [/\bUSA\b/g,       'అమెరికా'],
  [/\bUAE\b/g,       'యూఏఈ'],
  [/\bNAM\b/g,       'నమీబియా'],

  // ── Cricket boards / tournaments ──────────────────────────────────────────
  [/\bIPL\b/g,       'ఐపీఎల్'],
  [/\bBPL\b/g,       'బీపీఎల్'],
  [/\bBBL\b/g,       'బీబీఎల్'],
  [/\bICC\b/g,       'ఐసీసీ'],
  [/\bBCCI\b/g,      'బీసీసీఐ'],
  [/\bWTC\b/g,       'డబ్ల్యూటీసీ'],
  [/\bCPL\b/g,       'సీపీఎల్'],
  [/\bPSL\b/g,       'పీఎస్ఎల్'],
  [/\bSA20\b/g,      'ఎస్ఏ-ట్వెంటీ'],

  // ── Football / FIFA ───────────────────────────────────────────────────────
  [/\bFIFA\b/g,      'ఫిఫా'],
  [/\bVAR\b/g,       'వీఏఆర్'],
  [/\bUEFA\b/g,      'యూఈఎఫ్ఏ'],

  // ── Common vs shorthand ───────────────────────────────────────────────────
  // "vs" in Telugu news → "వర్సెస్"
  [/\bvs\b/gi,       'వర్సెస్'],
  [/\bv\/s\b/gi,     'వర్సెస్'],

  // ── Government / news abbreviations ──────────────────────────────────────
  [/\bPM\b/g,        'ప్రధాని'],
  [/\bCM\b/g,        'ముఖ్యమంత్రి'],
  [/\bMLA\b/g,       'ఎమ్మెల్యే'],
  [/\bMP\b/g,        'ఎంపీ'],
  [/\bDGP\b/g,       'డీజీపీ'],
  [/\bSP\b/g,        'ఎస్పీ'],
  [/\bDSP\b/g,       'డీఎస్పీ'],
  [/\bSI\b/g,        'ఎస్ఐ'],
  [/\bFIR\b/g,       'ఎఫ్ఐఆర్'],
  [/\bCBI\b/g,       'సీబీఐ'],
  [/\bED\b/g,        'ఈడీ'],
  [/\bIT\b/g,        'ఇన్‌కమ్ ట్యాక్స్'],
  [/\bGST\b/g,       'జీఎస్టీ'],
  [/\bRBI\b/g,       'ఆర్బీఐ'],
  [/\bSC\b/g,        'సుప్రీం కోర్టు'],
  [/\bHC\b/g,        'హైకోర్టు'],
  [/\bIAS\b/g,       'ఐఏఎస్'],
  [/\bIPS\b/g,       'ఐపీఎస్'],
  [/\bIFS\b/g,       'ఐఎఫ్ఎస్'],

  // ── Political parties (common in Telugu news) ─────────────────────────────
  [/\bBJP\b/g,       'బీజేపీ'],
  [/\bTDP\b/g,       'టీడీపీ'],
  [/\bBRS\b/g,       'బీఆర్ఎస్'],
  [/\bTRS\b/g,       'టీఆర్ఎస్'],
  [/\bYSRCP\b/g,     'వైఎస్ఆర్‌సీపీ'],
  [/\bYCP\b/g,       'వైసీపీ'],
  [/\bINC\b/g,       'కాంగ్రెస్'],
  [/\bAAP\b/g,       'ఆమ్ ఆద్మీ పార్టీ'],

  // ── OTT / media ───────────────────────────────────────────────────────────
  [/\bOTT\b/g,       'ఓటీటీ'],
];

// ── Common English words → Telugu phonetics ──────────────────────────────────
// Applied ONLY for Telugu TTS. Forces Telugu-native pronunciation of English words
// that frequently appear in Telugu news copy, instead of an English-accented reading.
// Case-insensitive, word-boundary anchored so partial words are never touched.
const TE_ENGLISH_PHONETIC = [
  [/\bbreaking\b/gi,   'బ్రేకింగ్'],
  [/\blive\b/gi,       'లైవ్'],
  [/\bupdates\b/gi,    'అప్‌డేట్స్'],
  [/\bupdate\b/gi,     'అప్‌డేట్'],
  [/\bexclusive\b/gi,  'ఎక్స్‌క్లూజివ్'],
  [/\bspecial\b/gi,    'స్పెషల్'],
  [/\btrending\b/gi,   'ట్రెండింగ్'],
  [/\bviral\b/gi,      'వైరల్'],
];

// ── Telugu number words (0–100) ───────────────────────────────────────────
// Used by the general LETTERS+DIGIT handler below to convert movie/film codes
// like "RC17" → "ఆర్‌సీ పదిహేడు" and "NTR30" → "ఎన్‌టీ‌ఆర్ ముప్పై".
// For numbers > 100 we fall back to the original digit string (Sarvam handles
// three-digit standalone numbers reasonably well on its own).
const TE_UNITS = ['','ఒకటి','రెండు','మూడు','నాలుగు','అయిదు','ఆరు','ఏడు','ఎనిమిది','తొమ్మిది'];
const TE_TEENS = ['పది','పదకొండు','పన్నెండు','పదమూడు','పద్నాలుగు','పదిహేను','పదహారు','పదిహేడు','పదునెనిమిది','పంతొమ్మిది'];
const TE_TENS  = ['','','ఇరవై','ముప్పై','నలభై','యాభై','అరవై','డెభ్భై','ఎనభై','తొంభై'];

function numToTe(nStr) {
  const n = parseInt(nStr, 10);
  if (isNaN(n) || n < 0) return nStr;
  if (n === 0) return 'సున్నా';
  if (n <= 9)  return TE_UNITS[n];
  if (n <= 19) return TE_TEENS[n - 10];
  if (n < 100) {
    const tens  = Math.floor(n / 10);
    const units = n % 10;
    return units > 0 ? `${TE_TENS[tens]} ${TE_UNITS[units]}` : TE_TENS[tens];
  }
  // 100–999: వంద / రెండు వందలు / నూట అయిదు
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rem      = n % 100;
    if (rem === 0) return hundreds === 1 ? 'వంద' : `${TE_UNITS[hundreds]} వందలు`;
    const hWord    = hundreds === 1 ? 'నూట' : `${TE_UNITS[hundreds]} వందల`;
    return `${hWord} ${numToTe(String(rem))}`;
  }
  // 1000–99999: వెయ్యి / రెండు వేలు / ఒక వేయి ఐదు వందలు
  if (n < 100000) {
    const thousands = Math.floor(n / 1000);
    const rem       = n % 1000;
    if (rem === 0) return thousands === 1 ? 'వెయ్యి' : `${numToTe(String(thousands))} వేలు`;
    const tWord     = thousands === 1 ? 'వేయి' : `${numToTe(String(thousands))} వేల`;
    return `${tWord} ${numToTe(String(rem))}`;
  }
  // lakhs (1,00,000 – 99,99,999)
  if (n < 10000000) {
    const lakhs = Math.floor(n / 100000);
    const rem   = n % 100000;
    const lWord = lakhs === 1 ? 'లక్ష' : `${numToTe(String(lakhs))} లక్షలు`;
    return rem === 0 ? lWord : `${lWord} ${numToTe(String(rem))}`;
  }
  // crores (1,00,00,000+)
  if (n < 100000000000) {
    const crores = Math.floor(n / 10000000);
    const rem    = n % 10000000;
    const cWord  = crores === 1 ? 'కోటి' : `${numToTe(String(crores))} కోట్లు`;
    return rem === 0 ? cWord : `${cWord} ${numToTe(String(rem))}`;
  }
  return nStr; // too large — return original
}

// ── Telugu ordinal words ─────────────────────────────────────────────────────
// Maps N వ / N వ  → spoken Telugu ordinal word. "5వ స్థానం" → "అయిదవ స్థానం".
const TE_ORDINALS = ['', 'మొదటి', 'రెండవ', 'మూడవ', 'నాలుగవ', 'అయిదవ',
  'ఆరవ', 'ఏడవ', 'ఎనిమిదవ', 'తొమ్మిదవ', 'పదవ',
  'పదకొండవ', 'పన్నెండవ', 'పదమూడవ', 'పద్నాలుగవ', 'పదిహేనవ',
  'పదహారవ', 'పదిహేడవ', 'పదెనిమిదవ', 'పందొమ్మిదవ', 'ఇరవైవ'];

// ── Telugu number expansion for standalone digits in news text ────────────────
// Converts freestanding numbers in Telugu article text to Telugu words so Sarvam
// reads them naturally instead of spelling out each digit.
function expandTeluguNumbers(text) {
  return text
    // ── Ordinals Nవ / N వ → Telugu word (must run before other number passes) ──
    // "5వ స్థానం" → "అయిదవ స్థానం", "19వ పతకం" → "పంతొమ్మిదవ పతకం"
    .replace(/\b(\d{1,2})\s*వ\b/g, (m, num) => {
      const n = parseInt(num, 10);
      return (n >= 1 && n <= 20) ? TE_ORDINALS[n] : m;
    })
    // ── Decimal amounts before కోట్లు/లక్షలు (e.g. 1.5 కోట్లు → కోటిన్నర) ──
    .replace(/\b(\d+)\.5\s*(కోట్లు|కోటి)\b/g, (m, whole) => {
      const n = parseInt(whole, 10);
      if (n === 1) return 'కోటిన్నర';
      const w = numToTe(String(n));
      return `${w} కోట్లు అర కోటి`;
    })
    .replace(/\b(\d+)\.5\s*(లక్షలు|లక్ష)\b/g, (m, whole) => {
      const n = parseInt(whole, 10);
      if (n === 1) return 'లక్షన్నర';
      const w = numToTe(String(n));
      return `${w} లక్షలు ఏభై వేలు`;
    })
    // ── ₹ amounts (with optional comma formatting): ₹1,200 → పన్నెండు వందల రూపాయలు ──
    .replace(/₹\s*(\d[\d,]*)/g, (m, num) => {
      const n = parseInt(num.replace(/,/g, ''), 10);
      if (isNaN(n) || n > 99999999999) return m;
      return `${numToTe(String(n))} రూపాయలు`;
    })
    // ── $ amounts: $50 million → ఏభై మిలియన్ డాలర్లు ──
    .replace(/\$\s*(\d[\d,]*)\s*(million|billion|trillion)?/gi, (m, num, unit) => {
      const n = parseInt(num.replace(/,/g, ''), 10);
      if (isNaN(n)) return m;
      const unitMap = { million: 'మిలియన్', billion: 'బిలియన్', trillion: 'ట్రిలియన్' };
      const unitTe = unit ? ' ' + (unitMap[unit.toLowerCase()] || '') : '';
      return `${numToTe(String(n))}${unitTe} డాలర్లు`;
    })
    // ── Percentages: 43% → నలభై మూడు శాతం ──
    .replace(/\b(\d{1,3})%/g, (m, num) => {
      const n = parseInt(num, 10);
      return n <= 100 ? `${numToTe(String(n))} శాతం` : m;
    })
    // ── Years 1900–2099: 2024 → రెండు వేల ఇరవై నాలుగు ──
    .replace(/\b(19|20)(\d{2})\b/g, (m, cent, yr) => {
      const yearWord = cent === '19' ? 'పంతొమ్మిది వందల' : 'రెండు వేల';
      const yrNum    = parseInt(yr, 10);
      return yrNum === 0 ? yearWord : `${yearWord} ${numToTe(String(yrNum))}`;
    })
    // ── Comma-formatted large numbers: 1,500 → పదిహేను వందలు ──
    // Must run AFTER year pass (so 2024 is already converted).
    .replace(/(?<![A-Za-z₹$#/.:])(\d{1,3}(?:,\d{2,3})+)(?![A-Za-z%/])/g, (m, num) => {
      const n = parseInt(num.replace(/,/g, ''), 10);
      if (isNaN(n) || n > 99999999999) return m;
      return numToTe(String(n));
    })
    // ── Standalone 1–6 digit numbers not adjacent to letters/urls/# ──
    .replace(/(?<![A-Za-z#/.:])(\b\d{1,6}\b)(?![A-Za-z%/])/g, (m, num) => {
      const n = parseInt(num, 10);
      if (n === 0) return m;
      const word = numToTe(String(n));
      return word !== num ? word : m;  // only replace when conversion succeeded
    });
}

// ── English letter → Telugu name map ─────────────────────────────────────
// Used to convert abbreviation letters (R, C, N, T…) to their Telugu spoken
// equivalents before passing to Sarvam. E.g. "R" → "ఆర్", "C" → "సీ".
const LETTER_TE = {
  A:'ఏ',  B:'బీ',  C:'సీ',  D:'డీ',   E:'ఈ',  F:'ఎఫ్', G:'జీ',  H:'హెచ్',
  I:'ఐ',  J:'జే', K:'కే',  L:'ఎల్',  M:'ఎమ్', N:'ఎన్', O:'ఓ',   P:'పీ',
  Q:'క్యూ', R:'ఆర్', S:'ఎస్', T:'టీ', U:'యూ', V:'వీ',  W:'డబ్ల్యూ',
  X:'ఎక్స్', Y:'వై', Z:'జెడ్',
};

// Join individual letter-names with ZWNJ (U+200C) for natural Telugu liaison.
// "RC" → "ఆర్‌సీ", "NTR" → "ఎన్‌టీ‌ఆర్"
function lettersToTe(str) {
  return [...str].map(ch => LETTER_TE[ch] || ch).join('‌');
}

// ── Leading-punctuation stripper ─────────────────────────────────────────────
// Sarvam Bulbul VOCALISES punctuation that is not attached to a word — a chunk
// that begins with "." / ".." / "…" / "—" is spoken as "dot", "dot dot",
// "dot dot dot". This is what users heard before every Telugu response: the
// widget converts the article separator " — " into ". ", and a line that started
// with a dash therefore reached Sarvam starting with a bare period.
//
// Applied twice: once on the whole utterance (preprocessForTTS) and once per
// chunk (callSarvam), because chunking can slice a chunk open on a stray mark.
function stripLeadingPunctuation(s) {
  return String(s || '')
    .replace(/^[\s.,;:!?।॥…·•*_=~\-–—]+/, '')
    .trimStart();
}

/**
 * Expand English abbreviations to Telugu words before Sarvam TTS.
 * Only runs for Telugu (te-IN) — English TTS handles abbreviations natively.
 *
 * Two-pass approach:
 *   Pass 1 — TE_ABBREV list: handles known codes (T20, ODI, IPL, IND, CM…)
 *   Pass 2 — General LETTERS+DIGIT handler: catches anything else that is
 *             1–5 uppercase ASCII letters immediately followed by 1–3 digits,
 *             e.g. "RC17" → "ఆర్‌సీ పదిహేడు", "NTR30" → "ఎన్‌టీ‌ఆర్ ముప్పై".
 *             Running AFTER pass 1 means T20/SA20 are already converted to
 *             Telugu script and won't re-match the general pattern.
 */
function preprocessForTTS(text, targetLang) {
  // Pass 0 (all languages): strip stray markdown formatting that slipped past the
  // client-side cleaner. If a raw "**bold**" / "*em*" / `code` / _under_ reaches
  // Sarvam it reads the asterisks/backticks aloud ("star star …").
  //
  // Also strip characters that Sarvam reads verbatim in ways that sound wrong:
  //   |  pipe  — appears in markdown tables, read as "vertical bar" or "pipe"
  //   []       — leftover reference brackets from news snippets
  //   #        — section heading markers
  //   Leading / trailing em-dash (—) at utterance edges — causes unnatural pause
  let out = text
    // ── VERY FIRST OPERATION: strip ALL invisible / zero-width characters ──────
    // Sakshi's CMS embeds ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D), LRM/RLM
    // (U+200E/U+200F), soft hyphen (U+00AD), BOM/ZWNBSP (U+FEFF) and the
    // line/paragraph separators (U+2028/U+2029) inside Telugu copy. None of them
    // are pronounceable; Sarvam's normaliser stumbles on them and emits noise —
    // typically a spurious leading "dot dot dot". Must run BEFORE every other
    // rule so that later regexes see clean text.
    .replace(/[\u200B-\u200F\u00AD\uFEFF\u2028\u2029]/g, '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')                       // **bold** → bold
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1$2') // _italic_ → italic
    .replace(/[*`#|]/g, '')                                 // stray *, `, #, | chars
    .replace(/\[([^\]]*)\]/g, '$1')                         // [text] → text (strip brackets)
    .replace(/^\s*[—–]\s*/gm, '')                           // leading em/en dash at line start
    .replace(/\s*[—–]\s*$/gm, '')                           // trailing em/en dash at line end
    // (zero-width / invisible characters are already stripped by the FIRST rule above)
    // Strip danda (।) and double-danda (॥) — Sarvam Bulbul v3 reads these aloud as
    // an audible "dot" sound rather than treating them as a silent sentence pause.
    // We use ASCII period (.) for all sentence-end markers (see ensureTrailingPunctuation).
    .replace(/[।॥]/g, '.')
    // Horizontal ellipsis (… U+2026) — a SINGLE character, so the `\.{2,}` rule below
    // never matched it. Sarvam expands it to three spoken dots ("dot dot dot"), which is
    // the leading noise heard before Telugu responses. Normalise to a comma pause.
    .replace(/[…⋯᠁]/g, ',')
    // Two or more consecutive dots (..) → comma so prosody stays natural without long gaps.
    .replace(/\.{2,}/g, ',')
    // Horizontal-rule / separator lines ("---", "———", "___", "===") — these are markdown
    // artefacts, never speech. Must run BEFORE any dash→period conversion, otherwise each
    // dash becomes its own ". " and the line is spoken as "dot dot dot".
    .replace(/^[ \t]*[-—–_=~]{2,}[ \t]*$/gm, '')
    // Collapse runs of ISOLATED punctuation (". . .", ", ,", ". ,") into one pause.
    // These come from earlier dash→period substitutions in the widget and are read
    // aloud verbatim by Sarvam. The pattern only matches punctuation that is itself
    // followed by whitespace and then more punctuation — normal prose is untouched.
    .replace(/(?:[.,;:]\s+){2,}[.,;:]?\s*/g, '. ')
    // Strip parenthetical photo/video annotations that appear in Sakshi headlines.
    .replace(/\(\s*(?:చిత్రాలు|ఫోటోలు|ఫొటోలు|వీడియో|video|photos?|gallery)\s*\)/gi, '')
    // Remove curly single quotes — may cause micro-pauses in Sarvam prosody model.
    .replace(/['']/g, '')
    .replace(/[ \t]{2,}/g, ' ')                             // collapse multiple spaces
    .replace(/\n{3,}/g, '\n\n');                            // cap consecutive newlines

  // Never let the utterance OPEN with punctuation. A leading "." / "," / "—" is read
  // aloud by Sarvam ("dot", "comma") before any real word — the exact symptom users
  // reported at the start of every Telugu response.
  out = stripLeadingPunctuation(out);

  if (targetLang !== 'te-IN') return stripLeadingPunctuation(out);

  // Pass 0b: numeric scores / ranges "N-N" → "N–N" (en-dash).
  // With enable_preprocessing:true Sarvam treats an ASCII hyphen between digits as a
  // separator token and vocalises it in English phonetics ("two dash two" / "dot two").
  // The en-dash (U+2013) is read as a prose separator — a pause, not a word.
  // Restricted to digit-hyphen-digit so compound words ("BJP-led") are untouched.
  out = out.replace(/(\d+)-(\d+)/g, '$1–$2');

  // Pass 1: known abbreviations
  for (const [pattern, replacement] of TE_ABBREV) {
    out = out.replace(pattern, replacement);
  }

  // Pass 1b: common English words embedded in Telugu → Telugu phonetics.
  // Forces Telugu-native pronunciation instead of an English-accented reading.
  for (const [pattern, replacement] of TE_ENGLISH_PHONETIC) {
    out = out.replace(pattern, replacement);
  }

  // Pass 2: general LETTERS+DIGIT codes not handled above
  // Word boundary (\b) on both sides ensures we match whole tokens only.
  // Telugu chars are non-\w, so "RC17లో" → matches "RC17", appends "లో" intact.
  out = out.replace(/\b([A-Z]{1,5})(\d{1,3})\b/g, (_, letters, digits) => {
    return lettersToTe(letters) + ' ' + numToTe(digits);
  });

  // Pass 3: expand standalone numbers to Telugu words so Sarvam reads
  // "200 కోట్లు" as "రెండు వందలు కోట్లు" not "రెండు సున్నా సున్నా కోట్లు".
  out = expandTeluguNumbers(out);

  // FINAL step — after ALL other preprocessing. Any of the passes above can leave a
  // bare punctuation mark at the head of the utterance (e.g. a stripped separator or
  // an abbreviation expansion that consumed the first word). Sarvam speaks such a mark
  // aloud as "dot"/"dot dot dot", which is the stray noise heard before Telugu audio.
  return stripLeadingPunctuation(out);
}

// ── Trailing-punctuation normalizer ──────────────────────────────────────────
// Sarvam's prosody model uses sentence-final punctuation to apply falling
// intonation and a natural pause. A chunk that ends mid-sentence (no period,
// no ।) gets rising intonation as if the utterance is unfinished — this sounds
// awkward. We append the correct sentence-ender when one is absent.
//
// We detect Telugu by looking for any Telugu Unicode character (U+0C00–U+0C7F).
// We skip chunks that already end with punctuation or that end with a numeral/
// letter-abbreviation (to avoid "RC17।" which sounds odd).
function ensureTrailingPunctuation(chunk) {
  // Strip any opening punctuation first — a chunk that begins with "." or "—" is
  // read aloud as "dot"/"dash" by Sarvam before the first real word.
  const trimmed = stripLeadingPunctuation(chunk).trim();
  if (!trimmed || trimmed.length < 10) return trimmed;
  // Already ends with sentence-final punctuation → nothing to do
  if (/[।॥!?\.…]$/.test(trimmed)) return trimmed;
  // Ends with some other punctuation (comma, colon, dash) → leave as-is
  if (/[,;:—–\-"')»]$/.test(trimmed)) return trimmed;
  // Ends with a digit or uppercase letter (abbreviation tail like "RC17") → leave
  if (/[\dA-Z]$/.test(trimmed)) return trimmed;
  // Use ASCII period for both Telugu and English — Sarvam Bulbul v3 reads the
  // danda (।) aloud as an audible "dot" sound instead of a silent sentence pause.
  // The ASCII period is universally interpreted as silence / falling intonation.
  return trimmed + '.';
}

// ── Telugu sentence boundary ──────────────────────────────────────────────────
// Better than the old `(?<=[.।!?।॥])\s+`: handles the full stop set (। ॥ ! ? .),
// runs of up to 3 terminators (Telugu "…" / "..." / "?!"), and only splits when the
// NEXT token starts a new sentence — a Telugu letter/matra, an ASCII capital, a digit,
// or an opening quote/bracket. This avoids splitting on decimals ("3.5"), abbreviations
// and mid-sentence dots while still catching real sentence ends.
const TE_SENTENCE_END = /(?<=[।॥!?\.]{1,3})\s+(?=[అ-ఽఀ-౿A-Z0-9"'«(])/;

// ── Fast-start micro-chunk ────────────────────────────────────────────────────
// The single biggest latency win: synthesise a very SHORT first chunk (1 sentence,
// ≤120 chars) so the user hears audio in ~350ms instead of ~1.5s. The remaining text
// is packed into normal MAX_CHUNK_CHARS chunks and streamed behind it.
function extractFirstSentence(text) {
  // Telugu sentence endings: । (U+0964), ॥ (U+0965), ! ? . …
  const match = text.match(/^([\s\S]{20,120}?[।॥!?\.…])\s*/);
  if (match) return [match[1].trim(), text.slice(match[0].length).trim()];
  // No sentence boundary in first 120 chars — cut at the last word break.
  const cut = text.lastIndexOf(' ', 120);
  if (cut > 30) return [text.slice(0, cut).trim(), text.slice(cut).trim()];
  return [text.slice(0, 120).trim(), text.slice(120).trim()];
}

// ── Text chunking ─────────────────────────────────────────────────────────────
// Split on double-newlines (headline separators from stripMarkdownForTTS),
// then single newlines, then sentence boundaries. Each chunk ≤ MAX_CHUNK_CHARS.
function chunkText(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  const chunks  = [];
  let   current = '';

  const flush = (piece) => {
    if (!piece || !piece.trim()) return;
    if ((current + '\n' + piece).length > MAX_CHUNK_CHARS) {
      if (current.trim()) chunks.push(current.trim());
      current = piece;
    } else {
      current = current ? current + '\n' + piece : piece;
    }
  };

  const paragraphs = text.split(/\n\n+/);
  for (const para of paragraphs) {
    if (para.length <= MAX_CHUNK_CHARS) {
      flush(para);
    } else {
      // Paragraph too long — split on single newlines first
      for (const line of para.split(/\n/)) {
        if (line.length <= MAX_CHUNK_CHARS) {
          flush(line);
        } else {
          // Line too long — split on sentence boundaries (improved Telugu detection)
          for (const s of line.split(TE_SENTENCE_END)) flush(s);
        }
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
}

// ── Coalescing buffer for streamed text → Sarvam ─────────────────────────────
// Problem it solves: short adjacent fragments were each sent to Sarvam as their own
// synthesis request. Sarvam has no cross-request context, so a phrase split across
// two chunks ("ఖేలో" | "ఇండియా") is spoken as two unrelated words with a boundary
// pause instead of one name. It also costs one paid API call per fragment.
//
// Rules — purely CONTENT-based. There is NO time-based hold anywhere in this path:
// no setTimeout, no artificial wait. Latency to first audio is therefore unchanged
// from having no coalescer at all.
//   • FLUSH immediately when the accumulated buffer ends with . ? ! ।
//   • FLUSH immediately when the accumulated buffer exceeds MAX_COALESCE_CHARS (200)
//   • FLUSH on end-of-stream
//   • Otherwise (fragment shorter than MIN_COALESCE_CHARS and NOT sentence-final) the
//     fragment is merged structurally into the next piece — grouped, never delayed.
// Net effect: fewer Sarvam calls on streamed responses (direct credit saving) AND
// better prosody, because mid-sentence splits reach Sarvam as one request.
const MIN_COALESCE_CHARS   = 60;
const MAX_COALESCE_CHARS   = 200;
const SENTENCE_END_RE      = /[.?!।]\s*$/;

function shouldFlushNow(buf) {
  return SENTENCE_END_RE.test(buf) || buf.length > MAX_COALESCE_CHARS;
}

function appendFragment(buf, piece) {
  if (!buf) return piece;
  return /\s$/.test(buf) || /^\s/.test(piece) ? buf + piece : buf + ' ' + piece;
}

/**
 * Synchronous coalescer — the ONLY coalescer. Used by the streaming routes, where the
 * complete text is already known and split into chunks up-front, so there is nothing
 * to wait FOR. Merging is purely structural: a short, non-sentence-final fragment is
 * joined to the piece that follows it inside this loop. Zero timers, zero added
 * latency — the first sentence is emitted on the very first iteration and dispatched
 * to Sarvam immediately.
 * @param {string[]} pieces
 * @returns {string[]} coalesced chunks
 */
function coalesceChunks(pieces) {
  const out = [];
  let buf = '';
  for (const piece of pieces) {
    if (!piece || !piece.trim()) continue;
    buf = appendFragment(buf, piece.trim());
    // Sentence-final or over the cap → emit now, however short. A mid-sentence
    // fragment below MIN_COALESCE_CHARS simply stays in `buf` and absorbs the next
    // piece, which is what re-joins phrases chunkText() split ("ఖేలో" + "ఇండియా").
    if (shouldFlushNow(buf) || buf.length >= MIN_COALESCE_CHARS) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());   // end-of-stream flush
  return out;
}

// ── Sarvam API call ───────────────────────────────────────────────────────────
/**
 * @param {string}  text       — text chunk ≤ 2400 chars
 * @param {string}  targetLang — "te-IN" | "en-IN"
 * @param {string}  speaker    — Sarvam speaker name
 * @param {number}  pace       — 0.5–2.0
 * @returns {Promise<Buffer>}  — raw WAV Buffer
 */
/**
 * Single attempt at the Sarvam TTS API.
 * Uses keepAlive:false so each parallel chunk request gets its own TLS session.
 * Without this, Node's default agent reuses one TLS session across all concurrent
 * requests — when chunks are fired in parallel one session close corrupts the
 * others, producing "SSL alert 20 bad_record_mac".
 */
function callSarvamOnce(text, targetLang, speaker, pace, apiKey) {
  // ── Last line of defence against leading punctuation ────────────────────────
  // Chunking (chunkText / extractFirstSentence / the coalescing buffer) can slice a
  // chunk open on a stray mark, so a chunk may start with "." / ".." / "—" even when
  // the full utterance did not. Sarvam vocalises those as "dot"/"dot dot"/"dash"
  // before the first real word. Every chunk is stripped here, immediately before the
  // request body is built, so no caller can bypass it.
  text = stripLeadingPunctuation(text);

  // ── enable_preprocessing ────────────────────────────────────────────────────
  // ON for ALL languages (including te-IN).
  //
  // History: this was disabled for Telugu because the danda (।) was being spoken
  // aloud as "dot". That root cause is fixed upstream — preprocessForTTS() now
  // strips ।/॥ and replaces them with an ASCII period before ANY text reaches
  // Sarvam, so the normaliser never sees the character that caused the artefact.
  //
  // Re-enabling restores Sarvam's own prosody normalisation, which we cannot
  // replicate locally: natural pauses at . , ? !, number normalisation, and
  // correct falling intonation at sentence boundaries.
  //
  // Our preprocessForTTS() Telugu passes (TE_ABBREV, TE_ENGLISH_PHONETIC,
  // LETTERS+DIGIT codes, expandTeluguNumbers) still run first and are strictly
  // more thorough for Telugu-specific cases; Sarvam's normaliser only sees
  // already-expanded text and adds prosody on top.
  const enablePreprocessing = true;

  const bodyStr = JSON.stringify({
    inputs:               [text],
    target_language_code: targetLang,
    speaker,
    model:                'bulbul:v3',
    pace,
    speech_sample_rate:   22050,
    enable_preprocessing: enablePreprocessing,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: SARVAM_TTS_HOST,
        path:     SARVAM_TTS_PATH,
        method:   'POST',
        agent:    sarvamAgent,  // shared keepAlive:false agent — no socket reuse, no per-call alloc
        headers: {
          'Content-Type':         'application/json',
          'Content-Length':        Buffer.byteLength(bodyStr),
          'api-subscription-key':  apiKey,
        },
      },
      (res) => {
        const parts = [];
        res.on('data', c => parts.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(parts).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`Sarvam ${res.statusCode}: ${raw.slice(0, 300)}`));
          }
          try {
            const json = JSON.parse(raw);
            if (!json.audios || !json.audios[0]) {
              return reject(new Error('Sarvam response missing audios field'));
            }
            resolve(Buffer.from(json.audios[0], 'base64'));
          } catch {
            reject(new Error('Sarvam returned non-JSON response'));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error('Sarvam API timeout after 30s')));
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Sarvam TTS with one automatic retry on transient SSL / network errors.
 * Retryable: SSL errors (bad_record_mac), ECONNRESET, ETIMEDOUT, ECONNREFUSED.
 * Non-retryable: HTTP 4xx/5xx API errors (quota, auth, bad request).
 */
async function callSarvam(text, targetLang, speaker, pace) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey || apiKey === 'PASTE_YOUR_SARVAM_KEY_HERE') {
    throw new Error('SARVAM_API_KEY not configured — edit backend/.env');
  }

  // Ensure the chunk ends at a natural sentence boundary so Sarvam applies
  // correct falling intonation and pause instead of mid-sentence rising pitch.
  text = ensureTrailingPunctuation(text);

  // ── Audio chunk cache ───────────────────────────────────────────────────────
  // Keyed on the FINAL text (post-punctuation-normalisation) + speaker + pace, so
  // the key matches exactly what would have been sent to Sarvam. A hit returns the
  // stored WAV Buffer and makes ZERO paid API calls.
  const cacheKey = audioCacheKey(text, speaker, pace);
  const cached   = audioCacheGet(cacheKey);
  if (cached) return cached;

  const isRetryable = (err) => {
    const msg  = err.message || '';
    const code = err.code || '';
    // SSL bad_record_mac / handshake failures + common network resets.
    // BUG FIX: "socket hang up" (very common on abrupt TLS close), EPROTO and
    // EAI_AGAIN (transient DNS) were previously NOT matched, so a retryable
    // transient failure was thrown as if it were a permanent API error.
    if (/ssl|tls|bad record mac|ssl alert|socket hang up/i.test(msg)) return true;
    if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EPROTO|EAI_AGAIN/i.test(msg + ' ' + code)) return true;
    return false;
  };

  let wav;
  try {
    wav = await callSarvamOnce(text, targetLang, speaker, pace, apiKey);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    // One retry after a short back-off — fresh TLS session guaranteed by keepAlive:false
    console.warn(`[NewsAI TTS] Transient error ("${err.message.slice(0,60)}") — retrying once`);
    await new Promise(r => setTimeout(r, 300));
    wav = await callSarvamOnce(text, targetLang, speaker, pace, apiKey);
  }

  // Cache only successful, non-empty audio (callSarvamOnce rejects on non-200 and
  // on a missing `audios` field, so reaching here means status 200 with a body).
  audioCacheSet(cacheKey, wav);
  return wav;
}

// ── Pipelined (lookahead) synthesis ───────────────────────────────────────────
/**
 * Sliding-window generator: always keeps the NEXT chunk synthesising in the
 * background while the caller consumes the current one. This overlaps chunk N+1's
 * Sarvam round-trip with chunk N's transfer/consumption, cutting total streaming
 * time by ~25–35% versus the old strictly-sequential loop.
 *
 * Each element resolves to { index, wavBuf, error } and NEVER throws — a failed
 * chunk yields { error } so the stream can emit a per-chunk error event and keep
 * going (client always receives a terminal 'done').
 *
 * NOTE: this pipelines across DIFFERENT chunks only — a single chunk is still one
 * callSarvam request. It does not fire duplicate requests for the same chunk.
 *
 * @param {string[]} chunks
 * @param {string}   targetLang
 * @param {string}   speaker
 * @param {number[]} paces
 * @param {() => boolean} [shouldAbort]  — stop scheduling new work when true
 */
async function* synthesizeWithLookahead(chunks, targetLang, speaker, paces, shouldAbort) {
  if (chunks.length === 0) return;

  const aborted = () => (typeof shouldAbort === 'function' && shouldAbort());
  const fire = (i) =>
    callSarvam(chunks[i], targetLang, speaker, paces[i])
      .then(wavBuf => ({ wavBuf, error: null }), error => ({ wavBuf: null, error }));

  // 2-chunk lookahead window: keep up to 3 Sarvam requests in flight simultaneously.
  //
  // Why 2 instead of 1:
  //   The micro first-sentence chunk (≤120 chars) synthesises fast (~0.7s) and plays
  //   for only ~0.8–1s. With 1-ahead, chunks 0+1 fire together — good. But chunk 2
  //   only fires AFTER chunk 0 yields (~0.7s in). If chunk 1 ends early (short para),
  //   chunk 2 might not be ready. With 2-ahead, chunks 0+1+2 all start at T=0; chunk 2
  //   is always in the buffer before chunk 1 finishes playing.
  //
  // Safety: the abort check ensures we stop paying Sarvam the moment the client drops.
  const LOOKAHEAD = 2;
  const promises  = [];           // indexed by chunk number
  const preFire   = Math.min(LOOKAHEAD + 1, chunks.length);

  // Pre-warm the first min(3, N) chunks in parallel.
  for (let p = 0; p < preFire; p++) promises.push(fire(p));
  let nextToFire = preFire;

  for (let i = 0; i < chunks.length; i++) {
    if (aborted()) return;

    // Slide the window: fire one more chunk to keep LOOKAHEAD chunks ahead.
    if (nextToFire < chunks.length && !aborted()) promises.push(fire(nextToFire++));

    const { wavBuf, error } = await promises[i];
    yield { index: i, wavBuf, error };
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────
async function tts(req, res) {
  const { text, lang = 'te', voice: customSpeaker } = req.body;

  // typeof checks: non-string text/voice would make .trim()/.toLowerCase() throw
  // inside this async handler — Express 4 turns that into an unhandled rejection
  // that crashes the process.
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  // Validate speaker
  let speaker = SPEAKER_MAP[lang] || SPEAKER_MAP.te;
  if (customSpeaker) {
    if (typeof customSpeaker !== 'string') {
      return res.status(400).json({ error: 'voice must be a string' });
    }
    const s = customSpeaker.toLowerCase();
    if (!ALLOWED_SPEAKERS.has(s)) {
      return res.status(400).json({
        error: `Invalid speaker. Allowed: ${[...ALLOWED_SPEAKERS].join(', ')}`,
      });
    }
    speaker = s;
  }

  const targetLang = LANG_CODE_MAP[lang] || 'te-IN';
  // Expand abbreviations before chunking so Sarvam hears "ఇండియా" not "I N D"
  const trimmed    = preprocessForTTS(text.trim().slice(0, 10_000), targetLang);
  const chunks     = chunkText(trimmed);

  // Context-aware emotion:
  //   1. Score the FULL response → base emotion (e.g. "political digest → neutral 0.92")
  //   2. Each chunk scores independently; overrides base only if score ≥ OVERRIDE_THRESHOLD
  //      (prevents a cinema article with one "death scene" mention from reading at grief pace)
  const baseResult  = scoreText(trimmed);
  let   chunkPaces  = chunks.map(chunk => chunkPaceWithContext(chunk, baseResult));

  // English needs a higher pace floor than Telugu for natural cadence.
  // Boost English to a minimum of 1.15 — matches how English news anchors speak.
  if (targetLang === 'en-IN') {
    chunkPaces = chunkPaces.map(p => Math.max(p, 1.15));
  }

  console.log(`[NewsAI TTS] Sarvam bulbul:v3 | lang=${lang} speaker=${speaker} chunks=${chunks.length} chars=${trimmed.length} base=${baseResult.cat}(${baseResult.pace}) paces=[${chunkPaces.join(',')}]`);

  try {
    // All chunks synthesised in parallel for minimum total latency.
    // Each chunk uses its own pace derived from its content.
    const wavBuffers = await Promise.all(
      chunks.map((chunk, i) => callSarvam(chunk, targetLang, speaker, chunkPaces[i]))
    );

    let finalWav;
    if (wavBuffers.length === 1) {
      // Single chunk — return as-is (no re-encoding overhead)
      finalWav = wavBuffers[0];
    } else {
      // Multi-chunk — strip individual WAV headers, concat PCM with silence gaps, rebuild header
      const parsed   = wavBuffers.map(parseWavPcm);
      const { sampleRate, numChannels, bitsPerSample } = parsed[0];

      // 0.3-second silence between each headline chunk (PCM zeros = digital silence)
      // Size = sampleRate × channels × (bits/8) × seconds
      const silenceSamples = Math.round(sampleRate * numChannels * (bitsPerSample / 8) * 0.3);
      const silenceBuf     = Buffer.alloc(silenceSamples, 0);

      const pcmParts = [];
      parsed.forEach((p, i) => {
        // Apply PCM fades to each chunk: eliminates click/pop artifacts at boundaries.
        const fadedPcm = applyPcmFades(p.pcmData, sampleRate, bitsPerSample);
        pcmParts.push(fadedPcm);
        if (i < parsed.length - 1) pcmParts.push(silenceBuf);  // 0.3s gap between headlines
      });

      finalWav = buildWav(Buffer.concat(pcmParts), sampleRate, numChannels, bitsPerSample);
    }

    res.set({
      'Content-Type':   'audio/wav',
      'Content-Length':  String(finalWav.length),
      'Cache-Control':  'no-cache',
      'X-Speaker':       speaker,
      'X-Paces':         chunkPaces.join(','),
      'X-Chunks':        String(chunks.length),
    });
    res.send(finalWav);

  } catch (err) {
    console.error('[NewsAI TTS] Error:', err.message);

    const isConfig = err.message.includes('not configured');
    const isQuota  = err.message.includes('429') || err.message.toLowerCase().includes('quota');
    const status   = isConfig ? 503 : isQuota ? 429 : 500;

    res.status(status).json({
      error: isConfig
        ? 'TTS not configured — paste your Sarvam API key into backend/.env (SARVAM_API_KEY=)'
        : `TTS failed: ${err.message}`,
    });
  }
}

// ── Streaming TTS handler ─────────────────────────────────────────────────────
/**
 * POST /api/tts/stream
 * Same body as /api/tts — { text, lang, voice? }
 * Returns: text/event-stream (SSE)
 *
 * Events:
 *   { type:'meta',  total:N, speaker, lang }          — sent first
 *   { type:'chunk', chunk:i, total:N, audio:<b64WAV>, pace, last:bool }
 *   { type:'error', chunk:i, message }                — on per-chunk failure
 *   { type:'done' }                                   — stream complete
 *
 * Why sequential synthesis instead of Promise.all?
 *   The latency win comes from the client starting playback after chunk 0 arrives
 *   (~1–2s) while the server is still synthesising chunks 1, 2…  With parallel
 *   synthesis the client had to wait for ALL chunks (same ~2s) PLUS the full
 *   response transfer.  Sequential streaming gives the same per-chunk latency
 *   but the client perception is chunk[0]-latency, not total-latency.
 */
async function ttsStream(req, res) {
  const { text, lang = 'te', voice: customSpeaker } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  let speaker = SPEAKER_MAP[lang] || SPEAKER_MAP.te;
  if (customSpeaker) {
    if (typeof customSpeaker !== 'string') {
      return res.status(400).json({ error: 'voice must be a string' });
    }
    const s = customSpeaker.toLowerCase();
    if (!ALLOWED_SPEAKERS.has(s)) {
      return res.status(400).json({
        error: `Invalid speaker. Allowed: ${[...ALLOWED_SPEAKERS].join(', ')}`,
      });
    }
    speaker = s;
  }

  const targetLang = LANG_CODE_MAP[lang] || 'te-IN';
  const trimmed    = preprocessForTTS(text.trim().slice(0, 10_000), targetLang);

  // SSE response headers — reused by both the live path and the cache-replay path.
  const sseHeaders = {
    'Content-Type':               'text/event-stream',
    'Cache-Control':              'no-cache',
    'Connection':                 'keep-alive',
    'X-Accel-Buffering':          'no',    // disable Nginx proxy buffering
    'Access-Control-Allow-Origin': '*',
  };

  // ── TTS cache lookup ──────────────────────────────────────────────────────
  // Key on the cleaned text + language + speaker (voice changes the audio, so it
  // must be part of the key). On a hit we replay the stored SSE payload verbatim
  // in ≤8 KB writes — no Sarvam call, instant playback.
  const cacheKey = ttsCacheKey(targetLang + ':' + speaker, trimmed);
  const cacheHit = TTS_CACHE_ENABLED ? _ttsCacheGet(cacheKey) : null;
  if (cacheHit) {
    res.writeHead(200, sseHeaders);
    res.flushHeaders();
    if (res.socket) { try { res.socket.setNoDelay(true); } catch (_) {} }
    const buf = cacheHit.sse;
    for (let off = 0; off < buf.length; off += 8192) {
      try { res.write(buf.slice(off, off + 8192)); } catch (_) { break; }
    }
    try { res.end(); } catch (_) {}
    console.log(`[NewsAI TTS Stream] ✅ Cache HIT (${buf.length} bytes) lang=${lang} speaker=${speaker}`);
    return;
  }

  // ⚡ Fast-start chunking: the first sentence becomes a tiny micro-chunk (≤120 chars)
  // that synthesises in ~350ms, so the user hears audio in well under a second. The
  // rest is packed into normal MAX_CHUNK_CHARS chunks and streamed behind it.
  const [firstSent, rest] = extractFirstSentence(trimmed);
  // Coalesce before synthesis: merges any sub-60-char mid-sentence fragment into its
  // neighbour so split phrases ("ఖేలో" + "ఇండియా") reach Sarvam as one request. This
  // is a synchronous, structural merge — no hold window — so the fast-start first
  // sentence is dispatched to Sarvam with zero added delay.
  const chunks     = coalesceChunks([firstSent, ...chunkText(rest)]);

  const baseResult = scoreText(trimmed);
  let   chunkPaces = chunks.map(chunk => chunkPaceWithContext(chunk, baseResult));
  if (targetLang === 'en-IN') chunkPaces = chunkPaces.map(p => Math.max(p, 1.15));

  // SSE headers — disable all proxy/Nginx buffering so events reach the client immediately
  res.writeHead(200, sseHeaders);
  // Flush headers to the wire immediately so the browser establishes the SSE connection
  // before the first (potentially slow) Sarvam API call. Without this, Node may buffer
  // the initial 200 response until the first res.write() — which arrives seconds later.
  res.flushHeaders();

  // Disable Nagle's algorithm on the SSE socket — each res.write() must hit the wire
  // immediately rather than being batched. Critical for low time-to-first-audio.
  if (res.socket) { try { res.socket.setNoDelay(true); } catch (_) {} }

  // BUG FIX: client-disconnect detection.
  // `res.writableEnded` is ONLY true after WE call res.end() — it stays false when the
  // client aborts the fetch mid-stream. The old loop therefore kept firing PAID Sarvam
  // calls for chunks 1..N even though the browser had already gone away. We now listen
  // for the socket 'close' event and stop synthesising the moment the client disconnects.
  let clientGone = false;
  res.on('close', () => { if (!res.writableEnded) clientGone = true; });

  // Cache accumulation: record every SSE event we successfully write so a fully
  // successful stream can be replayed later. `errored` disables caching if any
  // chunk failed (we never want to cache a partial/error payload).
  const _sseLog = [];
  let   errored = false;

  // Guarded write — never throws (writing to a dead socket would otherwise reject and
  // surface as an unhandled promise rejection in this async handler).
  const safeWrite = (obj) => {
    if (clientGone || res.writableEnded) return false;
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    try { res.write(line); _sseLog.push(line); return true; }
    catch (_) { clientGone = true; return false; }
  };

  // Metadata event lets the client know how many chunks to expect
  safeWrite({ type: 'meta', total: chunks.length, speaker, lang: targetLang });

  console.log(`[NewsAI TTS Stream] bulbul:v3 | lang=${lang} speaker=${speaker} chunks=${chunks.length} chars=${trimmed.length} base=${baseResult.cat}(${baseResult.pace})`);

  try {
    // Pipelined synthesis: chunk N+1 is already in flight while chunk N streams out.
    const abort = () => clientGone || res.writableEnded;
    for await (const { index, wavBuf, error } of
               synthesizeWithLookahead(chunks, targetLang, speaker, chunkPaces, abort)) {
      if (clientGone || res.writableEnded) break; // client disconnected — stop paid synthesis

      if (error) {
        errored = true;   // never cache a payload that contains a failed chunk
        console.error(`[NewsAI TTS Stream] Chunk ${index} error: ${error.message}`);
        // 'done' is still sent after the loop even when a (or every) chunk errors,
        // so the client always gets a terminal event and can release its button.
        safeWrite({ type: 'error', chunk: index, message: error.message });
        continue;
      }

      safeWrite({
        type:  'chunk',
        chunk: index,
        total: chunks.length,
        audio: wavBuf.toString('base64'),
        pace:  chunkPaces[index],
        last:  index === chunks.length - 1,
      });
    }

    if (!clientGone && !res.writableEnded) {
      safeWrite({ type: 'done' });
      res.end();
      // Store the complete, successful SSE payload for future replays.
      if (!errored && _sseLog.length > 0 && TTS_CACHE_ENABLED) {
        _ttsCacheSet(cacheKey, Buffer.from(_sseLog.join(''), 'utf8'));
        console.log(`[NewsAI TTS Stream] 🗄️  Cached ${_sseLog.length} events lang=${lang} speaker=${speaker}`);
      }
    }
  } catch (err) {
    // Defensive: any unexpected throw must not become an unhandled rejection (Express 4
    // does not catch async errors, and res.status().json() after writeHead would throw
    // "headers already sent"). Just log and close the stream.
    console.error('[NewsAI TTS Stream] Fatal stream error:', err.message);
    if (!res.writableEnded) { try { res.end(); } catch (_) {} }
  }
}

// ── Binary PCM stream handler ─────────────────────────────────────────────────
/**
 * POST /api/tts/stream-binary
 * Body: { text: string, lang: "te" | "en", voice?: string }
 * Returns: application/octet-stream — raw 16-bit PCM bytes, no WAV headers.
 *
 * Response headers carry the format metadata the client needs:
 *   X-TTS-Sample-Rate  — always 22050
 *   X-TTS-Channels     — always 1  (mono)
 *   X-TTS-Bits         — always 16 (signed little-endian)
 *   X-TTS-Chunks       — number of Sarvam synthesis chunks
 *   X-TTS-Speaker      — voice name used
 *
 * Why this exists (vs /api/tts/stream SSE):
 *   The SSE path sends each chunk as a base64-encoded WAV inside a JSON event.
 *   The client must: parse SSE → JSON.parse → atob → ArrayBuffer → decodeAudioData
 *   → AudioBufferSource → schedule on AudioContext timeline.  Each step adds latency
 *   and the discrete scheduling produces audible micro-pauses when a chunk's audio
 *   finishes before the next AudioBuffer is decoded and scheduled.
 *
 *   The binary path eliminates all that overhead:
 *     • No base64 (saves ~33 % bytes on the wire)
 *     • No JSON parsing
 *     • No WAV decode — raw Int16 PCM → Float32 division
 *     • Client pushes samples directly into an AudioWorklet ring buffer
 *     • AudioWorklet runs at block rate (128 samples / ~5.8 ms) without scheduling gaps
 *
 *   Result: truly gapless, continuous audio even when chunks arrive at different speeds.
 */
async function ttsBinaryStream(req, res) {
  const { text, lang = 'te', voice: customSpeaker } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  let speaker = SPEAKER_MAP[lang] || SPEAKER_MAP.te;
  if (customSpeaker) {
    if (typeof customSpeaker !== 'string') {
      return res.status(400).json({ error: 'voice must be a string' });
    }
    const s = customSpeaker.toLowerCase();
    if (!ALLOWED_SPEAKERS.has(s)) {
      return res.status(400).json({
        error: `Invalid speaker. Allowed: ${[...ALLOWED_SPEAKERS].join(', ')}`,
      });
    }
    speaker = s;
  }

  const targetLang = LANG_CODE_MAP[lang] || 'te-IN';
  const trimmed    = preprocessForTTS(text.trim().slice(0, 10_000), targetLang);

  // Same fast-start chunking as the SSE route.
  const [firstSent, rest] = extractFirstSentence(trimmed);
  // Same coalescing pass as the SSE route — see coalesceChunks().
  const chunks     = coalesceChunks([firstSent, ...chunkText(rest)]);

  const baseResult  = scoreText(trimmed);
  let   chunkPaces  = chunks.map(chunk => chunkPaceWithContext(chunk, baseResult));
  if (targetLang === 'en-IN') chunkPaces = chunkPaces.map(p => Math.max(p, 1.15));

  // ── Headers ──────────────────────────────────────────────────────────────────
  // Sarvam always returns 22050 Hz mono 16-bit PCM. Expose format to client so it
  // can create an AudioContext at the right sample rate without any WAV parsing.
  res.set({
    'Content-Type':                  'application/octet-stream',
    'X-TTS-Sample-Rate':             '22050',
    'X-TTS-Channels':                '1',
    'X-TTS-Bits':                    '16',
    'X-TTS-Chunks':                  String(chunks.length),
    'X-TTS-Speaker':                 speaker,
    'Cache-Control':                 'no-cache',
    'Connection':                    'keep-alive',
    'X-Accel-Buffering':             'no',           // disable Nginx proxy buffering
    'Access-Control-Allow-Origin':   '*',
    // Without Expose-Headers the JS fetch() on a cross-origin widget can't read custom headers.
    'Access-Control-Expose-Headers': 'X-TTS-Sample-Rate,X-TTS-Channels,X-TTS-Bits,X-TTS-Chunks,X-TTS-Speaker',
  });
  res.flushHeaders();
  if (res.socket) { try { res.socket.setNoDelay(true); } catch (_) {} }

  let clientGone = false;
  res.on('close', () => { if (!res.writableEnded) clientGone = true; });

  const abort = () => clientGone || res.writableEnded;

  console.log(`[NewsAI TTS Binary] lang=${lang} speaker=${speaker} chunks=${chunks.length} chars=${trimmed.length} base=${baseResult.cat}(${baseResult.pace})`);

  try {
    for await (const { index, wavBuf, error } of
               synthesizeWithLookahead(chunks, targetLang, speaker, chunkPaces, abort)) {
      if (clientGone || res.writableEnded) break;
      if (error) {
        console.error(`[NewsAI TTS Binary] Chunk ${index} error: ${error.message}`);
        continue;  // skip failed chunk — client worklet outputs silence briefly
      }

      try {
        const { pcmData } = parseWavPcm(wavBuf);
        // Do NOT apply applyPcmFades here. PCM fades (3 ms in + 5 ms out) exist to
        // prevent clicks when discrete AudioBufferSources are scheduled back-to-back
        // on the AudioContext timeline (the SSE path). In the binary path the
        // AudioWorklet ring buffer concatenates chunks invisibly — adding fade ramps
        // at every boundary creates an 8 ms dip every ~480 chars instead of removing one.
        if (!clientGone) res.write(pcmData);
      } catch (e) {
        console.warn(`[NewsAI TTS Binary] WAV parse error chunk ${index}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[NewsAI TTS Binary] Fatal error:', err.message);
  }

  if (!res.writableEnded) { try { res.end(); } catch (_) {} }
}

// Export helpers for tts-prefetch.js
module.exports = { tts, ttsStream, ttsBinaryStream, callSarvam, detectPace, preprocessForTTS, SPEAKER_MAP, LANG_CODE_MAP, coalesceChunks };
