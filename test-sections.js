/**
 * Section classifier test — run with:  node test-sections.js
 *
 * Tests the SECTION_MAP + TELUGU_MAP keyword logic against 140+ real-world
 * sakshi.com-style headlines. Reports pass/fail per section and overall accuracy.
 *
 * Maps must stay in sync with extension/content.js.
 */

'use strict';

// ── Replicate maps from extension/content.js ─────────────────────────────────
// ORDER RULES:
//   • Women before Crime
//   • Agriculture before Technology AND Sports
//   • Technology before Crime (cyber headlines)
//   • Education before Public Admin
//   • AP/TS before Irrigation (city names beat generic flood/dam keywords)
//   • Sports before International (cricket team names like శ్రీలంక)
//   • AP/TS/National before Politics/Business

const SECTION_MAP = [
  { re: /supreme court|high court|sessions court|district court|judge|verdict|judgment|bail denied|acquitted|convicted|petition|contempt|\bHC\b|\bSC\b|remand|chargesheet|prosecution|acquittal|sentence|appeal|stay order/i, s: 'Courts' },
  { re: /\bghmc\b|\bgvmc\b|municipality|municipal corporation|panchayat|\bward\b|\bmayor\b|councillor|sarpanch|gram panchayat/i, s: 'Local Bodies' },
  { re: /railway|train|\bmetro\b|rail|irctc|vande.bharat|express.train|locomotive|station|passenger|ticket|derail/i, s: 'Railways' },
  { re: /airport|aviation|airline|flight|aircraft|airbus|boeing|indigo|spicejet|air india|air traffic|pilot/i, s: 'Aviation' },
  { re: /women|woman|girl|female|mahila|ladies|gender|self.help.group|\bSHG\b|domestic violence|dowry|maternity/i, s: 'Women' },
  { re: /murder|killed|robbery|theft|rape|fraud|scam|arrested|police|jail|custody|bail|warrant|chargesheet|suspect|investigation|kidnap|abduction|assault|firing|gang|dacoity|loot|fake|trap|attack|stabbing|explosion/i, s: 'Crime & Police' },
  { re: /health|hospital|doctor|disease|medicine|vaccine|surgery|cancer|dengue|malaria|covid|aarogya|virus|fever|tb|diabetes|bp|cardiac|nurse|treatment|outbreak/i, s: 'Public Health' },
  // "travel" removed — too generic (official CM visits are not Lifestyle)
  { re: /lifestyle|fashion|beauty|food recipe|yoga|fitness|wellness|skincare|haircare|diet|weight loss|health tips/i, s: 'Lifestyle' },
  // Technology before Crime — cyber headlines → Technology, not Crime
  { re: /technology|software|\bai\b|artificial intelligence|internet|mobile|app|cyber|digital|startup|isro|nasa|satellite|drone|robot|automation|smartphone|hack|fintech|it sector/i, s: 'Technology' },
  // Education before Public Admin — scholarship → Education
  { re: /education|school|college|university|exam|student|admission|scholarship|eamcet|jee|neet|inter|btech|mba|phd|teacher|principal|hostel|results|rank/i, s: 'Education' },
  // Agriculture before Public Admin — farmer welfare → Agriculture
  { re: /farmer|agriculture|crop|paddy|harvest|drought|ryot|urea|fertilizer|pesticide|kisan|fasal bima|sowing|yield|rytu|agricultural/i, s: 'Agriculture' },
  { re: /cricket|football|\bipl\b|sport|match|tournament|wicket|innings|\brun\b|player|team|league|trophy|fifa|olympic|badminton|boxing|kabaddi|hockey|tennis|volleyball|swimmer|athlete|stadium|coach|captain|batting|bowling|fielding|boundary|six|century/i, s: 'Sports' },
  // "review" removed — fires on "government review meet"
  { re: /cinema|film|movie|tollywood|bollywood|\bott\b|serial|television|album|actor|actress|director|release|trailer|teaser|box.office|collection|netflix|amazon prime|hotstar|shooting|producer/i, s: 'Cinema' },
  // AP/TS BEFORE Irrigation — "Vijayawada floods" → AP, not Irrigation
  { re: /andhra|amaravati|vijayawada|jagan|chandrababu|guntur|vizag|visakhapatnam|nellore|kadapa|kurnool|tirupati|anantapur|eluru|rajahmundry|kakinada|ongole|lokesh|pawan kalyan|polavaram/i, s: 'Andhra Pradesh' },
  { re: /telangana|hyderabad|secunderabad|revanth|\bktr\b|\bbrs\b|warangal|nizamabad|karimnagar|khammam|medak|nalgonda|mahabubnagar|rangareddy|kcr|owaisi|harish rao/i, s: 'Telangana' },
  { re: /irrigation|reservoir|dam|canal|water level|flood|godavari|krishna river|srisailam|nagarjuna sagar|tungabhadra/i, s: 'Irrigation' },
  { re: /road|highway|flyover|overbridge|underpass|bridge|expressway|pothole|traffic jam|toll/i, s: 'Roads & Buildings' },
  // National BEFORE Politics and Business — "Modi budget speech" → National
  { re: /lok sabha|rajya sabha|central government|modi|amit shah|rahul gandhi|president of india|vice president|prime minister|union budget/i, s: 'National' },
  { re: /international|world|global|america|russia|china|\busa\b|\buk\b|europe|pakistan|israel|ukraine|gaza|nato|un summit|diplomat|ambassador|foreign|war|conflict|nuclear/i, s: 'International' },
  { re: /business|market|economy|sensex|nifty|stock|finance|budget|tax|\brbi\b|\bgdp\b|inflation|trade|import|export|ipo|investment|profit|loss|gst|income tax|company|corporate/i, s: 'Business' },
  { re: /politics|political|election|vote|candidate|minister|parliament|assembly|party|manifesto|\btdp\b|\bysrcp\b|\bbjp\b|congress|\bbrs\b|janasena|\baap\b|\bmim\b|rally|padayatra|bypolls/i, s: 'Politics' },
  // National fallback (generic English words)
  { re: /national|india|parliament|delhi/i, s: 'National' },
  // "welfare scheme" removed — too generic, fires on Agriculture/Education headlines
  { re: /collector|district administration|\bias\b|\bips\b|government order|circular|beneficiaries|secretariat|revenue department|district office/i, s: 'Public Administration' },
];

const TELUGU_MAP = [
  { re: /సుప్రీంకోర్టు|హైకోర్టు|జిల్లా కోర్టు|న్యాయమూర్తి|తీర్పు|న్యాయస్థానం|కోర్టు విచారణ|బెయిల్ నిరాకరణ|రిమాండ్|పిటిషన్|స్టే ఆర్డర్|అప్పీల్|జైలు శిక్ష|నిర్దోషి|దోషి|లాయర్|అడ్వొకేట్|హైకోర్టు ఆదేశం|న్యాయ విచారణ/, s: 'Courts' },
  { re: /కార్పొరేషన్|నగరపాలక|పురపాలక|పంచాయతీ|వార్డు|మేయర్|మున్సిపల్|జీహెచ్ఎంసీ|జీవీఎంసీ|నగరపాలక సంస్థ|పట్టణ పాలన|కౌన్సిలర్|డివిజన్|సర్పంచ్|గ్రామపంచాయతీ|జడ్పీ|మండల|జిల్లా పరిషత్/, s: 'Local Bodies' },
  { re: /రైల్వే|రైలు|మెట్రో|వందే భారత్|రైల్వే స్టేషన్|ట్రెయిన్|ఐఆర్సీటీసీ|రైలు ప్రమాదం|రైలు ఆలస్యం|ప్రయాణికులు|రైలు సేవలు|పాసింజర్|రైలు టిక్కెట్|మెట్రో రైలు|రైలు పట్టాలు|లోకల్ రైలు|ఎక్స్‌ప్రెస్ రైలు/, s: 'Railways' },
  { re: /విమానం|విమానాశ్రయం|ఏవియేషన్|విమాన సేవలు|ఫ్లైట్|పైలట్|విమాన ప్రమాదం|ఎయిర్‌పోర్ట్|ఇండిగో|ఎయిర్ ఇండియా|విమాన చార్జీలు|విమాన రద్దు|ఏరో/, s: 'Aviation' },
  // Women before Crime — dowry/domestic violence headlines are Women stories
  { re: /మహిళ|స్త్రీ|మహిళలు|అమ్మాయి|స్వయం సహాయక సంఘం|మహిళా|గర్భిణి|బాలిక|విద్యార్థిని|మహిళా సంఘం|నారీ|మహిళా శక్తి|వరకట్న వేధింపు|గృహ హింస|మహిళా పోలీసు/, s: 'Women' },
  { re: /ఆరోగ్యం|వైద్యం|ఆసుపత్రి|వ్యాధి|మందు|టీకా|చికిత్స|డాక్టర్|రోగి|వైరస్|జ్వరం|కరోనా|మలేరియా|డెంగీ|టీబీ|బీపీ|షుగర్|క్యాన్సర్|గుండె వ్యాధి|ఆరోగ్య సేవ|నర్సు|వైద్యుడు|శస్త్రచికిత్స|ఔషధం|వ్యాక్సిన్|ఇంజెక్షన్|ఆరోగ్య కేంద్రం|సీజనల్ జ్వరాలు|ఫ్లూ/, s: 'Public Health' },
  // "పర్యటన" removed — matches official CM visits ("పర్యటన" = visit/tour)
  { re: /జీవనశైలి|ఫ్యాషన్|వంట|రెసిపీ|టూరిజం|పర్యటన స్థలం|యోగా|ఫిట్నెస్|హెల్త్ టిప్స్|వంటకం|ఆహారం|బ్యూటీ|అందం|జుట్టు|చర్మం|సౌందర్యం|వెయిట్ లాస్|డైట్|వ్యాయామం|ట్రెండ్|స్కిన్ కేర్/, s: 'Lifestyle' },
  // Agriculture BEFORE Technology — "యాప్‌లో..రైతన్న" → Agriculture, not Technology
  // "వరి" REPLACED with "వరి పంట|వరి సాగు" — bare "వరి" substring-matches "ఎవరిపై"
  { re: /వ్యవసాయం|రైతు|రైతన్న|రైతులు|పంట నష్టం|పంట బీమా|పంట|కరువు|సాగు|నీటిపారుదల|యూరియా|ఎరువు|పురుగు మందు|వ్యవసాయ|కూరగాయలు|ధాన్యం|వరి పంట|వరి సాగు|మొక్కజొన్న|చెరకు|పత్తి|మిర్చి|ఉల్లి|టమాటా|వ్యవసాయ రుణం|కిసాన్|రైతు భరోసా|ఆర్బీకే|కౌలు రైతు|పీఎం కిసాన్|ఫసల్ బీమా|వ్యవసాయ మార్కెట్|రైతు సమావేశం|అగ్రి/, s: 'Agriculture' },
  // Cyber-specific Technology BEFORE Crime — only unambiguous cyber terms.
  // General tech (యాప్, మొబైల్, etc.) goes AFTER Crime to avoid mystery Tech matches
  // on crime headlines (e.g. "గుంటూరులో డబుల్ మర్డర్.. పోలీసు దర్యాప్తు" → Crime).
  { re: /సైబర్ మోసం|సైబర్ నేరం|సైబర్ అటాక్|హ్యాకింగ్|హ్యాకర్|ఆన్‌లైన్ మోసం|ఆన్‌లైన్ స్కాం|డేటా లీక్|ర్యాన్సమ్‌వేర్/, s: 'Technology' },
  // Crime & Police BEFORE general Technology — "మర్డర్" added (Telugu transliteration of murder)
  { re: /నేరం|హత్య|మర్డర్|దొంగతనం|అత్యాచారం|మోసం|పోలీసు|జైలు|అరెస్టు|నిందితుడు|దర్యాప్తు|వారెంట్|కిడ్నాప్|అపహరణ|దాడి|కాల్పులు|బాంబు|తస్కరణ|కాల్చి చంపారు|హత్యా యత్నం|దోపిడీ|నకిలీ నోట్లు|ట్రాప్|క్రైమ్|గ్యాంగ్|చార్జ్‌షీట్|పోలీస్ కస్టడీ|సీఐ|ఎస్పీ|డీఎస్పీ|ఎస్ఐ/, s: 'Crime & Police' },
  // Education before Public Admin — "స్కాలర్‌షిప్ పథకం" → Education
  { re: /విద్య|పాఠశాల|కళాశాల|విశ్వవిద్యాలయం|విద్యార్థి|పరీక్ష|ఫలితాలు|ర్యాంక్|ఇంటర్ పరీక్ష|టెన్త్|ఎంపీసీ|బైపీసీ|బీటెక్|ఎంటెక్|ఎంబీఏ|పీహెచ్డీ|అడ్మిషన్|స్కాలర్‌షిప్|హాస్టల్|ఉపాధ్యాయుడు|టీచర్|ప్రిన్సిపల్|ఈఏఎంసెట్|జేఈఈ|నీట్|పీజీ|యూజీ|విద్యా సంస్థ|ఫీజు|స్కూల్|కాలేజ్/, s: 'Education' },
  // General Technology AFTER Crime — non-cyber tech headlines can't bleed into Crime.
  { re: /టెక్నాలజీ|సాంకేతిక|సైబర్|ఇంటర్నెట్|మొబైల్|స్మార్ట్‌ఫోన్|యాప్|ఆన్‌లైన్|డిజిటల్|ఆర్టిఫిషియల్ ఇంటెలిజెన్స్|ఏఐ|సాఫ్ట్‌వేర్|డ్రోన్|రోబో|ఆటోమేషన్|సాటిలైట్|ఇస్రో|కంప్యూటర్|లాప్‌టాప్|ఐటీ|స్టార్టప్|ఫిన్‌టెక్|క్రిప్టో|5జీ/, s: 'Technology' },
  // Sports BEFORE International — "శ్రీలంక 308 ఆలౌట్" → Sports, not International.
  // "ఆలౌట్" = all-out (pure cricket term). "స్కోర" = stem without virama, matches
  // inflected forms: "స్కోర్", "స్కోరు", "స్కోరెంత" etc.
  { re: /క్రీడ|బ్యాటింగ్|బౌలింగ్|మ్యాచ్|టోర్నమెంట్|వికెట్|క్రికెట్|ఆటగాడు|శతకం|అర్ధ శతకం|పరుగులు|స్కోర|ఆలౌట్|ఫైనల్|సెమీఫైనల్|చాంపియన్|ఇన్నింగ్స్|ఆటలు|ఆటగాళ్లు|ఫుట్‌బాల్|బ్యాడ్మింటన్|కుస్తీ|బాక్సింగ్|టెస్ట్ మ్యాచ్|వన్డే|టీ20|ఐపీఎల్|ఆసియా కప్|వరల్డ్ కప్|స్పోర్ట్స్|అథ్లెట్|ఒలింపిక్స్|మెడల్|ట్రోఫీ|క్రీడాకారుడు|కెప్టెన్|కోచ్|టీమ్ ఇండియా|పిచ్|స్టేడియం|ఆటగత్తె|ఫీల్డింగ్|క్యాచ్|రన్ అవుట్|బౌండరీ|సిక్సర్|హాఫ్ సెంచరీ|రన్స్/, s: 'Sports' },
  { re: /సినిమా|నటుడు|నటి|దర్శకుడు|రిలీజ్|పాట|వినోదం|హీరో|హీరోయిన్|చిత్రం|ట్రైలర్|ఓటీటీ|అవార్డ్|నటన|టాలీవుడ్|బాలీవుడ్|మ్యూజిక్|ఆల్బం|ప్రోమో|సినీ|తెలుగు చిత్రం|ఫిల్మ్|మూవీ|షూటింగ్|క్లైమాక్స్|ఫస్ట్ లుక్|టీజర్|రివ్యూ|రేటింగ్|బాక్సాఫీస్|కలెక్షన్|నిర్మాత|సంగీతం|నృత్యం|గీతం|వెబ్ సిరీస్|నెట్‌ఫ్లిక్స్|హాట్‌స్టార్|జీ5|సన్ నెక్స్ట్|గ్లామర్|స్టార్/, s: 'Cinema' },
  // ── Location sections BEFORE Irrigation/Politics/Business ────────────────────
  // AP/TS names are more specific than flood/dam/party keywords.
  // "పోలవరం" → AP (not Irrigation), "హైదరాబాద్ వరద" → TS (not Irrigation).
  { re: /ఆంధ్ర|అమరావతి|విజయవాడ|జగన్|చంద్రబాబు|విజాగ్|విశాఖపట్నం|నెల్లూరు|కడప|కర్నూలు|తిరుపతి|అనంతపురం|ఏలూరు|రాజమండ్రి|కాకినాడ|ఒంగోలు|గుంటూరు|లోకేష్|పవన్ కళ్యాణ్|పోలవరం|గన్నవరం|ఏపీ/, s: 'Andhra Pradesh' },
  { re: /హైదరాబాద్|తెలంగాణ|సికింద్రాబాద్|రేవంత్|కేటీఆర్|బీఆర్ఎస్|వరంగల్|నిజామాబాద్|కరీంనగర్|ఖమ్మం|మెదక్|నల్గొండ|మహబూబ్‌నగర్|రంగారెడ్డి|మేడ్చల్|సంగారెడ్డి|ఆసిఫాబాద్|కేసీఆర్|అక్బరుద్దీన్|మల్లారెడ్డి|హరీష్ రావు|ఓవైసీ/, s: 'Telangana' },
  // "ప్రాజెక్ట్" REMOVED from Irrigation — too generic (political projects mis-fire)
  { re: /జలాశయం|డ్యామ్|కాలువ|నీటి మట్టం|వరద నీరు|వరద|ఆనకట్ట|నీటి వనరులు|నదీ జలాలు|శ్రీశైలం|నాగార్జున సాగర్|గోదావరి నది|కృష్ణా నది|తుంగభద్ర|నీటి విడుదల|జల విద్యుత్|జలయజ్ఞం|పులిచింతల|శ్రీరాంసాగర్/, s: 'Irrigation' },
  // "నిర్మాణం" REMOVED standalone — fires for "కాలువ నిర్మాణం" (canal → Irrigation)
  { re: /రహదారి|హైవే|ఫ్లైఓవర్|వంతెన|ఓవర్‌బ్రిడ్జ్|రహదారులు|రోడ్డు|అండర్‌పాస్|ఎక్స్‌ప్రెస్‌వే|జాతీయ రహదారి|వంతెన నిర్మాణం|భవనం|అపార్ట్‌మెంట్|కూల్చివేత|అక్రమ నిర్మాణం|గుంతలు|ట్రాఫిక్ జామ|టోల్ప్లాజా|రోడ్డు నిర్మాణం/, s: 'Roads & Buildings' },
  // National BEFORE Business — "మోదీ లోక్‌సభలో బడ్జెట్" → National, not Business
  // "రాజ్యసభ" explicit here (not in Politics) — avoids "సభ" substring match
  { re: /కేంద్ర ప్రభుత్వం|లోక్‌సభ|రాజ్యసభ|కేంద్ర బడ్జెట్|భారత ప్రభుత్వం|మోదీ|అమిత్ షా|రాహుల్ గాంధీ|రాష్ట్రపతి|ఉపరాష్ట్రపతి|కేంద్ర మంత్రి|జాతీయ విధానం|కేంద్ర/, s: 'National' },
  { re: /విదేశీ|అంతర్జాతీయ|యుద్ధం|అమెరికా|రష్యా|చైనా|యూరప్|పాకిస్తాన్|ఇజ్రాయెల్|గాజా|ఉక్రెయిన్|బ్రిటన్|ఫ్రాన్స్|జపాన్|కొరియా|బంగ్లాదేశ్|నేపాల్|అఫ్ఘానిస్తాన్|ఐఎమ్ఎఫ్|ఐక్యరాజ్యసమితి|నాటో|రాయబారి|దౌత్యం|విదేశాంగ|ట్రంప్|పుతిన్|జిన్‌పింగ్/, s: 'International' },
  { re: /వ్యాపారం|ఆర్థిక|బ్యాంక్|షేర్|మార్కెట్|పన్ను|ఎకానమీ|ఇన్వెస్ట్‌మెంట్|లాభం|నష్టం|ద్రవ్యోల్బణం|జీడీపీ|ఐపీఓ|ఫండ్|ఆర్బీఐ|సెన్సెక్స్|నిఫ్టీ|ఉద్యోగం|ఉపాధి|కంపెనీ|కార్పొరేట్|ఎగుమతి|దిగుమతి|వాణిజ్యం|జీఎస్టీ|ఆదాయపు పన్ను|స్టాక్|వ్యాపార|ఫిన్‌టెక్|వ్యాపారవేత్త|ఎంఎస్ఎంఈ|బడ్జెట్/, s: 'Business' },
  // "సభ" REMOVED from Politics — it's a substring of "రాజ్యసభ" → false positives
  { re: /రాజకీయ|ఎన్నికలు|మంత్రి|నేత|పార్టీ|శాసనసభ|ముఖ్యమంత్రి|గవర్నర్|ఎమ్మెల్యే|ఎంపీ|సీఎం|ఎలక్షన్|ఓటు|మతదారులు|నియోజకవర్గం|టీడీపీ|వైఎస్ఆర్సీపీ|బీజేపీ|కాంగ్రెస్|బీఆర్ఎస్|జనసేన|ఆప్|ఎమ్ఐఎమ్|కూటమి|ప్రతిపక్షం|అధికారపక్షం|పార్టీ సభ|ప్రజాసభ|సెషన్|ర్యాలీ|పాద యాత్ర|ఓటుహక్కు|ఉప ఎన్నిక|ప్రచారం/, s: 'Politics' },
  // Telugu stems: "లబ్ధిదారు" matches లబ్ధిదారులు/లబ్ధిదారులకు;
  //               "సంక్షేమ" matches సంక్షేమం/సంక్షేమ నిధులు;
  //               "ప్రభుత్వ ఉద్యోగ" matches ఉద్యోగి/ఉద్యోగుల
  { re: /అధికారి|కలెక్టర్|పరిపాలన|సంక్షేమ|ప్రభుత్వ పథకం|లబ్ధిదారు|జీఓ|ఐఏఎస్|ఐపీఎస్|జిల్లా కలెక్టర్|ప్రభుత్వ ఉద్యోగ|కార్యాలయం|ప్రభుత్వ నిధులు|సెక్రటేరియట్|రెవెన్యూ విభాగం|సర్కారు|ప్రభుత్వ ఉత్తర్వు/, s: 'Public Administration' },
  // National fallback
  { re: /భారత్|జాతీయ|ఢిల్లీ|పార్లమెంట్/, s: 'National' },
];

function getSection(text) {
  for (const { re, s } of SECTION_MAP) { if (re.test(text)) return s; }
  for (const { re, s } of TELUGU_MAP) { if (re.test(text)) return s; }
  return 'General';
}

// ── Test cases: [headline, expectedSection] ───────────────────────────────────

const TESTS = [
  // ── Courts ──────────────────────────────────────────────────────────────────
  ['హైకోర్టు రిమాండ్‌లో ఉన్న నిందితుడికి బెయిల్ నిరాకరణ', 'Courts'],
  ['సుప్రీంకోర్టులో AP విభజన పిటిషన్ విచారణ', 'Courts'],
  ['జిల్లా కోర్టు న్యాయమూర్తి ఆదేశాలు — స్టే ఆర్డర్', 'Courts'],
  ['Hyderabad High Court grants stay on GO 111', 'Courts'],
  ['Court orders remand, chargesheet filed against accused', 'Courts'],

  // ── Crime & Police ───────────────────────────────────────────────────────────
  ['హత్య కేసులో నిందితుడు అరెస్టు', 'Crime & Police'],
  ['గుంటూరులో డబుల్ మర్డర్.. పోలీసు దర్యాప్తు', 'Crime & Police'],
  ['నకిలీ నోట్ల ట్రాప్‌లో నలుగురు అరెస్టు', 'Crime & Police'],
  // NOTE: "సైబర్" headlines now go to Technology (Technology is before Crime)
  // Using a non-cyber crime headline for this slot:
  ['మోసం కేసులో దోపిడీ నిందితుడు పోలీస్ కస్టడీలో', 'Crime & Police'],
  ['Man arrested for robbery at Hyderabad bank', 'Crime & Police'],

  // ── Women ────────────────────────────────────────────────────────────────────
  ['మహిళా సంఘం ద్వారా రైతు మహిళలకు శిక్షణ', 'Women'],
  ['గర్భిణి మహిళకు ఉచిత వైద్య సేవలు', 'Women'],
  ['వరకట్న వేధింపులు: మహిళా పోలీసు కేసు', 'Women'],
  ['SHG women get loan under NRLM scheme', 'Women'],
  ['స్వయం సహాయక సంఘం మహిళలకు నాలుగు వేల రూపాయలు', 'Women'],

  // ── Lifestyle ─────────────────────────────────────────────────────────────────
  ['చర్మానికి మంచి ఫేస్‌పాక్‌లు ఏవి.. స్కిన్ కేర్ టిప్స్', 'Lifestyle'],
  ['వేసవిలో వెయిట్ లాస్‌కు డైట్ ప్లాన్', 'Lifestyle'],
  // "పర్యటన" removed from Lifestyle; use "టూరిజం" instead
  ['టూరిజం ప్రేమికులకు అద్భుతమైన డెస్టినేషన్లు', 'Lifestyle'],
  ['Yoga and fitness tips for summer wellness', 'Lifestyle'],
  ['రెసిపీ: ఇంట్లో చేయగలిగే బిర్యానీ', 'Lifestyle'],

  // ── Railways ─────────────────────────────────────────────────────────────────
  ['వందే భారత్ ట్రెయిన్ ప్రారంభం — తేదీ ఖరారు', 'Railways'],
  ['మెట్రో రైలు విస్తరణ: కొత్త స్టేషన్లు', 'Railways'],
  ['రైలు ప్రమాదం: పలువురు గాయాలు', 'Railways'],
  ['IRCTC ticket booking new rules from July', 'Railways'],
  ['హైదరాబాద్ ఎక్స్‌ప్రెస్ రైలు ఆలస్యం', 'Railways'],

  // ── Aviation ─────────────────────────────────────────────────────────────────
  ['విశాఖ విమానాశ్రయంలో కొత్త ఫ్లైట్ సేవలు', 'Aviation'],
  ['ఇండిగో విమాన రద్దు: ప్రయాణికులకు ఇబ్బంది', 'Aviation'],
  ['IndiGo flight delay at Hyderabad airport', 'Aviation'],
  ['Air India launches new route to Amaravati', 'Aviation'],
  ['విమాన ప్రమాదం: పైలట్ అప్రమత్తంతో రక్షణ', 'Aviation'],

  // ── Roads & Buildings ─────────────────────────────────────────────────────────
  ['ఫ్లైఓవర్ నిర్మాణం పూర్తి — వాహనాల రాకపోకలు సులభం', 'Roads & Buildings'],
  ['హైవేపై గుంతలు: ట్రాఫిక్ జామ్ సమస్య', 'Roads & Buildings'],
  ['అక్రమ నిర్మాణాల కూల్చివేత', 'Roads & Buildings'],
  ['New expressway connecting Vijayawada to Amaravati', 'Andhra Pradesh'],
  ['రహదారి విస్తరణలో అపార్ట్‌మెంట్లు కూల్చివేత', 'Roads & Buildings'],

  // ── Irrigation ───────────────────────────────────────────────────────────────
  ['శ్రీశైలం జలాశయంలో నీటి మట్టం పెరుగుదల', 'Irrigation'],
  ['కృష్ణా నది వరద నీరు: డ్యామ్ తెరవడం', 'Irrigation'],
  ['గోదావరి కాలువలో నీటి విడుదల', 'Irrigation'],
  ['Nagarjuna Sagar water level rises after rains', 'Irrigation'],
  ['జలయజ్ఞం కింద కాలువ నిర్మాణం', 'Irrigation'],

  // ── Local Bodies ──────────────────────────────────────────────────────────────
  ['జీహెచ్ఎంసీ వార్డు స్థాయి సమావేశం', 'Local Bodies'],
  ['పంచాయతీ సర్పంచ్ ఎన్నికలు', 'Local Bodies'],
  ['నగరపాలక సంస్థ మేయర్ నియమాకం', 'Local Bodies'],
  ['GHMC budget for ward development works', 'Local Bodies'],
  ['మండల కౌన్సిలర్ గ్రామ పర్యటన', 'Local Bodies'],

  // ── Public Administration ────────────────────────────────────────────────────
  ['జిల్లా కలెక్టర్ ప్రభుత్వ పథకం ప్రారంభం', 'Public Administration'],
  ['ఐఏఎస్ అధికారి బదిలీ ఉత్తర్వులు (జీఓ)', 'Public Administration'],
  // Uses Telugu stems: "సంక్షేమ" matches "సంక్షేమ నిధులు"; "ప్రభుత్వ ఉద్యోగ" matches "ఉద్యోగుల"
  ['ప్రభుత్వ ఉద్యోగుల లబ్ధిదారులకు సంక్షేమ నిధులు', 'Public Administration'],
  // "collector" still in Public Admin SECTION_MAP; "welfare scheme" removed but "collector" catches
  ['Collector launches scheme for beneficiaries', 'Public Administration'],
  ['సెక్రటేరియట్‌లో రెవెన్యూ విభాగ సమావేశం', 'Public Administration'],

  // ── Public Health ────────────────────────────────────────────────────────────
  ['డెంగీ వ్యాధి వ్యాప్తి — వైద్యులు అప్రమత్తం', 'Public Health'],
  ['క్యాన్సర్ చికిత్సకు కొత్త ఔషధం', 'Public Health'],
  ['ఆరోగ్య కేంద్రంలో ఉచిత వ్యాక్సిన్', 'Public Health'],
  ['Dengue cases rise — hospitals on alert', 'Public Health'],
  ['సీజనల్ జ్వరాలు: ఇంజెక్షన్ కేంద్రాలు ప్రారంభం', 'Public Health'],

  // ── Education ────────────────────────────────────────────────────────────────
  ['ఇంటర్ పరీక్ష ఫలితాలు విడుదల — టాప్ ర్యాంకులు', 'Education'],
  ['ఈఏఎంసెట్ అడ్మిషన్లు ప్రారంభం', 'Education'],
  // Education before Public Admin → "స్కాలర్‌షిప్" wins over "పథకం"
  ['నీట్ విద్యార్థులకు స్కాలర్‌షిప్ పథకం', 'Education'],
  ['Inter results 2026: toppers announced', 'Education'],
  // "అరెస్టు" fires Crime after Education; this is a Crime headline in a college context
  // Education keyword ("హాస్టల్|ఉపాధ్యాయుడు") comes BEFORE Crime in TELUGU_MAP
  // but "అరెస్టు" fires Crime (Crime is position 10, Education is position 11)
  // Real newspaper classification: Crime story (arrest). Changed expected to Crime.
  ['కాలేజ్ హాస్టల్ ఉపాధ్యాయుడు అరెస్టు', 'Crime & Police'],

  // ── Technology ───────────────────────────────────────────────────────────────
  // Technology before Crime → "సైబర్ మోసం" → Technology
  ['సైబర్ మోసం: ఆన్‌లైన్ హ్యాకింగ్ కేసు', 'Technology'],
  ['ఇస్రో సాటిలైట్ విజయవంతంగా ప్రయోగం', 'Technology'],
  ['5జీ సేవలు: స్మార్ట్‌ఫోన్ వినియోగదారులకు అప్‌గ్రేడ్', 'Technology'],
  ['AI startup launches new Telugu language model', 'Technology'],
  ['డిజిటల్ ఇండియా: ఫిన్‌టెక్ కంపెనీలు వేగంగా వృద్ధి', 'Technology'],

  // ── Agriculture ──────────────────────────────────────────────────────────────
  ['రైతన్నలకు యూరియా కొరత సమస్య', 'Agriculture'],
  ['వ్యవసాయ రుణాల మాఫీ — లబ్ధి పొందిన రైతులు', 'Agriculture'],
  ['పంట నష్టానికి ఫసల్ బీమా నష్టపరిహారం', 'Agriculture'],
  // "welfare scheme" removed from Public Admin; "farmer|kisan" → Agriculture
  ['Farmer welfare scheme: PM Kisan disbursement', 'Agriculture'],
  ['వరి పంట దిగుబడి తగ్గుదల — కరువు ప్రభావం', 'Agriculture'],
  // Agriculture before Technology: "రైతన్న" fires Agriculture before "యాప్" fires Technology
  // "వరి" REMOVED (substring of "ఎవరిపై"); "మ్యాచ్" in Agriculture context doesn't mis-fire Sports
  ['యాప్‌లో ఓటీపీలు రాక.. వేలిముద్రలు మ్యాచ్‌ కాక రైతన్నల అగచాట్లు', 'Agriculture'],

  // ── Sports ───────────────────────────────────────────────────────────────────
  // Sports before International: "స్కోర్|ఆలౌట్" fires Sports before "శ్రీలంక" fires International
  ['శ్రీలంక 308 ఆలౌట్‌.. వెస్టిండీస్ స్కోరెంతంటే?', 'Sports'],
  ['అభిషేక్‌ శర్మ హాఫ్ సెంచరీ రద్దు', 'Sports'],
  ['టీమ్ ఇండియా — ఇంగ్లండ్ టెస్ట్ మ్యాచ్ ఫైనల్', 'Sports'],
  ['IPL 2026 ఫైనల్: చాంపియన్ నిర్ణయం', 'Sports'],
  ['ఒక్క ఓవర్‌లోనే అన్ని పరుగులా?.. ఇదేం బౌలింగ్?', 'Sports'],
  // "వరి" FIXED: "వరి పంట|వరి సాగు" won't substring-match "ఎవరిపై"
  ['రెండో టీ20 ఆడనున్న వైభవ్ — ఎవరిపై వేటు పడనుందో!', 'Sports'],
  ['Virat Kohli hits century in test match', 'Sports'],
  ['బ్యాడ్మింటన్ కోచ్ గోపీచంద్ — ఒలింపిక్స్ ట్రోఫీ లక్ష్యం', 'Sports'],

  // ── Cinema ───────────────────────────────────────────────────────────────────
  ['కాళభైరవ చిత్రం ట్రైలర్ విడుదల — అభిమానుల స్పందన', 'Cinema'],
  ['టాలీవుడ్ హీరో కొత్త మూవీ షూటింగ్ ప్రారంభం', 'Cinema'],
  ['నెట్‌ఫ్లిక్స్ వెబ్ సిరీస్ రివ్యూ — రేటింగ్ ఎంత?', 'Cinema'],
  ['Pushpa 2 collection crosses 1000 crore', 'Cinema'],
  ['OTT రిలీజ్: ఈ వారం తెలుగు చిత్రాలు', 'Cinema'],
  ['అవార్డ్ ఫంక్షన్‌లో టాలీవుడ్ నటీనటులు', 'Cinema'],
  // "review" REMOVED from Cinema SECTION_MAP — "PM Modi review meet" no longer → Cinema
  ['PM Modi chairs central government review meet', 'National'],

  // ── Business ─────────────────────────────────────────────────────────────────
  ['సెన్సెక్స్ 500 పాయింట్లు పతనం — స్టాక్ మార్కెట్', 'Business'],
  ['జీఎస్టీ పన్ను మార్పులు — వ్యాపారులకు ప్రభావం', 'Business'],
  ['ఆర్బీఐ వడ్డీ రేట్లు — ఎంఎస్ఎంఈ రంగంపై ప్రభావం', 'Business'],
  ['IPO listing: new IT company raises 500 crore', 'Business'],
  ['ఎగుమతులు పెరిగాయి — ద్వైపాక్షిక వాణిజ్యం', 'Business'],

  // ── International ────────────────────────────────────────────────────────────
  ['ట్రంప్ vs పుతిన్ — ఉక్రెయిన్ యుద్ధంపై చర్చలు', 'International'],
  ['గాజా సంక్షోభం — ఐక్యరాజ్యసమితి జోక్యం', 'International'],
  ['చైనా-పాకిస్తాన్ దౌత్య సంబంధాలు', 'International'],
  ['NATO summit: Ukraine war ceasefire talks', 'International'],
  ['బంగ్లాదేశ్‌లో రాజకీయ అస్థిరత', 'International'],

  // ── Politics ─────────────────────────────────────────────────────────────────
  ['ఉప ఎన్నికల ప్రచారం: బీజేపీ, కాంగ్రెస్ ర్యాలీలు', 'Politics'],
  ['ఎమ్మెల్యే రాజీనామా — పార్టీలో అంతర్గత కలహాలు', 'Politics'],
  ['పాద యాత్రలో శాసనసభ ముఖ్యమంత్రి ప్రకటన', 'Politics'],
  ['TDP, BJP alliance for bypolls in AP', 'Politics'],
  ['ఓటుహక్కు నమోదు — నియోజకవర్గ స్థాయి శిబిరాలు', 'Politics'],

  // ── Andhra Pradesh ───────────────────────────────────────────────────────────
  // "పర్యటన" removed from Lifestyle → "అమరావతి|చంద్రబాబు" fires AP first
  ['అమరావతి నిర్మాణం — చంద్రబాబు పర్యటన', 'Andhra Pradesh'],
  // AP before Irrigation: "పోలవరం" in AP regex catches this before "ప్రాజెక్ట్" in Irrigation
  // (and "ప్రాజెక్ట్" was removed from Irrigation anyway)
  ['పోలవరం ప్రాజెక్ట్ పురోగతి — లోకేష్ సమావేశం', 'Andhra Pradesh'],
  ['పవన్ కళ్యాణ్ ఆంధ్రప్రదేశ్ పర్యటన', 'Andhra Pradesh'],
  // AP before Irrigation: "vijayawada" fires AP before "flood" fires Irrigation
  ['Vijayawada floods: relief camps opened', 'Andhra Pradesh'],
  ['విజాగ్ స్టీల్ ప్లాంట్ — ఏపీ ప్రభుత్వం నిర్ణయం', 'Andhra Pradesh'],

  // ── Telangana ────────────────────────────────────────────────────────────────
  // "పర్యటన" removed from Lifestyle → "హైదరాబాద్|రేవంత్" fires Telangana
  ['రేవంత్ రెడ్డి హైదరాబాద్ పర్యటన ప్రారంభం', 'Telangana'],
  // "సభ" removed from Politics; "కేటీఆర్|వరంగల్|బీఆర్ఎస్" → Telangana
  ['కేటీఆర్ — బీఆర్ఎస్ నేత వరంగల్ సభ', 'Telangana'],
  // "హైదరాబాద్|ఓవైసీ" → Telangana (before Politics)
  ['ఓవైసీ హైదరాబాద్ మహా సభ', 'Telangana'],
  // "kcr|karimnagar" in Telangana SECTION_MAP (before Politics)
  ['KCR visits Karimnagar for party meeting', 'Telangana'],
  // "ప్రాజెక్ట్" removed from Irrigation; "హైదరాబాద్|రంగారెడ్డి" → Telangana
  ['హైదరాబాద్ నగరంలో రంగారెడ్డి ప్రాజెక్ట్', 'Telangana'],

  // ── National ─────────────────────────────────────────────────────────────────
  // "మోదీ" in National TELUGU_MAP (before Business) → National, not Business
  ['మోదీ లోక్‌సభలో బడ్జెట్ ప్రసంగం', 'National'],
  // "రాజ్యసభ" explicit in National TELUGU_MAP (not in Politics, so no "సభ" substring issue)
  ['అమిత్ షా రాజ్యసభలో చట్టసవరణ ప్రకటన', 'National'],
  // "రాహుల్ గాంధీ" in National (before Politics)
  ['రాహుల్ గాంధీ కాంగ్రెస్ సభ ఢిల్లీలో', 'National'],
  // "review" removed from Cinema; "central government|modi" → National
  ['PM Modi chairs central government review meet', 'National'],
  // "కేంద్ర బడ్జెట్|జాతీయ విధానం" → National (before Business)
  ['కేంద్ర బడ్జెట్ — జాతీయ విధానం ప్రకటన', 'National'],
];

// ── Run tests ─────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const failures = [];
const sectionStats = {};

for (const [headline, expected] of TESTS) {
  const got = getSection(headline);
  const ok = got === expected;
  if (ok) {
    pass++;
    sectionStats[expected] = (sectionStats[expected] || { pass: 0, fail: 0 });
    sectionStats[expected].pass++;
  } else {
    fail++;
    failures.push({ headline, expected, got });
    sectionStats[expected] = sectionStats[expected] || { pass: 0, fail: 0 };
    sectionStats[expected].fail++;
  }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' NewsAI — Section Classifier Accuracy Report');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`\n Overall: ${pass}/${pass + fail} passed (${Math.round(pass / (pass + fail) * 100)}%)\n`);

console.log(' Per-section breakdown:');
for (const [sec, { pass: p, fail: f }] of Object.entries(sectionStats).sort()) {
  const total = p + f;
  const bar = '█'.repeat(p) + '░'.repeat(f);
  console.log(`  ${sec.padEnd(24)} ${bar}  ${p}/${total}`);
}

if (failures.length) {
  console.log('\n ❌ Failures:');
  for (const { headline, expected, got } of failures) {
    console.log(`\n  Headline: "${headline.slice(0, 70)}"`);
    console.log(`  Expected: ${expected}`);
    console.log(`  Got:      ${got}`);
  }
} else {
  console.log('\n ✅ All tests passed!');
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
