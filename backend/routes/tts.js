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

const https = require('https');

const SARVAM_TTS_HOST = 'api.sarvam.ai';
const SARVAM_TTS_PATH = '/text-to-speech';
const MAX_CHUNK_CHARS = 480;    // Sarvam actual limit: 500 chars/input — leave 20 char margin

// ── Speaker map ───────────────────────────────────────────────────────────────
// Sarvam Bulbul v3 confirmed speaker list:
// Female: ritu, priya, neha, pooja, simran, kavya, ishita, shreya, roopa, tanya, shruti, suhani
// Male:   aditya, ashutosh, rahul, rohan, amit, dev, ratan, varun, manan, sumit, kabir,
//         aayan, shubh, advait, anand, tarun, sunny, mani, gokul, vijay, mohit, rehan, soham
// NOTE: anushka/vidya/abhilash/karun are NOT in bulbul:v3 (they belong to a different model tier)
const SPEAKER_MAP = {
  'te':        'kavya',    // Telugu female — warm, clear (good Telugu name)
  'te-female': 'kavya',
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
// Pace values — MINIMUM FLOOR IS 0.90 (nothing slower than 0.90):
//   0.90 = grief / disaster / obituary  (solemn — floor)
//   0.92 = neutral / politics           (standard news pace)
//   0.94 = breaking / urgent / alert    (tense, deliberate)
//   0.95 = controversy / arrest / legal (measured, serious)
//   0.96 = business / economy           (clear, authoritative)
//   1.00 = cinema / culture / festival  (warm, engaging)
//   1.05 = celebration / inauguration   (uplifting)
//   1.08 = sports / victory             (energetic, upbeat)

const EMOTION_CATS = {
  grief: {
    pace: 0.90,   // minimum floor — nothing slower than 0.90
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
    pace: 0.95,
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
    pace: 0.94,
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
    pace: 0.96,
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
    pace: 1.08,
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
    pace: 1.00,
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
    pace: 1.05,
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

  const rawPace = bestCat === 'neutral' ? 0.92 : EMOTION_CATS[bestCat].pace;
  return {
    cat:   bestCat,
    score: bestScore,
    pace:  Math.max(0.90, rawPace),   // hard floor — nothing slower than 0.90
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
const OVERRIDE_THRESHOLD = 4;  // tune: lower = chunks override base more easily

function chunkPaceWithContext(chunk, baseResult) {
  const chunkResult = scoreText(chunk);
  // Override base if: chunk has a genuinely dominant emotion AND it differs from base
  if (chunkResult.score >= OVERRIDE_THRESHOLD && chunkResult.cat !== baseResult.cat) {
    return Math.max(0.90, chunkResult.pace);   // floor applies to chunk overrides too
  }
  // Otherwise inherit the base emotion (full response context is more reliable)
  return Math.max(0.90, baseResult.pace);
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

  // ── OTT / media ───────────────────────────────────────────────────────────
  [/\bOTT\b/g,       'ఓటీటీ'],
];

/**
 * Expand English abbreviations to Telugu words before Sarvam TTS.
 * Only runs for Telugu (te-IN) — English TTS handles abbreviations natively.
 */
function preprocessForTTS(text, targetLang) {
  if (targetLang !== 'te-IN') return text;
  let out = text;
  for (const [pattern, replacement] of TE_ABBREV) {
    out = out.replace(pattern, replacement);
  }
  return out;
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
          // Line too long — split on sentence boundaries
          for (const s of line.split(/(?<=[.।!?।॥])\s+/)) flush(s);
        }
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 0);
}

// ── Sarvam API call ───────────────────────────────────────────────────────────
/**
 * @param {string}  text       — text chunk ≤ 2400 chars
 * @param {string}  targetLang — "te-IN" | "en-IN"
 * @param {string}  speaker    — Sarvam speaker name
 * @param {number}  pace       — 0.5–2.0
 * @returns {Promise<Buffer>}  — raw WAV Buffer
 */
async function callSarvam(text, targetLang, speaker, pace) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey || apiKey === 'PASTE_YOUR_SARVAM_KEY_HERE') {
    throw new Error('SARVAM_API_KEY not configured — edit backend/.env');
  }

  const bodyStr = JSON.stringify({
    inputs:               [text],
    target_language_code: targetLang,
    speaker,
    model:                'bulbul:v3',
    pace,
    speech_sample_rate:   22050,
    enable_preprocessing: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: SARVAM_TTS_HOST,
        path:     SARVAM_TTS_PATH,
        method:   'POST',
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

  // English sounds robotic at Telugu-tuned pace (0.88–0.96).
  // Boost English to a minimum of 1.08 — natural news-reader cadence.
  if (targetLang === 'en-IN') {
    chunkPaces = chunkPaces.map(p => Math.max(p, 1.08));
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

      // 2-second silence between each headline chunk (PCM zeros = digital silence)
      // Size = sampleRate × channels × (bits/8) × seconds
      const silenceSamples = sampleRate * numChannels * (bitsPerSample / 8) * 2;
      const silenceBuf     = Buffer.alloc(silenceSamples, 0);

      const pcmParts = [];
      parsed.forEach((p, i) => {
        pcmParts.push(p.pcmData);
        if (i < parsed.length - 1) pcmParts.push(silenceBuf);  // 2s gap between headlines
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

// Export helpers for tts-prefetch.js
module.exports = { tts, callSarvam, detectPace, SPEAKER_MAP, LANG_CODE_MAP };
