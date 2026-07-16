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
  // Accepts an optional `doc` (e.g. from DOMParser for a fetched remote page)
  // and `baseUrl` for resolving relative hrefs in that remote document.
  function extractPageArticles(doc, baseUrl) {
    doc     = doc     || document;
    baseUrl = baseUrl || window.location.origin;
    const isRemote = (doc !== document);  // true when scraping a fetched HTML string
    const articles = [];
    const seen = new Set();

    // Selectors — broad heading selectors run FIRST to capture all sections
    // (Sports, Cinema, etc.) before URL-pattern selectors break the loop.
    // On sakshi.com, Sports is at /sports/ and Cinema at /entertainment/ —
    // NOT under /news/ — so URL selectors alone miss them entirely.
    const SELECTORS = [
      // ── PRIMARY: heading-based — catches every article link in DOM order ──
      // This is domain-agnostic and works on any site. Sports/Cinema appear
      // later in the page but are still within the first 80 h2/h3 elements.
      'h2 a', 'h3 a', 'h4 a',
      // ── STRUCTURED containers (deduplicated via `seen`) ──
      'article h2 a', 'article h3 a',
      '[class*="card"] a[href]', '[class*="item"] a[href]',
      // ── URL path patterns — picks up sports/entertainment-specific links ──
      'a[href*="/sports/"]', 'a[href*="/entertainment/"]',
      'a[href*="/cinema/"]', 'a[href*="/cricket/"]',
      'a[href*="/news/"]', 'a[href*="/story/"]', 'a[href*="/article/"]',
      // ── Site-specific class names ──
      '.story-title a', '.storydesc a', '.storycard a',
      '[class*="story"] a', '[class*="headline"] a',
      '[class*="news-head"] a', '[class*="newshead"] a',
      '[class*="heading"] a', '[class*="title"] a',
      '.card-title a', '.entry-title a',
      'h1 a',
    ];

    // Section map — ordered specific → general. First match wins.
    // KEY ORDERING RULES:
    //   • Location-specific (AP, TS, National) before thematic (Politics, Business, Irrigation)
    //   • Women before Crime (dowry/domestic violence is Women, not Crime)
    //   • Education before Public Admin (scholarship scheme → Education)
    //   • Agriculture before Public Admin (farmer welfare → Agriculture)
    //   • "review" removed from Cinema — too generic, fires on "review meet"
    //   • "welfare scheme" removed from Public Admin — fires on Agriculture/Education headlines
    const SECTION_MAP = [
      // Courts
      { re: /supreme court|high court|sessions court|district court|judge|verdict|judgment|bail denied|acquitted|convicted|petition|contempt|\bHC\b|\bSC\b|remand|chargesheet|prosecution|acquittal|sentence|appeal|stay order/i, s: 'Courts' },
      // Local Bodies (specific body names — before generic Political/Admin)
      { re: /\bghmc\b|\bgvmc\b|municipality|municipal corporation|panchayat|\bward\b|\bmayor\b|councillor|sarpanch|gram panchayat/i, s: 'Local Bodies' },
      // Railways
      { re: /railway|train|\bmetro\b|rail|irctc|vande.bharat|express.train|locomotive|station|passenger|ticket|derail/i, s: 'Railways' },
      // Aviation
      { re: /airport|aviation|airline|flight|aircraft|airbus|boeing|indigo|spicejet|air india|air traffic|pilot/i, s: 'Aviation' },
      // Women (before Crime — domestic violence + dowry are Women-section stories)
      { re: /women|woman|girl|female|mahila|ladies|gender|self.help.group|\bSHG\b|domestic violence|dowry|maternity/i, s: 'Women' },
      // Crime & Police
      { re: /murder|killed|robbery|theft|rape|fraud|scam|arrested|police|jail|custody|bail|warrant|chargesheet|suspect|investigation|kidnap|abduction|assault|firing|gang|dacoity|loot|fake|trap|attack|stabbing|explosion/i, s: 'Crime & Police' },
      // Public Health
      { re: /health|hospital|doctor|disease|medicine|vaccine|surgery|cancer|dengue|malaria|covid|aarogya|virus|fever|tb|diabetes|bp|cardiac|nurse|treatment|outbreak/i, s: 'Public Health' },
      // Lifestyle (removed "travel" — too generic; official CM visits are not Lifestyle)
      { re: /lifestyle|fashion|beauty|food recipe|yoga|fitness|wellness|skincare|haircare|diet|weight loss|health tips/i, s: 'Lifestyle' },
      // Technology (before Crime — cyber fraud/hacking → Technology, not Crime & Police)
      { re: /technology|software|\bai\b|artificial intelligence|internet|mobile|app|cyber|digital|startup|isro|nasa|satellite|drone|robot|automation|smartphone|hack|fintech|it sector/i, s: 'Technology' },
      // Education (before Public Admin — "scholarship scheme" → Education)
      { re: /education|school|college|university|exam|student|admission|scholarship|eamcet|jee|neet|inter|btech|mba|phd|teacher|principal|hostel|results|rank/i, s: 'Education' },
      // Agriculture (before Public Admin — "farmer welfare" → Agriculture, not Public Admin)
      { re: /farmer|agriculture|crop|paddy|harvest|drought|ryot|urea|fertilizer|pesticide|kisan|fasal bima|sowing|yield|rytu|agricultural/i, s: 'Agriculture' },
      // Sports
      { re: /cricket|football|\bipl\b|sport|match|tournament|wicket|innings|\brun\b|player|team|league|trophy|fifa|olympic|badminton|boxing|kabaddi|hockey|tennis|volleyball|swimmer|athlete|stadium|coach|captain|batting|bowling|fielding|boundary|six|century/i, s: 'Sports' },
      // Cinema ("review" removed — too generic; fires on "government review meet")
      { re: /cinema|film|movie|tollywood|bollywood|\bott\b|serial|television|album|actor|actress|director|release|trailer|teaser|box.office|collection|netflix|amazon prime|hotstar|shooting|producer/i, s: 'Cinema' },
      // ── Location-specific sections BEFORE Irrigation/Roads ────────────────────
      // "Vijayawada floods" must → Andhra Pradesh, not Irrigation.
      // City/person names are more specific than generic flood/dam keywords.
      // Andhra Pradesh
      { re: /andhra|amaravati|vijayawada|jagan|chandrababu|guntur|vizag|visakhapatnam|nellore|kadapa|kurnool|tirupati|anantapur|eluru|rajahmundry|kakinada|ongole|lokesh|pawan kalyan|polavaram/i, s: 'Andhra Pradesh' },
      // Telangana
      { re: /telangana|hyderabad|secunderabad|revanth|\bktr\b|\bbrs\b|warangal|nizamabad|karimnagar|khammam|medak|nalgonda|mahabubnagar|rangareddy|kcr|owaisi|harish rao/i, s: 'Telangana' },
      // Irrigation (after AP/TS — "Vijayawada floods" caught by AP above)
      { re: /irrigation|reservoir|dam|canal|water level|flood|godavari|krishna river|srisailam|nagarjuna sagar|tungabhadra/i, s: 'Irrigation' },
      // Roads & Buildings
      { re: /road|highway|flyover|overbridge|underpass|bridge|expressway|pothole|traffic jam|toll/i, s: 'Roads & Buildings' },
      // National (before Politics and Business — "Modi budget speech" → National)
      { re: /lok sabha|rajya sabha|central government|modi|amit shah|rahul gandhi|president of india|vice president|prime minister|union budget/i, s: 'National' },
      // International
      { re: /international|world|global|america|russia|china|\busa\b|\buk\b|europe|pakistan|israel|ukraine|gaza|nato|un summit|diplomat|ambassador|foreign|war|conflict|nuclear/i, s: 'International' },
      // Business
      { re: /business|market|economy|sensex|nifty|stock|finance|budget|tax|\brbi\b|\bgdp\b|inflation|trade|import|export|ipo|investment|profit|loss|gst|income tax|company|corporate/i, s: 'Business' },
      // Politics
      { re: /politics|political|election|vote|candidate|minister|parliament|assembly|party|manifesto|\btdp\b|\bysrcp\b|\bbjp\b|congress|\bbrs\b|janasena|\baap\b|\bmim\b|rally|padayatra|bypolls/i, s: 'Politics' },
      // National (fallback for "national|india|parliament|delhi" not caught above)
      { re: /national|india|parliament|delhi/i, s: 'National' },
      // Public Administration (removed "welfare scheme" — too generic)
      { re: /collector|district administration|\bias\b|\bips\b|government order|circular|beneficiaries|secretariat|revenue department|district office/i, s: 'Public Administration' },
    ];

    // Telugu keyword overlays — run after English to catch Telugu-only headlines.
    // KEY ORDERING RULES (same as SECTION_MAP):
    //   • Women before Crime (వరకట్న → Women, not Crime)
    //   • Agriculture before Technology AND Sports ("యాప్‌లో..రైతన్న" → Agriculture)
    //   • Technology before Crime ("సైబర్ మోసం" → Technology, not Crime)
    //   • Education before Public Admin ("స్కాలర్‌షిప్ పథకం" → Education)
    //   • Sports before International (cricket team names like శ్రీలంక, వెస్టిండీస్)
    //   • AP/TS/National before Politics/Business/International
    //   • "పర్యటన" removed from Lifestyle (fires for official CM visits)
    //   • "ప్రాజెక్ట్" removed from Irrigation (too generic → wrong for political projects)
    //   • "నిర్మాణం" removed standalone from Roads (fires for canal construction)
    //   • "సభ" removed from Politics (substring of "రాజ్యసభ" — causes false positive)
    //   • "వరి" replaced with "వరి పంట|వరి సాగు" ("వరి" substring-matches "ఎవరిపై")
    //   • Telugu morphology: use stems like "లబ్ధిదారు", "సంక్షేమ", "ఉద్యోగ" to catch
    //     inflected forms (ఉద్యోగి/ఉద్యోగుల, సంక్షేమం/సంక్షేమ, లబ్ధిదారులు/లబ్ధిదారులకు)
    const TELUGU_MAP = [
      // Courts
      { re: /సుప్రీంకోర్టు|హైకోర్టు|జిల్లా కోర్టు|న్యాయమూర్తి|తీర్పు|న్యాయస్థానం|కోర్టు విచారణ|బెయిల్ నిరాకరణ|రిమాండ్|పిటిషన్|స్టే ఆర్డర్|అప్పీల్|జైలు శిక్ష|నిర్దోషి|దోషి|లాయర్|అడ్వొకేట్|హైకోర్టు ఆదేశం|న్యాయ విచారణ/, s: 'Courts' },
      // Local Bodies (specific body names before generic political terms)
      { re: /కార్పొరేషన్|నగరపాలక|పురపాలక|పంచాయతీ|వార్డు|మేయర్|మున్సిపల్|జీహెచ్ఎంసీ|జీవీఎంసీ|నగరపాలక సంస్థ|పట్టణ పాలన|కౌన్సిలర్|డివిజన్|సర్పంచ్|గ్రామపంచాయతీ|జడ్పీ|మండల|జిల్లా పరిషత్/, s: 'Local Bodies' },
      // Railways
      { re: /రైల్వే|రైలు|మెట్రో|వందే భారత్|రైల్వే స్టేషన్|ట్రెయిన్|ఐఆర్సీటీసీ|రైలు ప్రమాదం|రైలు ఆలస్యం|ప్రయాణికులు|రైలు సేవలు|పాసింజర్|రైలు టిక్కెట్|మెట్రో రైలు|రైలు పట్టాలు|లోకల్ రైలు|ఎక్స్‌ప్రెస్ రైలు/, s: 'Railways' },
      // Aviation
      { re: /విమానం|విమానాశ్రయం|ఏవియేషన్|విమాన సేవలు|ఫ్లైట్|పైలట్|విమాన ప్రమాదం|ఎయిర్‌పోర్ట్|ఇండిగో|ఎయిర్ ఇండియా|విమాన చార్జీలు|విమాన రద్దు|ఏరో/, s: 'Aviation' },
      // Women (before Crime — "వరకట్న వేధింపులు మహిళా పోలీసు కేసు" → Women)
      { re: /మహిళ|స్త్రీ|మహిళలు|అమ్మాయి|స్వయం సహాయక సంఘం|మహిళా|గర్భిణి|బాలిక|విద్యార్థిని|మహిళా సంఘం|నారీ|మహిళా శక్తి|వరకట్న వేధింపు|గృహ హింస|మహిళా పోలీసు/, s: 'Women' },
      // Public Health
      { re: /ఆరోగ్యం|వైద్యం|ఆసుపత్రి|వ్యాధి|మందు|టీకా|చికిత్స|డాక్టర్|రోగి|వైరస్|జ్వరం|కరోనా|మలేరియా|డెంగీ|టీబీ|బీపీ|షుగర్|క్యాన్సర్|గుండె వ్యాధి|ఆరోగ్య సేవ|నర్సు|వైద్యుడు|శస్త్రచికిత్స|ఔషధం|వ్యాక్సిన్|ఇంజెక్షన్|ఆరోగ్య కేంద్రం|యాంటీబయాటిక్|సీజనల్ జ్వరాలు|ఫ్లూ/, s: 'Public Health' },
      // Lifestyle (removed "పర్యటన" — also means official visit, fires for CM tours)
      { re: /జీవనశైలి|ఫ్యాషన్|వంట|రెసిపీ|టూరిజం|పర్యటన స్థలం|యోగా|ఫిట్నెస్|హెల్త్ టిప్స్|వంటకం|ఆహారం|బ్యూటీ|అందం|జుట్టు|చర్మం|సౌందర్యం|వెయిట్ లాస్|డైట్|వ్యాయామం|ట్రెండ్|ఫేస్‌పాక్|స్కిన్ కేర్/, s: 'Lifestyle' },
      // Agriculture — BEFORE Technology (headlines like "యాప్‌లో..రైతన్న" → Agriculture)
      // "వరి" REMOVED — substring-matches "ఎవరిపై"; use "వరి పంట/సాగు" instead
      { re: /వ్యవసాయం|రైతు|రైతన్న|రైతులు|పంట నష్టం|పంట బీమా|పంట|కరువు|సాగు|నీటిపారుదల|యూరియా|ఎరువు|పురుగు మందు|వ్యవసాయ|కూరగాయలు|ధాన్యం|వరి పంట|వరి సాగు|మొక్కజొన్న|చెరకు|పత్తి|మిర్చి|ఉల్లి|టమాటా|వ్యవసాయ రుణం|కిసాన్|రైతు భరోసా|ఆర్బీకే|కౌలు రైతు|పీఎం కిసాన్|ఫసల్ బీమా|వ్యవసాయ మార్కెట్|రైతు సమావేశం|అగ్రి/, s: 'Agriculture' },
      // Cyber-specific Technology — BEFORE Crime so "సైబర్ మోసం: హ్యాకింగ్" → Technology.
      // Only unambiguous cyber terms here; general tech (యాప్, మొబైల్, etc.) goes AFTER Crime.
      { re: /సైబర్ మోసం|సైబర్ నేరం|సైబర్ అటాక్|హ్యాకింగ్|హ్యాకర్|ఆన్‌లైన్ మోసం|ఆన్‌లైన్ స్కాం|డేటా లీక్|ర్యాన్సమ్‌వేర్/, s: 'Technology' },
      // Crime & Police — after cyber-Technology so "సైబర్ మోసం" doesn't land here,
      // but BEFORE general Technology so "పోలీసు|మర్డర్|దర్యాప్తు" don't land in Technology.
      // "మర్డర్" added — Telugu transliteration of "murder" used in telugu crime news.
      { re: /నేరం|హత్య|మర్డర్|దొంగతనం|అత్యాచారం|మోసం|పోలీసు|జైలు|అరెస్టు|నిందితుడు|దర్యాప్తు|వారెంట్|కిడ్నాప్|అపహరణ|దాడి|కాల్పులు|బాంబు|తస్కరణ|కాల్చి చంపారు|హత్యా యత్నం|దోపిడీ|నకిలీ నోట్లు|ట్రాప్|క్రైమ్|గ్యాంగ్|చార్జ్‌షీట్|పోలీస్ కస్టడీ|సీఐ|ఎస్పీ|డీఎస్పీ|ఎస్ఐ/, s: 'Crime & Police' },
      // Education — BEFORE Public Admin ("స్కాలర్‌షిప్ పథకం" → Education)
      { re: /విద్య|పాఠశాల|కళాశాల|విశ్వవిద్యాలయం|విద్యార్థి|పరీక్ష|ఫలితాలు|ర్యాంక్|ఇంటర్ పరీక్ష|టెన్త్|ఎంపీసీ|బైపీసీ|బీటెక్|ఎంటెక్|ఎంబీఏ|పీహెచ్డీ|అడ్మిషన్|స్కాలర్‌షిప్|హాస్టల్|ఉపాధ్యాయుడు|టీచర్|ప్రిన్సిపల్|ఈఏఎంసెట్|జేఈఈ|నీట్|పీజీ|యూజీ|విద్యా సంస్థ|ఫీజు|స్కూల్|కాలేజ్/, s: 'Education' },
      // General Technology — AFTER Crime so Crime keywords don't bleed into Technology.
      { re: /టెక్నాలజీ|సాంకేతిక|సైబర్|ఇంటర్నెట్|మొబైల్|స్మార్ట్‌ఫోన్|యాప్|ఆన్‌లైన్|డిజిటల్|ఆర్టిఫిషియల్ ఇంటెలిజెన్స్|ఏఐ|సాఫ్ట్‌వేర్|డ్రోన్|రోబో|ఆటోమేషన్|సాటిలైట్|ఇస్రో|కంప్యూటర్|లాప్‌టాప్|ఐటీ|స్టార్టప్|ఫిన్‌టెక్|క్రిప్టో|బ్లాక్‌చెయిన్|5జీ/, s: 'Technology' },
      // Sports — BEFORE International (cricket team names like "శ్రీలంక", "వెస్టిండీస్"
      // are also International country names — Sports must win for cricket context).
      // "ఆలౌట్" added — pure cricket term (all-out). "స్కోర" stem (without final virama)
      // matches "స్కోర్", "స్కోరు", "స్కోరెంత" etc. (Telugu inflected forms).
      { re: /క్రీడ|బ్యాటింగ్|బౌలింగ్|మ్యాచ్|టోర్నమెంట్|వికెట్|క్రికెట్|ఆటగాడు|శతకం|అర్ధ శతకం|పరుగులు|స్కోర|ఆలౌట్|ఫైనల్|సెమీఫైనల్|చాంపియన్|ఇన్నింగ్స్|ఆటలు|ఆటగాళ్లు|ఫుట్‌బాల్|బ్యాడ్మింటన్|కుస్తీ|బాక్సింగ్|టెస్ట్ మ్యాచ్|వన్డే|టీ20|ఐపీఎల్|ఆసియా కప్|వరల్డ్ కప్|స్పోర్ట్స్|అథ్లెట్|ఒలింపిక్స్|మెడల్|ట్రోఫీ|క్రీడాకారుడు|కెప్టెన్|కోచ్|టీమ్ ఇండియా|పిచ్|స్టేడియం|ఆటగత్తె|ఫీల్డింగ్|క్యాచ్|రన్ అవుట్|బౌండరీ|సిక్సర్|నో బాల్|వైడ్|ఓపెనర్|స్పిన్నర్|పేసర్|కబడ్డీ|వాలీబాల్|హాకీ|టెన్నిస్|షటిల్|ఈత|హాఫ్ సెంచరీ|రన్స్/, s: 'Sports' },
      // Cinema
      { re: /సినిమా|నటుడు|నటి|దర్శకుడు|రిలీజ్|పాట|వినోదం|హీరో|హీరోయిన్|చిత్రం|ట్రైలర్|ఓటీటీ|అవార్డ్|నటన|టాలీవుడ్|బాలీవుడ్|మ్యూజిక్|ఆల్బం|ప్రోమో|సినీ|తెలుగు చిత్రం|ఫిల్మ్|మూవీ|షూటింగ్|క్లైమాక్స్|ఫస్ట్ లుక్|టీజర్|రివ్యూ|రేటింగ్|బాక్సాఫీస్|కలెక్షన్|నిర్మాత|సంగీతం|నృత్యం|గీతం|వెబ్ సిరీస్|నెట్‌ఫ్లిక్స్|అమెజాన్ ప్రైమ్|హాట్‌స్టార్|జీ5|సన్ నెక్స్ట్|గ్లామర్|స్టార్/, s: 'Cinema' },
      // Irrigation (removed "ప్రాజెక్ట్" — too generic; political project → wrong section)
      { re: /జలాశయం|డ్యామ్|కాలువ|నీటి మట్టం|వరద నీరు|వరద|ఆనకట్ట|నీటి వనరులు|నదీ జలాలు|శ్రీశైలం|నాగార్జున సాగర్|గోదావరి నది|కృష్ణా నది|తుంగభద్ర|నీటి విడుదల|జల విద్యుత్|జలయజ్ఞం|పులిచింతల|శ్రీరాంసాగర్/, s: 'Irrigation' },
      // Roads & Buildings (removed standalone "నిర్మాణం" — fires for canal construction)
      { re: /రహదారి|హైవే|ఫ్లైఓవర్|వంతెన|ఓవర్‌బ్రిడ్జ్|రహదారులు|రోడ్డు|అండర్‌పాస్|ఎక్స్‌ప్రెస్‌వే|జాతీయ రహదారి|వంతెన నిర్మాణం|భవనం|అపార్ట్‌మెంట్|కూల్చివేత|అక్రమ నిర్మాణం|గుంతలు|ట్రాఫిక్ జామ|టోల్ప్లాజా|రోడ్డు నిర్మాణం/, s: 'Roads & Buildings' },
      // ── Location sections BEFORE Politics/Business/International ─────────────
      // Andhra Pradesh — must come before "మంత్రి/నేత" trigger Politics, and before
      // "వరద/కాలువ" trigger Irrigation. "పోలవరం" matches AP before Irrigation.
      { re: /ఆంధ్ర|అమరావతి|విజయవాడ|జగన్|చంద్రబాబు|విజాగ్|విశాఖపట్నం|నెల్లూరు|కడప|కర్నూలు|తిరుపతి|అనంతపురం|ఏలూరు|రాజమండ్రి|కాకినాడ|ఒంగోలు|గుంటూరు|లోకేష్|పవన్ కళ్యాణ్|పోలవరం|గన్నవరం|ఏపీ/, s: 'Andhra Pradesh' },
      // Telangana — must come before "నేత|పార్టీ" trigger Politics
      { re: /హైదరాబాద్|తెలంగాణ|సికింద్రాబాద్|రేవంత్|కేటీఆర్|బీఆర్ఎస్|వరంగల్|నిజామాబాద్|కరీంనగర్|ఖమ్మం|మెదక్|నల్గొండ|మహబూబ్‌నగర్|రంగారెడ్డి|మేడ్చల్|సంగారెడ్డి|ఆసిఫాబాద్|కేసీఆర్|అక్బరుద్దీన్|మల్లారెడ్డి|హరీష్ రావు|ఓవైసీ/, s: 'Telangana' },
      // National — BEFORE Business ("మోదీ లోక్‌సభలో బడ్జెట్" → National, not Business)
      // "రాజ్యసభ" kept here rather than Politics to avoid "సభ" substring issue
      { re: /కేంద్ర ప్రభుత్వం|లోక్‌సభ|రాజ్యసభ|కేంద్ర బడ్జెట్|భారత ప్రభుత్వం|మోదీ|అమిత్ షా|రాహుల్ గాంధీ|రాష్ట్రపతి|ఉపరాష్ట్రపతి|కేంద్ర మంత్రి|జాతీయ విధానం|కేంద్ర/, s: 'National' },
      // International
      { re: /విదేశీ|అంతర్జాతీయ|యుద్ధం|అమెరికా|రష్యా|చైనా|యూరప్|పాకిస్తాన్|ఇజ్రాయెల్|గాజా|ఉక్రెయిన్|బ్రిటన్|ఫ్రాన్స్|జపాన్|కొరియా|బంగ్లాదేశ్|నేపాల్|అఫ్ఘానిస్తాన్|ఐఎమ్ఎఫ్|ఐక్యరాజ్యసమితి|నాటో|రాయబారి|దౌత్యం|విదేశాంగ|ట్రంప్|పుతిన్|జిన్‌పింగ్/, s: 'International' },
      // Business
      { re: /వ్యాపారం|ఆర్థిక|బ్యాంక్|షేర్|మార్కెట్|పన్ను|ఎకానమీ|ఇన్వెస్ట్‌మెంట్|లాభం|నష్టం|ద్రవ్యోల్బణం|జీడీపీ|ఐపీఓ|ఫండ్|ఆర్బీఐ|సెన్సెక్స్|నిఫ్టీ|ఉద్యోగం|ఉపాధి|కంపెనీ|కార్పొరేట్|ఎగుమతి|దిగుమతి|వాణిజ్యం|జీఎస్టీ|ఆదాయపు పన్ను|స్టాక్|వ్యాపార|ఫిన్‌టెక్|వ్యాపారవేత్త|ఎంఎస్ఎంఈ|బడ్జెట్/, s: 'Business' },
      // Public Administration — Telugu stems to match inflected forms:
      //   "లబ్ధిదారు" matches లబ్ధిదారులు + లబ్ధిదారులకు
      //   "సంక్షేమ" matches సంక్షేమం + సంక్షేమ నిధులు
      //   "ఉద్యోగ" matches ఉద్యోగి + ఉద్యోగుల
      { re: /అధికారి|కలెక్టర్|పరిపాలన|సంక్షేమ|ప్రభుత్వ పథకం|లబ్ధిదారు|జీఓ|ఐఏఎస్|ఐపీఎస్|జిల్లా కలెక్టర్|ప్రభుత్వ ఉద్యోగ|కార్యాలయం|ప్రభుత్వ నిధులు|సెక్రటేరియట్|రెవెన్యూ విభాగం|సర్కారు|ప్రభుత్వ ఉత్తర్వు/, s: 'Public Administration' },
      // Politics — "సభ" REMOVED (substring of "రాజ్యసభ" → false positive)
      { re: /రాజకీయ|ఎన్నికలు|మంత్రి|నేత|పార్టీ|శాసనసభ|ముఖ్యమంత్రి|గవర్నర్|ఎమ్మెల్యే|ఎంపీ|సీఎం|ఎలక్షన్|ఓటు|మతదారులు|నియోజకవర్గం|టీడీపీ|వైఎస్ఆర్సీపీ|బీజేపీ|కాంగ్రెస్|బీఆర్ఎస్|జనసేన|ఆప్|ఎమ్ఐఎమ్|కూటమి|ప్రతిపక్షం|అధికారపక్షం|పార్టీ సభ|ప్రజాసభ|సెషన్|మీటింగ్|ర్యాలీ|పాద యాత్ర|ఓటుహక్కు|ఉప ఎన్నిక|ప్రచారం/, s: 'Politics' },
      // National fallback
      { re: /భారత్|జాతీయ|ఢిల్లీ|పార్లమెంట్/, s: 'National' },
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
        doc.querySelectorAll(selector).forEach(el => {
          if (articles.length >= 80) return;

          const anchor = el.tagName === 'A' ? el : el.querySelector('a');
          const rawHeadline = (anchor || el).textContent.replace(/\s+/g, ' ').trim();
          // Strip photo-count badges (+11 …) and video-duration badges (552s …)
          // (sakshi.com renders these as part of the card text alongside the headline)
          const headline = rawHeadline.replace(/^\+\d+\s+/, '').replace(/^\d+s\s+/, '').trim();
          // Min 20 chars — filters nav section labels ("ఏపీ వార్తలు" = 12 chars, "Sports" = 6 chars)
          // Max 300 — skips text that got concatenated from multiple layout elements
          if (!headline || headline.length < 20 || headline.length > 300) return;
          if (seen.has(headline)) return;

          // ── Clickbait / ad widget filter ──────────────────────────────────────
          // [Story], [Video], [Sponsored] prefixes come from Taboola/Yahoo widgets
          if (/^\[(Story|Video|Ad|Sponsored|Watch)\]/i.test(headline)) return;
          // Pure-English headlines on Telugu newspaper sites = clickbait/ad injection.
          // Real news on sakshi.com / eenadu.net is in Telugu. English proper for English edition only.
          const teluguCount = (headline.match(/[ఀ-౿]/g) || []).length;
          if (teluguCount === 0 && /sakshi|eenadu/.test(window.location.hostname)) return;
          // Photo gallery articles — "(ఫొటోలు)" suffix means it's a slideshow, not a news article.
          // These get scraped as articles but have no readable body text.
          if (/\(ఫొటోలు\)$/.test(headline.trim())) return;

          seen.add(headline);

          // Resolve href correctly for both live and DOMParser documents.
          // anchor.href is fully resolved in live docs; for DOMParser docs we need manual resolution.
          let href = '';
          if (anchor) {
            const raw = anchor.getAttribute('href') || '';
            if (raw) {
              try {
                href = raw.startsWith('http') ? raw : new URL(raw, baseUrl).href;
              } catch(_) { href = raw; }
            }
          }
          // Skip anchor-only links
          if (href && (href.startsWith('#') || href.endsWith('#'))) return;
          // Skip navigation/section index pages — they have only 1 path segment
          // e.g. sakshi.com/sports (nav) vs sakshi.com/sports/cricket/title/12345 (article)
          if (href) {
            try {
              const pathParts = new URL(href).pathname.split('/').filter(Boolean);
              if (pathParts.length < 2) return;
            } catch (_) {}
          }

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
            url:         href || baseUrl + '/',
            publishedAt: new Date().toISOString().slice(0, 10),
          });
        });
      } catch (_) {}

      if (articles.length >= 80) break;
    }

    return articles;
  }

  // ── 2. Build the content string for the AI ─────────────────────────────────
  function buildContentString(articles) {
    if (!articles.length) return '';
    const bySection = {};
    articles.forEach(a => { (bySection[a.section] = bySection[a.section] || []).push(a); });

    let out = `[${window.location.hostname} | ${new Date().toLocaleDateString()}]\n\n`;
    for (const [section, items] of Object.entries(bySection)) {
      out += `\n=== ${section.toUpperCase()} ===\n`;
      items.forEach(a => {
        // No summary line — home-page teasers are just truncated headlines,
        // so including them causes the AI to output the same sentence twice.
        // Full body text is added later by newsai-content.js background enrichment.
        out += `• ${a.headline}\n`;
        if (a.url && a.url !== window.location.href && !a.url.endsWith('/')) {
          out += `  ${a.url}\n`;
        }
      });
    }
    return out;
  }

  // ── 3. Load API key from chrome.storage ───────────────────────────────────
  // Reads sync first (persists across reloads, reinstalls, and devices via Google account).
  // Falls back to local storage (covers offline Chrome or sync-disabled profiles).
  // The key is saved to BOTH stores by popup.js, so at least one will always have it.
  function getStoredKey() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get(['newsai_api_key', 'newsai_groq_key'], syncResult => {
          if (chrome.runtime.lastError) {
            console.warn('[NewsAI] sync.get error:', chrome.runtime.lastError.message);
          }
          const syncKey = syncResult && (syncResult.newsai_api_key || syncResult.newsai_groq_key);
          if (syncKey) {
            console.log('[NewsAI] ✅ API key loaded from sync storage. Provider prefix:', syncKey.slice(0, 6));
            resolve(syncKey);
            return;
          }
          // Fallback: local storage (older saves or sync unavailable)
          chrome.storage.local.get(['newsai_api_key', 'newsai_groq_key'], localResult => {
            if (chrome.runtime.lastError) {
              console.warn('[NewsAI] local.get error:', chrome.runtime.lastError.message);
            }
            const localKey = localResult && (localResult.newsai_api_key || localResult.newsai_groq_key);
            if (localKey) {
              console.log('[NewsAI] ✅ API key loaded from local storage. Provider prefix:', localKey.slice(0, 6));
            } else {
              console.warn('[NewsAI] ❌ No API key found in sync or local storage. Open the extension popup and paste your key.');
            }
            resolve(localKey || '');
          });
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

  // ── 6. Section-page augmenter ─────────────────────────────────────────────
  /**
   * Sakshi / Eenadu keep Sports, Cinema, Entertainment on SEPARATE pages
   * that are never linked from the homepage. This fetches those pages in
   * parallel and merges the unique articles (deduped by headline) into the
   * main set, forcing the correct section label so filters work correctly.
   *
   * Runs after Phase 2 — never blocks the widget's initial render.
   */
  async function fetchSectionPages(existingArticles) {
    const host = window.location.hostname;

    // Site-specific section page map — covers ALL major sections of each paper.
    // Articles on these dedicated pages are often absent from the homepage,
    // so we fetch them in parallel and force the correct section label.
    let sectionPages = [];
    if (host.includes('sakshi')) {
      const base = 'https://www.sakshi.com';
      sectionPages = [
        // Sports — never on homepage
        { url: `${base}/sports`,              section: 'Sports' },
        { url: `${base}/sports/cricket`,      section: 'Sports' },
        // Cinema / Entertainment
        { url: `${base}/cinema`,              section: 'Cinema' },
        { url: `${base}/movies`,              section: 'Cinema' },
        // Politics
        { url: `${base}/politics`,            section: 'Politics' },
        // Crime & Police
        { url: `${base}/crime`,               section: 'Crime & Police' },
        // National
        { url: `${base}/national`,            section: 'National' },
        // Business
        { url: `${base}/business`,            section: 'Business' },
        // Telangana
        { url: `${base}/tags/telangana`,      section: 'Telangana' },
        // Andhra Pradesh
        { url: `${base}/tags/andhra-pradesh`, section: 'Andhra Pradesh' },
      ];
    } else if (host.includes('eenadu')) {
      const base = 'https://www.eenadu.net';
      sectionPages = [
        { url: `${base}/sports`,            section: 'Sports' },
        { url: `${base}/cinema`,            section: 'Cinema' },
        { url: `${base}/business`,          section: 'Business' },
        { url: `${base}/national`,          section: 'National' },
        { url: `${base}/international`,     section: 'International' },
        { url: `${base}/andhra-pradesh`,    section: 'Andhra Pradesh' },
        { url: `${base}/telangana`,         section: 'Telangana' },
      ];
    }

    if (!sectionPages.length) return existingArticles;

    const existingHeadlines = new Set(existingArticles.map(a => a.headline));
    const newArticles = [];

    // Fetch all section pages in parallel — independent of each other
    await Promise.all(sectionPages.map(async ({ url, section }) => {
      try {
        const resp = await fetch(url, {
          headers:     { 'Accept': 'text/html' },
          signal:      AbortSignal.timeout(8000),
          credentials: 'omit',
        });
        if (!resp.ok) return;
        const html = await resp.text();
        const doc  = new DOMParser().parseFromString(html, 'text/html');
        const arts = extractPageArticles(doc, url);
        let added = 0;
        for (const a of arts) {
          if (!existingHeadlines.has(a.headline)) {
            existingHeadlines.add(a.headline);
            // Force the section label — we know which page this came from
            newArticles.push({ ...a, section });
            added++;
          }
        }
        const slug = url.replace('https://www.', '').replace(/\/$/, '');
        console.log(`[NewsAI] Section page "${slug}": +${added} articles`);
      } catch (_) {
        // Timeout / network error — skip silently
      }
    }));

    if (!newArticles.length) return existingArticles;
    const total = existingArticles.length + newArticles.length;
    console.log(`[NewsAI] Section augmentation: +${newArticles.length} new articles (total ${total})`);
    return [...existingArticles, ...newArticles];
  }

  // ── 7. Push a content refresh to the main-world widget via postMessage ─────
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

  // ── Newspaper branding by hostname ────────────────────────────────────────
  function getBranding() {
    const host = window.location.hostname;
    if (host.includes('sakshi')) {
      return {
        name:             'Sakshi AI',
        shortName:        'స',
        primaryColor:     '#E8890C',
        welcomeMessage:   'నమస్కారం! నేను సాక్షి AI. ఈ రోజు పేపర్ గురించి ఏదైనా అడగండి!',
        welcomeMessageEn: "Hello! I'm your Sakshi AI assistant. Ask me anything about today's paper!",
      };
    }
    return {
      name:             'Eenadu AI',
      shortName:        'ఈ',
      primaryColor:     '#C0392B',
      welcomeMessage:   'నమస్కారం! నేను ఈనాడు AI. ఈ రోజు పేపర్ గురించి ఏదైనా అడగండి!',
      welcomeMessageEn: "Hello! I'm your Eenadu AI assistant. Ask me anything about today's paper!",
    };
  }

  // ── 7. Main init ──────────────────────────────────────────────────────────
  async function init() {
    // Guard: when the extension is reloaded while the page stays open,
    // chrome.runtime becomes undefined (invalidated context). Bail out safely.
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
      console.warn('[NewsAI] Extension context invalidated — please reload the page (F5).');
      return;
    }

    const apiKey = await getStoredKey();

    // Phase 1 — immediate scrape with whatever is in the DOM right now
    let articles = extractPageArticles();

    // Fallback: epaper pages (epaper.sakshi.com) are rendered as images — no text in DOM.
    // When we get 0 articles on any *.sakshi.com subdomain, fetch www.sakshi.com and
    // scrape it instead. The extension has host_permission for *.sakshi.com so this works.
    if (articles.length === 0 && window.location.hostname.includes('sakshi')) {
      console.log('[NewsAI] Image-based page — fetching www.sakshi.com for articles...');
      try {
        const resp = await fetch('https://www.sakshi.com/', {
          headers: { 'Accept': 'text/html' },
          signal: AbortSignal.timeout(10000),
          credentials: 'omit',
        });
        if (resp.ok) {
          const html = await resp.text();
          const remoteDoc = new DOMParser().parseFromString(html, 'text/html');
          articles = extractPageArticles(remoteDoc, 'https://www.sakshi.com');
          console.log(`[NewsAI] Fallback scrape www.sakshi.com: ${articles.length} articles`);
        }
      } catch (e) {
        console.warn('[NewsAI] Fallback fetch failed:', e.message);
      }
    }

    // todayContent must be truthy — empty string causes newsai-content.js to fall
    // through to RSS mode and log "No RSS URL configured".
    const todayContent = buildContentString(articles) || '(ఈ పేజీలో వార్తలు అందుబాటులో లేవు. Please try www.sakshi.com directly.)';

    // Log section breakdown so we can verify Sports/Cinema are captured
    const sectionCounts = articles.reduce((acc, a) => { acc[a.section] = (acc[a.section] || 0) + 1; return acc; }, {});
    console.log(`[NewsAI] Phase 1 scrape: ${articles.length} articles`, sectionCounts);

    const ALL_SECTIONS = [
      'National', 'Telangana', 'Andhra Pradesh', 'International',
      'Sports', 'Business', 'Cinema', 'Politics',
      'Crime & Police', 'Courts', 'Education', 'Public Health',
      'Technology', 'Agriculture', 'Women', 'Lifestyle',
      'Railways', 'Aviation', 'Roads & Buildings', 'Irrigation',
      'Local Bodies', 'Public Administration',
    ];

    // Section redirect URLs — maps Telugu section names → sakshi.com URLs
    // Must be passed to widget so the post-response redirect button works.
    const SECTION_URLS = {
      'తెలంగాణ':          'https://www.sakshi.com/tags/telangana',
      'ఆంధ్రప్రదేశ్':    'https://www.sakshi.com/tags/andhra-pradesh',
      'జాతీయం':           'https://www.sakshi.com/national',
      'అంతర్జాతీయం':     'https://www.sakshi.com/international',
      'క్రికెట్':         'https://www.sakshi.com/sports/cricket',
      'క్రీడలు':          'https://www.sakshi.com/sports',
      'సినిమా':           'https://www.sakshi.com/cinema',
      'టాలీవుడ్':         'https://www.sakshi.com/tollywood',
      'వ్యాపారం':         'https://www.sakshi.com/business',
      'కుటుంబం':          'https://www.sakshi.com/family',
      'రాజకీయాలు':        'https://www.sakshi.com/politics',
      'నేరాలు':           'https://www.sakshi.com/crime',
      'ఓటీటీ':            'https://www.sakshi.com/ott',
      // Previously missing — redirect button was dead for these sections (Bug 1 fix)
      'మహిళలు':           'https://www.sakshi.com/women',
      'వ్యవసాయం':         'https://www.sakshi.com/agriculture',
      'విద్య':            'https://www.sakshi.com/education',
      'ఆరోగ్యం':          'https://www.sakshi.com/health',
      'సాంకేతిక':         'https://www.sakshi.com/technology',
      'న్యాయస్థానం':      'https://www.sakshi.com/courts',
      'రైల్వే':           'https://www.sakshi.com/railways',
      'విమానాలు':         'https://www.sakshi.com/aviation',
      'నీటిపారుదల':       'https://www.sakshi.com/irrigation',
      'రహదారులు':         'https://www.sakshi.com/roads',
      'స్థానిక సంస్థలు': 'https://www.sakshi.com/local-bodies',
      'పరిపాలన':          'https://www.sakshi.com/administration',
      'జీవనశైలి':         'https://www.sakshi.com/lifestyle',
    };

    const configPayload = {
      config: {
        brand:           getBranding(),
        languages:       ['te', 'en'],
        defaultLanguage: 'te',
        sections:        ALL_SECTIONS,
        contentSource:   { type: 'preloaded' },
        apiKey:          apiKey,   // provider-agnostic; widget detects from key prefix
        llmModel:        'llama-3.1-8b-instant',
        backendUrl:      'http://localhost:3001', // RAG/TTS/digest/chips — change to deployed URL when hosted
        position:        'bottom-right',
        sectionUrls:     SECTION_URLS,
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

    // ── Phase 3: fetch ALL section pages IMMEDIATELY after Phase 1 ─────────────
    // Section pages (Sports, Cinema, Business, Politics, etc.) are separate URLs —
    // they don't need the homepage DOM to settle, so we start fetching right away.
    // This means Sports/Cinema/Business answers work within seconds of page load,
    // not after the 4-second Phase 2 delay.
    const isImagePage = articles.length > 0 && articles[0].url.startsWith('https://www.sakshi.com') && window.location.hostname.includes('epaper');
    let cachedSectionArticles = []; // reused by Phase 2 so we don't re-fetch

    if (isImagePage) {
      // epaper image pages can't fetch section sub-pages, but we still need to
      // unblock section-specific queries — push Phase 1 articles as-is so
      // sectionPagesReady gets set to true in newsai-content.js.
      console.log('[NewsAI] isImagePage — skipping section fetches, pushing Phase 1 articles directly');
      pushContentRefresh(articles);
    }

    if (!isImagePage) {
      fetchSectionPages(articles).then(augmented => {
        // Cache the section-only articles (deduplicated vs Phase 1)
        const phase1Headlines = new Set(articles.map(a => a.headline));
        cachedSectionArticles = augmented.filter(a => !phase1Headlines.has(a.headline));

        if (cachedSectionArticles.length > 0) {
          const sectionCounts = augmented.reduce((acc, a) => {
            acc[a.section] = (acc[a.section] || 0) + 1;
            return acc;
          }, {});
          console.log(`[NewsAI] ✅ Section pages loaded: ${augmented.length} articles`, sectionCounts);
          pushContentRefresh(augmented);
        }
      });

      // ── Phase 2: re-scrape homepage DOM after 4 s for dynamically rendered articles ──
      // Merges with already-cached section articles — no redundant section page fetches.
      setTimeout(() => {
        const fresh = extractPageArticles();
        console.log(`[NewsAI] Phase 2 scrape: ${fresh.length} articles (was ${articles.length})`);

        // Merge Phase 2 homepage scrape with cached section articles (deduplicated)
        const freshHeadlines = new Set(fresh.map(a => a.headline));
        const merged = [...fresh, ...cachedSectionArticles.filter(a => !freshHeadlines.has(a.headline))];

        const sectionCounts = merged.reduce((acc, a) => {
          acc[a.section] = (acc[a.section] || 0) + 1;
          return acc;
        }, {});
        console.log(`[NewsAI] ✅ Phase 2 complete: ${merged.length} articles`, sectionCounts);

        if (merged.length > 0) {
          pushContentRefresh(merged);
        }
      }, 4000);
    }
  }

  // Wait for page to be fully loaded so DOM scraping gets all articles
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
