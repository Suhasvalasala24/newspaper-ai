/**
 * NewsAI Widget — Self-contained floating chatbot for newspaper websites.
 * Reads all branding/config from window.NewsAI.config (loaded by newsai-config-loader.js).
 * Depends on: newsai-widget.css, newsai-config-loader.js, newsai-content.js
 */
(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let currentLang = 'te';
  let conversationHistory = [];
  let isOpen = false;
  let isTyping = false;
  let chipsVisible = true;
  let isSpeaking = false;
  let currentUtterance = null;
  let speakingMsgEl = null;
  let speakGen = 0; // incremented on every startSpeaking call; stale resetBtn closures check this
  let recognition = null;
  let isListening = false;
  let voiceInputActive = false; // true when current message came from mic
  let lastArticleMeta = [];     // {url,title,imageUrl}[] from the SSE 'meta' event — drives image strip
  let _lastStreamComplete = true; // false while an SSE stream is mid-flight; set true on [DONE]
  let _restoredFromSession = false; // true when conversationHistory was restored from sessionStorage
  const MAX_HISTORY = 4;  // keep last 4 exchanges — saves ~1200+ tokens per request
  let promptCount = 0;  // increments on each user message; non-skippable ad every 3rd
  let backendBaseUrl = 'http://localhost:3001'; // overridden from config.backendUrl in init()

  // ─── Session ID (Feature: per-user prompt context memory) ────────────────
  // Stable session ID — sent with every chat request so the backend can track
  // user interests and provide better context-aware answers.
  const sessionId = (() => {
    try {
      let id = sessionStorage.getItem('newsai_session');
      if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2); sessionStorage.setItem('newsai_session', id); }
      return id;
    } catch (_) { return Math.random().toString(36).slice(2); }
  })();

  // ─── Conversation persistence (survives tab close, auto-clears tomorrow) ─────
  // sessionStorage clears on tab close; this localStorage layer keeps the last
  // few turns across sessions and auto-expires by keying on the date.
  // Date key uses IST (UTC+5:30) so history rolls at midnight IST, not UTC midnight (5:30 AM IST).
  const HISTORY_KEY = 'newsai_history_' + new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

  function saveHistory() {
    try {
      // Only save last 10 turns (5 Q+A pairs) — don't bloat storage
      const toSave = conversationHistory.slice(-10);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(toSave));
      // Clean up yesterday's key(s)
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('newsai_history_') && k !== HISTORY_KEY) localStorage.removeItem(k);
      }
    } catch (_) {}  // private browsing / storage full — silent
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return;
      const h = JSON.parse(raw);
      if (Array.isArray(h) && h.length > 0) conversationHistory = h;
    } catch (_) {}
  }

  // ─── Podcast-style continuous voice mode (Feature: hands-free conversation) ──
  let voiceMode = false;          // true = podcast mode active
  let voiceSilenceTimer = null;   // auto-submit after silence
  let voiceModeEl = null;         // the overlay DOM element
  let voiceProcessing = false;    // true while AI is thinking/speaking (blocks auto-restart)
  const VOICE_SILENCE_MS = 1500;  // 1.5s silence → auto submit
  let widgetEl = null;            // module ref to el, set in buildWidget — used by voice mode
  let widgetConfig = null;        // module ref to config, set in buildWidget

  // ─── Breaking news check (Feature: fresh-article badge on panel open) ────
  let _breakingLastChecked = 0;
  const BREAKING_CHECK_INTERVAL = 5 * 60 * 1000; // 5 min client-side debounce — avoids hammering backend

  // ─── Gemini context cache (Feature: backend caching) ─────────────────────
  let geminiCacheId     = null;  // resource name, e.g. "cachedContents/abc123"
  let geminiCacheExpiry = 0;     // epoch ms

  // ─── Daily digest cache (Feature: pre-generated digest) ──────────────────
  let dailyDigest  = { te: null, en: null };
  let todaySections = [];  // sections from today's articles — drives dynamic chips

  // Maps backend section name → chip label in each language.
  // Only sections that have a mapping here will become chips.
  const SECTION_CHIP_LABELS = {
    'Telangana':      { te: 'తెలంగాణ వార్తలు',       en: 'Telangana news' },
    'Andhra Pradesh': { te: 'ఆంధ్రప్రదేశ్‌ వార్తలు', en: 'AP news' },
    'Sports':         { te: 'క్రీడా వార్తలు',           en: 'Sports news' },
    'Cinema':         { te: 'సినిమా వార్తలు',            en: 'Cinema news' },
    'Business':       { te: 'వ్యాపార వార్తలు',           en: 'Business news' },
    'International':  { te: 'అంతర్జాతీయ వార్తలు',       en: 'World news' },
    'National':       { te: 'జాతీయ వార్తలు',             en: 'National news' },
    'Politics':       { te: 'రాజకీయ వార్తలు',            en: 'Politics news' },
    'Crime & Police': { te: 'నేర వార్తలు',                en: 'Crime news' },
  };

  // ─── Font size preference (Feature: A/A+ control) ────────────────────────
  let fontSizePref = 'normal'; // 'normal' | 'large'

  // ─── TTS voice cache ─────────────────────────────────────────────────────
  // speechSynthesis.getVoices() returns [] on first synchronous call — voices
  // load asynchronously and fire 'voiceschanged'. Pre-cache here so startSpeaking
  // always has the full voice list without needing an async gap (which breaks
  // Chrome's autoplay gesture context).
  let cachedVoices = [];
  if (window.speechSynthesis) {
    cachedVoices = speechSynthesis.getVoices();
    speechSynthesis.addEventListener('voiceschanged', () => {
      cachedVoices = speechSynthesis.getVoices();
      console.log('[NewsAI TTS] Voices loaded:', cachedVoices.length,
        '| Telugu:', cachedVoices.filter(v => v.lang.startsWith('te')).map(v => v.name).join(', ') || 'none');
    });
  }

  // ─── i18n strings ─────────────────────────────────────────────────────────
  const I18N = {
    te: {
      placeholder:   'మీ ప్రశ్న టైప్ చేయండి...',
      listening:     'వింటున్నాను...',
      error:         'సమస్య వచ్చింది. మళ్ళీ ప్రయత్నించండి.',
      offline:       'మీరు ఆఫ్‌లైన్‌లో ఉన్నారు. News AI ఉపయోగించడానికి రీకనెక్ట్ చేయండి.',
      loading:       'ఈరోజు పత్రిక లోడవుతోంది...',
      loadFail:      'ఈ రోజు పత్రిక లోడ్ అవలేదు. రిఫ్రెష్ చేయండి.',
      speakStop:     'ఆపు',
      teVoiceFallback: 'తెలుగు వాయిస్ ఈ పరికరంలో అందుబాటులో లేదు — ఆంగ్ల వాయిస్ ఉపయోగిస్తోంది.',
      online:        'ఆన్‌లైన్',
    },
    en: {
      placeholder:   'Type your question...',
      listening:     'Listening...',
      error:         'Something went wrong. Please try again.',
      offline:       'You are offline. Please reconnect to use News AI.',
      loading:       'Loading today\'s edition...',
      loadFail:      'Could not load today\'s edition. Please refresh.',
      speakStop:     'Stop',
      teVoiceFallback: 'Telugu voice not available on this device — using English voice.',
      online:        'Online',
    },
  };
  const t = (key) => (I18N[currentLang] || I18N.en)[key] || key;

  // ─── Analytics — fire-and-forget event log ────────────────────────────────
  function track(type, data) {
    try {
      fetch(backendBaseUrl + '/api/analytics', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ type, lang: currentLang, data: data || {} }),
      }).catch(() => {});   // never throw or block the UI
    } catch (_) {}
  }

  // ─── Next word suggestions ────────────────────────────────────────────────
  // Curated news-aware query list for predictive input (like a mobile keyboard bar).
  // Telugu list covers all Sakshi sections; English mirrors the same set.
  const SUGGESTIONS = {
    te: [
      'ఈ రోజు ముఖ్య వార్తలు', 'తెలంగాణ వార్తలు', 'ఆంధ్రప్రదేశ్‌ వార్తలు',
      'క్రికెట్‌ స్కోర్‌', 'సినిమా వార్తలు', 'బంగారం ధర ఎంత',
      'హైదరాబాద్‌ వార్తలు', 'రాజకీయ వార్తలు', 'జాతీయ వార్తలు',
      'అంతర్జాతీయ వార్తలు', 'వ్యాపార వార్తలు', 'టాలీవుడ్‌ వార్తలు',
      'IPL అప్‌డేట్‌', 'సినిమా రివ్యూ', 'పెట్రోల్‌ ధర',
      'పార్లమెంట్‌ వార్తలు', 'ఈ రోజు పేపర్‌ సారాంశం', 'ఉద్యోగ వార్తలు',
      'క్రీడా వార్తలు', 'కోర్టు తీర్పు', 'ఎన్నికల వార్తలు',
      'ఆరోగ్య వార్తలు', 'విద్యా వార్తలు', 'అమరావతి వార్తలు',
      'నేర వార్తలు', 'ముఖ్య అంశాలు', 'వ్యవసాయ వార్తలు',
      'చంద్రబాబు', 'రేవంత్‌ రెడ్డి', 'పవన్‌ కళ్యాణ్‌',
    ],
    en: [
      'Today\'s headlines', 'Telangana news', 'Andhra Pradesh news',
      'Cricket score', 'Cinema news', 'Gold price today',
      'Hyderabad news', 'Political news', 'National news',
      'International news', 'Business news', 'Tollywood updates',
      'IPL update', 'Movie review', 'Petrol price',
      'Parliament session', 'Full digest today', 'Job news',
      'Sports news', 'Court verdict', 'Election news',
      'Health tips', 'Education news', 'Amaravati news',
      'Crime news', 'Top stories', 'Agriculture news',
      'Chandrababu Naidu', 'Pawan Kalyan', 'Revanth Reddy',
    ],
  };

  function getSuggestions(text) {
    const list = SUGGESTIONS[currentLang] || SUGGESTIONS.en;
    if (!text || text.trim().length < 1) return list.slice(0, 4);
    const q = text.trim().toLowerCase();
    return list.filter(s => s.toLowerCase().includes(q)).slice(0, 4);
  }

  function updateSuggestions(text, el) {
    if (!el.suggestions) return;
    const suggs = getSuggestions(text);
    el.suggestions.innerHTML = suggs.map(s =>
      `<button class="newsai-suggestion" type="button">${s}</button>`
    ).join('');
    el.suggestions.classList.toggle('newsai-has-suggestions', suggs.length > 0);
    el.suggestions.querySelectorAll('.newsai-suggestion').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keep input focused, avoid blur before fill
        el.input.value = btn.textContent;
        el.send.disabled = false;
        el.suggestions.innerHTML = '';
        el.suggestions.classList.remove('newsai-has-suggestions');
        el.input.focus();
      });
    });
  }

  // ─── SVG icons ─────────────────────────────────────────────────────────────
  const ICONS = {
    robot: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="8" width="18" height="12" rx="2"/>
      <circle cx="9" cy="13" r="1.5" fill="currentColor"/>
      <circle cx="15" cy="13" r="1.5" fill="currentColor"/>
      <path d="M12 2v4M8 20v2M16 20v2"/>
      <rect x="8" y="4" width="8" height="4" rx="1"/>
    </svg>`,
    close: `<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
    send:  `<svg viewBox="0 0 24 24"><path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/></svg>`,
    mic:   `<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    speaker: `<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    speakerOff: `<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
    copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    check: `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`,
    whatsapp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  };

  // ─── Build DOM ─────────────────────────────────────────────────────────────
  function buildWidget(config) {
    // brand may be missing entirely if config loading failed — never crash the widget
    const { position, defaultLanguage } = config;
    const brand = config.brand || {};
    currentLang = defaultLanguage || 'te';

    // Restore session history + language preference
    try {
      const saved = sessionStorage.getItem('newsai_history');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Corrupted storage could hold a non-array — that would crash .push/.filter later
        if (Array.isArray(parsed) && parsed.length > 0) {
          conversationHistory = parsed;
          _restoredFromSession = true;  // triggers "Previous conversation restored" notice on first render
        }
      }
      const savedLang = sessionStorage.getItem('newsai_lang');
      if (savedLang && (savedLang === 'te' || savedLang === 'en')) currentLang = savedLang;
    } catch (_) {}

    // Note: localStorage history persistence removed — history now clears when the tab closes.
    // sessionStorage (above) keeps it alive for same-tab reloads only.

    const wrapper = document.createElement('div');
    wrapper.className = 'newsai-wrapper' + (position === 'bottom-left' ? ' newsai-pos-left' : '');
    wrapper.setAttribute('aria-label', 'News AI Chatbot');

    // Sanitise brand fields before injecting into innerHTML
    const safeName      = escHtml(brand.name || 'NewsAI').replace(/<br>/g, ' ');
    const safeShortName = escHtml(brand.shortName || (brand.name || 'N').charAt(0) || 'N').replace(/<br>/g, ' ');
    const safeNameAttr  = escAttr(brand.name || 'NewsAI');
    // Only allow http/https logo URLs to prevent javascript: injection
    const safeLogoUrl   = (brand.logoUrl && /^https?:\/\//i.test(brand.logoUrl)) ? escAttr(brand.logoUrl) : '';

    wrapper.innerHTML = `
      <!-- FAB -->
      <button class="newsai-fab" id="newsai-fab" aria-label="Open News AI assistant" title="${safeNameAttr}">
        <span class="newsai-fab-icon">${ICONS.robot}</span>
        <div class="newsai-fab-spinner"></div>
        <span class="newsai-badge" id="newsai-badge">1</span>
      </button>

      <!-- Chat Panel -->
      <div class="newsai-panel" id="newsai-panel" role="dialog" aria-label="${safeNameAttr} chat">
        <!-- Header -->
        <div class="newsai-header">
          <div class="newsai-avatar" id="newsai-avatar">
            ${safeLogoUrl
              ? `<img src="${safeLogoUrl}" alt="${safeNameAttr} logo"/>`
              : `<span>${safeShortName}</span>`}
          </div>
          <div class="newsai-header-info">
            <div class="newsai-header-name">${safeName}</div>
            <div class="newsai-header-status">
              <span class="newsai-status-dot"></span>
              <span class="newsai-status-text-online">${t('online')}</span>
              <span class="newsai-status-text-loading">${t('loading')}</span>
            </div>
          </div>
          <div class="newsai-font-controls" id="newsai-font-controls">
            <button class="newsai-font-btn" id="newsai-font-sm" aria-label="Smaller text" title="Smaller text">A</button>
            <button class="newsai-font-btn newsai-font-btn--lg" id="newsai-font-lg" aria-label="Larger text" title="Larger text">A+</button>
          </div>
          <button class="newsai-close-btn" id="newsai-close" aria-label="Close chat">${ICONS.close}</button>
        </div>

        <!-- Offline banner -->
        <div class="newsai-offline-banner" id="newsai-offline-banner">
          ${t('offline')}
        </div>

        <!-- Messages -->
        <div class="newsai-messages" id="newsai-messages" role="log" aria-live="polite" aria-label="Chat messages"></div>

        <!-- Voice notice -->
        <div class="newsai-voice-notice" id="newsai-voice-notice"></div>

        <!-- Input -->
        <div class="newsai-input-area">
          <div class="newsai-suggestions" id="newsai-suggestions"></div>
          <div class="newsai-input-row">
            <button class="newsai-mic-btn" id="newsai-mic" aria-label="Voice input" title="Voice input">
              <span class="newsai-mic-icon">${ICONS.mic}</span>
              <span class="newsai-waveform">
                <span></span><span></span><span></span><span></span><span></span>
              </span>
            </button>
            <input
              type="text"
              class="newsai-input"
              id="newsai-input"
              placeholder="${t('placeholder')}"
              autocomplete="off"
              aria-label="Message input"
              maxlength="500"
            />
            <button class="newsai-send-btn" id="newsai-send" aria-label="Send message" disabled>${ICONS.send}</button>
          </div>
          <div class="newsai-lang-row">
            <button class="newsai-lang-btn${currentLang === 'te' ? ' newsai-lang-active' : ''}" data-lang="te">తెలుగు</button>
            <button class="newsai-lang-btn${currentLang === 'en' ? ' newsai-lang-active' : ''}" data-lang="en">English</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(wrapper);

    // Cache element refs
    const $ = (id) => document.getElementById(id);
    const el = {
      fab:      $('newsai-fab'),
      panel:    $('newsai-panel'),
      close:    $('newsai-close'),
      messages: $('newsai-messages'),
      input:    $('newsai-input'),
      send:     $('newsai-send'),
      mic:      $('newsai-mic'),
      badge:    $('newsai-badge'),
      offline:     $('newsai-offline-banner'),
      notice:      $('newsai-voice-notice'),
      suggestions: $('newsai-suggestions'),
      fontSm:   $('newsai-font-sm'),
      fontLg:   $('newsai-font-lg'),
    };

    // ── Font size control ─────────────────────────────────────────────────────
    try {
      const saved = localStorage.getItem('newsai_fontsize');
      if (saved === 'large') { fontSizePref = 'large'; wrapper.classList.add('newsai-font-large'); }
      else if (saved === 'small') { fontSizePref = 'small'; wrapper.classList.add('newsai-font-small'); }
    } catch (_) {}

    if (el.fontSm) {
      el.fontSm.addEventListener('click', () => {
        wrapper.classList.remove('newsai-font-large');
        wrapper.classList.add('newsai-font-small');
        fontSizePref = 'small';
        try { localStorage.setItem('newsai_fontsize', 'small'); } catch (_) {}
      });
    }
    if (el.fontLg) {
      el.fontLg.addEventListener('click', () => {
        wrapper.classList.remove('newsai-font-small');
        wrapper.classList.add('newsai-font-large');
        fontSizePref = 'large';
        try { localStorage.setItem('newsai_fontsize', 'large'); } catch (_) {}
      });
    }

    // ── Wire events ──────────────────────────────────────────────────────────
    el.fab.addEventListener('click', () => isOpen ? closePanel(el) : openPanel(el, config));
    el.close.addEventListener('click', () => closePanel(el));
    el.send.addEventListener('click', () => submitMessage(el, config));
    el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitMessage(el, config); } });
    el.input.addEventListener('input', () => {
      el.send.disabled = !el.input.value.trim();
      updateSuggestions(el.input.value, el);
    });
    el.input.addEventListener('focus', () => updateSuggestions(el.input.value, el));
    el.input.addEventListener('blur',  () => {
      // 200ms delay so mousedown on a suggestion fires before we clear
      setTimeout(() => {
        if (el.suggestions) {
          el.suggestions.innerHTML = '';
          el.suggestions.classList.remove('newsai-has-suggestions');
        }
      }, 200);
    });

    // Language toggle
    wrapper.querySelectorAll('.newsai-lang-btn').forEach(btn => {
      btn.addEventListener('click', () => switchLang(btn.dataset.lang, el, wrapper, config));
    });

    // Offline/online detection
    window.addEventListener('offline', () => { wrapper.classList.add('newsai-offline'); el.offline.textContent = t('offline'); });
    window.addEventListener('online',  () => wrapper.classList.remove('newsai-offline'));
    if (!navigator.onLine) wrapper.classList.add('newsai-offline');

    // Init voice
    initVoice(el);

    // Expose refs for podcast voice mode (needs el + config outside this scope)
    widgetEl = el;
    widgetConfig = config;

    return el;
  }

  // ─── Breaking news badge ────────────────────────────────────────────────────
  // Fetches /api/articles/today and injects a "🔴 Breaking" chip above the
  // suggestion chips if any article was ingested in the last 10 minutes.
  // A 5-min client-side debounce prevents hammering the backend on repeated opens.
  function checkBreakingNews(el) {
    const now = Date.now();
    if (now - _breakingLastChecked < BREAKING_CHECK_INTERVAL) return;
    _breakingLastChecked = now;

    // Use the lightweight breaking-count endpoint (not /api/articles/today) — it
    // returns only counts + addedAt, avoiding downloading all article bodies/images.
    fetch(backendBaseUrl + '/api/articles/breaking-count', { signal: AbortSignal.timeout(4000) })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || typeof data.count !== 'number') return;
        const breaking = data.articles || [];
        if (breaking.length === 0) return;

        // Find the chips container inside the welcome message
        const chipsEl = el.messages.querySelector('#newsai-chips');
        if (!chipsEl) return;
        // Don't inject twice
        if (chipsEl.previousElementSibling &&
            chipsEl.previousElementSibling.classList.contains('newsai-breaking-banner')) return;

        const count = breaking.length;
        const label = currentLang === 'te'
          ? '🔴 ' + count + ' తాజా వార్త' + (count === 1 ? '' : 'లు') + ' వచ్చాయి'
          : '🔴 ' + count + ' breaking ' + (count === 1 ? 'story' : 'stories') + ' just in';

        const banner = document.createElement('button');
        banner.className = 'newsai-breaking-banner newsai-chip';
        banner.textContent = label;
        banner.addEventListener('click', function() {
          el.input.value = currentLang === 'te' ? 'తాజా బ్రేకింగ్ న్యూస్ ఏమిటి?' : 'What are the latest breaking news?';
          el.send.disabled = false;
          submitMessage(el, widgetConfig);
        });
        chipsEl.parentNode.insertBefore(banner, chipsEl);
      })
      .catch(function() {});
  }

  // ─── Panel open/close ──────────────────────────────────────────────────────
  function openPanel(el, config) {
    isOpen = true;
    el.panel.classList.add('newsai-open');
    el.badge.classList.add('newsai-hidden');
    track('open');

    // Fetch dynamic chips in background — update SUGGESTIONS if available
    fetch(backendBaseUrl + '/api/chips', { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Array.isArray(data.te) && data.te.length > 0) {
          SUGGESTIONS.te = data.te;
          SUGGESTIONS.en = data.en && data.en.length > 0 ? data.en : SUGGESTIONS.en;
        }
      })
      .catch(() => {});

    // Render welcome or restore session — only into an EMPTY container.
    // The messages live in the DOM across close/reopen; re-rendering on every
    // open duplicated the welcome card / entire history each time.
    if (el.messages.children.length === 0) {
      if (conversationHistory.length === 0) {
        renderWelcome(el, config);
      } else {
        restoreMessages(el, conversationHistory);
      }
    }
    // Check for fresh articles and inject a breaking news badge if found
    checkBreakingNews(el);
    setTimeout(() => el.input.focus(), 300);
  }

  function closePanel(el) {
    isOpen = false;
    el.panel.classList.remove('newsai-open');
    stopSpeaking();
  }

  // ─── Welcome message ────────────────────────────────────────────────────────
  function renderWelcome(el, config) {
    const { brand } = config;
    const welcome = currentLang === 'te' ? brand.welcomeMessage : brand.welcomeMessageEn;
    const chips = _buildChips(todaySections);

    const sampleCards = currentLang === 'te'
      ? [
          { section: 'తెలంగాణ',  headline: 'ఈ రోజు వార్తలు లోడవుతున్నాయి...' },
          { section: 'క్రీడలు',   headline: 'తాజా క్రీడా వార్తలు లోడవుతున్నాయి...' },
          { section: 'సినిమా',   headline: 'సినిమా అప్‌డేట్‌లు లోడవుతున్నాయి...' },
        ]
      : [
          { section: 'National', headline: 'Today\'s top stories loading...' },
          { section: 'Sports',   headline: 'Latest sports updates loading...' },
          { section: 'Cinema',   headline: 'Entertainment news loading...' },
        ];

    // Section navigation strip — links to newspaper's section pages (from config.sectionUrls)
    // Validate each URL is http/https (blocks javascript: and data: injection)
    const sectionNavHtml = (config.sectionUrls && Object.keys(config.sectionUrls).length)
      ? '<div class="newsai-section-nav">' +
        Object.entries(config.sectionUrls).slice(0, 10)
          .filter(([, url]) => /^https?:\/\//i.test(url))
          .map(([name, url]) =>
            '<a href="' + escAttr(url) + '" target="_blank" rel="noopener" class="newsai-section-link">' +
            escHtml(name).replace(/<br>/g, ' ') + '</a>'
          ).join('') +
        '</div>'
      : '';

    // Pre-generated digest — shown expanded immediately if ready; loading slot otherwise
    const digestText = dailyDigest[currentLang] || null;
    const digestLabel = currentLang === 'te' ? '📰 ఈ రోజు ముఖ్యాంశాలు' : '📰 Today\'s Highlights';
    const digestHtml = digestText
      ? `<div class="newsai-digest-content">
          <div class="newsai-digest-label">${digestLabel}</div>
          ${renderBotText(digestText)}
        </div>`
      : `<div id="newsai-digest-slot" class="newsai-digest-slot">
          <div class="newsai-digest-label">${digestLabel}</div>
          <span class="newsai-digest-loading-text">${currentLang === 'te' ? 'లోడవుతోంది…' : 'Loading today\'s highlights…'}</span>
        </div>`;

    const msgEl = document.createElement('div');
    msgEl.className = 'newsai-msg newsai-msg-bot';
    msgEl.innerHTML = `
      <div class="newsai-bubble">
        ${escHtml(welcome)}
        ${digestHtml}
        ${!digestText ? `<div class="newsai-news-cards">
          ${sampleCards.map(c => `
            <div class="newsai-news-card">
              <div class="newsai-news-card-section">${c.section}</div>
              <div class="newsai-news-card-headline">${c.headline}</div>
            </div>`).join('')}
        </div>` : ''}
        <div class="newsai-chips" id="newsai-chips">
          ${chips.map(c => `<button class="newsai-chip">${c}</button>`).join('')}
        </div>
        ${sectionNavHtml}
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        ${makeSpeakBtn(welcome)}
        ${makeShareBtn(welcome)}
        <button class="newsai-copy-btn" data-text="${escAttr(digestText || welcome)}" title="Copy" aria-label="Copy message">${ICONS.copy}</button>
        <span class="newsai-msg-time">${timeStr()}</span>
      </div>
    `;
    el.messages.appendChild(msgEl);
    wireCopy(msgEl);
    wireShare(msgEl);

    // Wire chips
    msgEl.querySelectorAll('.newsai-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        el.input.value = _chipQuery(chip.textContent);
        el.send.disabled = false;
        submitMessage(el, config);
      });
    });

    wireSpeak(msgEl);

    // Pre-warm disabled: Sarvam free credits exhausted — re-enable when credits replenished.
    // prewarmTts(welcome, currentLang);
  }

  // ─── Inject digest into welcome slot once async pre-fetch resolves ──────────
  function _injectDigest(text) {
    if (!text) return;
    const slot = document.getElementById('newsai-digest-slot');
    if (!slot) return;  // panel not open yet — renderWelcome will use dailyDigest directly next time
    const bubble = slot.closest('.newsai-bubble');
    if (bubble) {
      const cards = bubble.querySelector('.newsai-news-cards');
      if (cards) cards.remove();  // remove loading placeholder cards
    }
    const label = currentLang === 'te' ? '📰 ఈ రోజు ముఖ్యాంశాలు' : '📰 Today\'s Highlights';
    slot.outerHTML =
      `<div class="newsai-digest-content">
        <div class="newsai-digest-label">${label}</div>
        ${renderBotText(text)}
      </div>`;
  }

  // ─── Resolve a chip label to the actual query text sent to the AI ───────────
  // Chip buttons show display labels like "More news →" — sending that verbatim
  // to the AI is meaningless. Strip the trailing arrow and map the "More news"
  // chip to a real headline request.
  function _chipQuery(label) {
    const clean = (label || '').replace(/\s*→\s*$/, '').trim();
    if (clean === 'More news' || clean === 'ఇంకా వార్తలు') {
      return currentLang === 'te' ? 'ఈ రోజు మరిన్ని వార్తలు చూపించు' : 'Show me more headlines';
    }
    return clean;
  }

  // ─── Build chip list from today's sections (or hardcoded fallback) ──────────
  function _buildChips(sections) {
    const firstChip = currentLang === 'te' ? 'ఈ రోజు ముఖ్య వార్తలు' : 'Top headlines today';
    const moreChip  = currentLang === 'te' ? 'ఇంకా వార్తలు →' : 'More news →';
    const fallback  = currentLang === 'te'
      ? [firstChip, 'క్రికెట్‌ స్కోర్‌', 'సినిమా వార్తలు', 'తెలంగాణ వార్తలు', 'ఆంధ్రప్రదేశ్‌ వార్తలు', moreChip]
      : [firstChip, 'Cricket score', 'Cinema news', 'Telangana news', 'AP news', moreChip];

    if (!sections || !sections.length) return fallback;

    const sectionChips = sections
      .filter(s => s && SECTION_CHIP_LABELS[s])
      .slice(0, 4)
      .map(s => SECTION_CHIP_LABELS[s][currentLang]);

    return sectionChips.length
      ? [firstChip, ...sectionChips, moreChip]
      : fallback;
  }

  // ─── Inject section chips into welcome once sections arrive from digest ──────
  function _injectSectionChips(sections) {
    const chipsEl = document.getElementById('newsai-chips');
    if (!chipsEl || chipsEl.classList.contains('newsai-chips-hidden')) return;
    const newChips = _buildChips(sections);
    chipsEl.innerHTML = newChips.map(c => `<button class="newsai-chip">${c}</button>`).join('');
    chipsEl.querySelectorAll('.newsai-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const inp  = document.getElementById('newsai-input');
        const send = document.getElementById('newsai-send');
        if (inp)  { inp.value = _chipQuery(chip.textContent); inp.dispatchEvent(new Event('input')); }
        if (send) { send.disabled = false; send.click(); }
      });
    });
  }

  // ─── Restore session messages ────────────────────────────────────────────────
  function restoreMessages(el, history) {
    history.forEach(msg => {
      // restored=true: appendMessage never auto-plays TTS (only submitMessage does), so this
      // simply re-renders past turns silently — user messages plain, assistant via renderBotText.
      appendMessage(el.messages, msg.role === 'user' ? 'user' : 'bot', msg.content, false);
    });
    scrollToBottom(el.messages);
    // Subtle, auto-dismissing notice that the previous conversation was recovered
    if (_restoredFromSession) {
      _restoredFromSession = false;
      showRestoreNotice(el.messages);
    }
  }

  // Small italic notice at the top of the chat; fades itself out after 3 seconds.
  function showRestoreNotice(container) {
    const notice = document.createElement('div');
    notice.className = 'newsai-restore-notice';
    notice.textContent = currentLang === 'te'
      ? '↩ మునుపటి సంభాషణ పునరుద్ధరించబడింది'
      : '↩ Previous conversation restored';
    container.insertBefore(notice, container.firstChild);
    setTimeout(() => { try { notice.remove(); } catch (_) {} }, 3000);
  }

  // ─── Append a message bubble ─────────────────────────────────────────────────
  function appendMessage(container, role, text, scroll = true) {
    const msgEl = document.createElement('div');
    msgEl.className = `newsai-msg newsai-msg-${role}`;

    if (role === 'bot') {
      msgEl.innerHTML =
        '<div class="newsai-bubble">' + renderBotText(text) + '</div>' +
        '<div style="display:flex;align-items:center;gap:4px">' +
          makeSpeakBtn(text) +
          makeShareBtn(text) +
          '<button class="newsai-copy-btn" data-text="' + escAttr(text) + '" title="Copy" aria-label="Copy message">' + ICONS.copy + '</button>' +
          '<span class="newsai-msg-time">' + timeStr() + '</span>' +
        '</div>';
      wireSpeak(msgEl);
      wireShare(msgEl);
      wireCopy(msgEl);
    } else {
      msgEl.innerHTML = `
        <div class="newsai-bubble">${escHtml(text)}</div>
        <span class="newsai-msg-time">${timeStr()}</span>
      `;
    }

    container.appendChild(msgEl);
    if (scroll) {
      if (role === 'bot') {
        // Scroll so the TOP of the new message is visible — user reads from the start
        requestAnimationFrame(() => { msgEl.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
      } else {
        scrollToBottom(container);
      }
    }
    return msgEl;
  }

  // ─── Typing indicator ────────────────────────────────────────────────────────
  function showTyping(container) {
    const el = document.createElement('div');
    el.className = 'newsai-msg newsai-msg-bot';
    el.id = 'newsai-typing';
    el.innerHTML = `<div class="newsai-thinking-bubble"><div class="newsai-typing-dots"><span></span><span></span><span></span></div></div>`;
    container.appendChild(el);
    scrollToBottom(container);
    return el;
  }

  function hideTyping() {
    const el = document.getElementById('newsai-typing');
    if (el) el.remove();
  }

  /** Update the text shown inside the typing indicator bubble (for countdown). */
  function updateTypingStatus(text) {
    const el = document.getElementById('newsai-typing');
    if (!el) return;
    if (text) {
      el.innerHTML = `<div class="newsai-typing-status">${text}</div>`;
    } else {
      el.innerHTML = `<div class="newsai-thinking-bubble"><div class="newsai-typing-dots"><span></span><span></span><span></span></div></div>`;
    }
  }

  /** Tick-by-tick countdown shown in the typing bubble, then reset to spinner. */
  async function countdownWait(seconds) {
    for (let remaining = seconds; remaining > 0; remaining--) {
      updateTypingStatus(currentLang === 'te'
        ? `⏳ ${remaining}s తర్వాత రీట్రై...`
        : `⏳ Rate limited — retrying in ${remaining}s...`);
      await new Promise(r => setTimeout(r, 1000));
    }
    updateTypingStatus(''); // back to spinner
  }

  // ─── Non-skippable ad overlay ─────────────────────────────────────────────
  function ensureAdStyles() {
    if (document.getElementById('newsai-ad-styles')) return;
    const s = document.createElement('style');
    s.id = 'newsai-ad-styles';
    s.textContent = `
      .newsai-ad-overlay{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
      .newsai-ad-panel{background:#fff;border-radius:14px;overflow:hidden;width:320px;max-width:90vw;box-shadow:0 24px 64px rgba(0,0,0,.5)}
      .newsai-ad-hdr{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#f5f5f5;border-bottom:1px solid #eee}
      .newsai-ad-lbl{font-size:11px;color:#888;font-weight:600;letter-spacing:.4px;text-transform:uppercase}
      .newsai-ad-timer{font-size:13px;font-weight:700;color:#C0392B;background:#fdecea;padding:2px 8px;border-radius:10px}
      .newsai-ad-body{padding:24px 20px;min-height:160px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:#fff}
      .newsai-ad-icon{font-size:42px;margin-bottom:10px}
      .newsai-ad-title{font-size:16px;font-weight:700;color:#111;margin-bottom:6px}
      .newsai-ad-sub{font-size:12px;color:#888;line-height:1.5}
      .newsai-ad-foot{padding:12px 16px;border-top:1px solid #eee;display:flex;justify-content:flex-end}
      .newsai-ad-skip{padding:8px 18px;border-radius:20px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s}
      .newsai-ad-skip:disabled{background:#eee;color:#bbb;cursor:not-allowed}
      .newsai-ad-skip:not(:disabled){background:#C0392B;color:#fff;cursor:pointer}
    `;
    document.head.appendChild(s);
  }

  function showAdOverlay(config) {
    return new Promise(resolve => {
      ensureAdStyles();
      const brand = (config && config.brand) || {};
      // Sanitise: only allow plain CSS colour values (#hex or rgb()), escape brand name
      const rawColor = brand.primaryColor || '#C0392B';
      const safeColor = /^#[0-9a-fA-F]{3,8}$|^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$|^[a-zA-Z]{2,30}$/.test(rawColor)
        ? rawColor : '#C0392B';
      const safeBrandName = escHtml(brand.name || 'NewsAI').replace(/<br>/g, ' ');

      const overlay = document.createElement('div');
      overlay.className = 'newsai-ad-overlay';
      overlay.innerHTML = `
        <div class="newsai-ad-panel">
          <div class="newsai-ad-hdr">
            <span class="newsai-ad-lbl">Advertisement</span>
            <span class="newsai-ad-timer" id="newsai-ad-timer-el">10</span>
          </div>
          <div class="newsai-ad-body">
            <div class="newsai-ad-icon">📰</div>
            <div class="newsai-ad-title" style="color:${safeColor}">${safeBrandName}</div>
            <div class="newsai-ad-sub">${currentLang === 'en' ? 'Premium news, in-depth analysis<br>Subscribe for an AD-free experience' : 'Premium వార్తలు, లోతైన విశ్లేషణ<br>Subscribe చేసుకోండి — AD-free అనుభవం పొందండి'}</div>
          </div>
          <div class="newsai-ad-foot">
            <button class="newsai-ad-skip" id="newsai-ad-skip-btn" disabled>Skip in 10s</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const timerEl = overlay.querySelector('#newsai-ad-timer-el');
      const skipBtn = overlay.querySelector('#newsai-ad-skip-btn');
      let t = 10;
      let iv = null;

      let maxTimer;  // declared here so cleanup() can clear it
      const cleanup = () => {
        clearInterval(iv);
        clearTimeout(maxTimer);  // prevent dangling 15s timer after skip
        if (overlay.parentNode) overlay.remove();
      };

      iv = setInterval(() => {
        t--;
        if (timerEl) timerEl.textContent = t;
        if (skipBtn) skipBtn.textContent = t > 0 ? `Skip in ${t}s` : 'Skip Ad ✕';
        if (t <= 0) {
          clearInterval(iv);
          if (skipBtn) skipBtn.disabled = false;
        }
      }, 1000);

      skipBtn.addEventListener('click', () => {
        if (!skipBtn.disabled) { cleanup(); resolve(); }
      });

      // Safety valve: auto-dismiss after 15s even if skip fails (e.g., page hidden)
      maxTimer = setTimeout(() => { cleanup(); resolve(); }, 15000);
    });
  }

  // ─── Auto-language detection ──────────────────────────────────────────────
  // If the user types in Telugu script but the pill is set to English (or vice
  // If the user types in Telugu script while the pill is on English, auto-switch
  // to Telugu for this query only (restores after). Never switch away from Telugu
  // — users on the Telugu pill often type in English (no Telugu keyboard in Chrome)
  // and still expect a Telugu response.
  // Telugu chars are in Unicode range U+0C00–U+0C7F.
  function detectQueryLang(text) {
    const teluguChars = (text.match(/[ఀ-౿]/g) || []).length;
    const totalChars  = text.replace(/\s/g, '').length || 1;
    const teluguRatio = teluguChars / totalChars;
    // Only auto-upgrade English pill → Telugu when user clearly typed Telugu script
    if (teluguRatio > 0.25 && currentLang === 'en') return 'te';
    // Never downgrade: if pill is 'te', always respond in Telugu even for English queries
    return currentLang;
  }

  // ─── TTS text preparation ─────────────────────────────────────────────────
  // The DISPLAY path (renderBotText) strips internal markers, headline echoes,
  // and auto-bolds. The TTS path historically received the RAW Gemini text and
  // spoke ALL of it — including cross-contaminated bodies, photo-gallery article
  // lines, and the UI closing prompt. prepareForTTS() performs the equivalent
  // sanitisation for spoken output. Applied EVERYWHERE text reaches Sarvam TTS
  // or the Web Speech API (startSpeaking + feedLiveTts).
  function prepareForTTS(text) {
    if (!text) return '';
    let out = String(text);

    // 1. Strip **bold** / *italic* markdown markers (keep inner text)
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/\*([^*\n]+)\*/g, '$1');

    // 1a. Drop horizontal-rule / separator lines BEFORE the dash→period conversion below.
    // ORDER IS CRITICAL: a line like "———" or "---" hit rule 1b first, turning each dash
    // into its own ". " — the resulting ". . . " was then read aloud by Sarvam as
    // "dot dot dot" at the head of the response. Stripping the line first removes the
    // source entirely. (The old step 5c ran too late to ever match.)
    out = out.replace(/^[ \t]*[-—–_=~]{2,}[ \t]*$/gm, '');

    // 1b. Convert list-format separators to spoken pauses.
    // Em dash (—) and en dash (–) are used as the article list separator in the AI response.
    // When Sarvam reads "Headline — description" it sounds like "Headline dash description".
    // Replacing with ". " makes it sound like two natural sentences instead.
    // ASCII hyphens in proper nouns (e.g. "BJP-led") are NOT affected (they have no spaces).
    out = out.replace(/\s*[—–]\s*/g, '. ');

    // 1c. Normalise dot sequences that Sarvam vocalises instead of pausing on.
    //   • "…" (U+2026) is ONE character — `\.{2,}` never matched it, and Sarvam
    //     expands it to three spoken dots.
    //   • ". . ." — isolated punctuation separated by spaces (left over from 1b when a
    //     dash was used as a bullet) is read mark-by-mark.
    out = out
      .replace(/[…⋯᠁]/g, ',')
      .replace(/\.{2,}/g, ',')
      .replace(/(?:[.,;:]\s+){2,}[.,;:]?\s*/g, '. ');

    // 2. Strip internal content markers Gemini occasionally echoes
    out = out
      .replace(/\[HEADLINE ONLY[^\]]*\]/gi, '')
      .replace(/ ?[—–] ?\(same as headline[^)]*\)/gi, '')
      .replace(/\(same as headline[^)]*\)/gi, '')
      .replace(/ ?[—–] ?\(not available\)/gi, '')
      .replace(/\(not available\)/gi, '');

    // 3. Strip exact headline echo "Headline — Headline" (normalized match) —
    //    same logic as renderBotText: Gemini repeats the headline as its own body.
    const norm = s => s
      .replace(/[\u200B-\u200F\u00AD\uFEFF\u2028\u2029]/g, '')
      .replace(/[.!?…]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    out = out.replace(/^(.+?)\s*[—–]\s*(.+)$/gm, (m, head, desc) =>
      norm(desc) === norm(head) ? head.trim() : m);

    // 4. Drop photo-gallery article lines entirely — never speak them aloud
    const galleryLine = /ఫోటోలు|ఫొటోలు|\(photos?\)|photo gallery|gallery|ఫోటో గ్యాలరీ|గ్యాలరీ/i;
    out = out.split('\n').filter(line => !galleryLine.test(line)).join('\n');

    // 5. Strip the UI closing-prompt line — interface text, not news content
    out = out
      .replace(/^.*ఏ వార్త పూర్తి వివరాలు కావాలో అడగండి.*$/gm, '')
      // Second Telugu closing-prompt variant Gemini emits ("…మరింత తెలుసుకోవాలంటే అడగండి").
      // Matched both as a whole line and as a trailing tail of the last line, because it
      // is often appended to the final news sentence rather than placed on its own line.
      .replace(/^.*ఏ వార్త గురించి మరింత తెలుసుకోవాలంటే అడగండి.*$/gm, '')
      .replace(/ఏ వార్త గురించి మరింత తెలుసుకోవాలంటే అడగండి\.?\s*$/u, '')
      .replace(/^.*Ask me which story you would like the full details for.*$/gim, '');

    // 5b. Strip emoji-only section header lines (e.g. "🏏 Sports", "🎬 Cinema", "📰 National")
    out = out.replace(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*\S{1,20}$/gmu, '');

    // 5c. (Separator lines are now stripped in step 1a — see the ORDER note there.)

    // 6. Collapse stray/blank lines: trailing spaces + 3+ newlines → single blank
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    // 7. Never let the spoken text OPEN with punctuation. Sarvam reads a leading
    //    "." as "dot" and a leading "—" as "dash" before the first real word.
    out = out.replace(/^[\s.,;:!?।॥…·•*_=~\-–—]+/, '');

    return out;
  }

  // ─── TTS cache pre-warm (fire-and-forget) ───────────────────────────────────
  // Called on widget open with the opening/welcome text. Warms the backend Sarvam
  // TTS cache so the first speaker tap plays instantly. Best-effort ONLY: never
  // blocks, never throws, never touches the UI.
  // NOTE (divergence from spec): this codebase has no `window.NewsAI._config`; the
  // real "Sarvam available?" signal is `backendTtsAvailable` and the endpoint is
  // `backendBaseUrl + '/api/tts/stream'` (widget embeds on remote domains).
  const _prewarmedTts = new Set();   // dedupe by lang+text so reopens don't re-fire
  function prewarmTts(text, lang) {
    try {
      if (!text || typeof window === 'undefined') return;
      // Only pre-warm when the Sarvam backend hasn't been marked unavailable
      // (i.e. we're not stuck on the Web Speech fallback tier).
      if (typeof backendTtsAvailable !== 'undefined' && backendTtsAvailable === false) return;
      const prepared = prepareForTTS(text);
      if (!prepared || prepared.length < 10) return;
      const key = (lang || '') + ':' + prepared;
      if (_prewarmedTts.has(key)) return;   // already warmed this session
      _prewarmedTts.add(key);
      // Fire-and-forget: backend caches the synthesised audio. We don't play it.
      const _prewarmVoice = (widgetConfig && widgetConfig.ttsVoice) || undefined;
      fetch(backendBaseUrl + '/api/tts/stream', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: prepared, lang: lang === 'en' ? 'en' : 'te', voice: _prewarmVoice }),
      }).catch(function () {});   // intentionally ignore errors — best-effort only
    } catch (_) { /* never let pre-warm affect the UI */ }
  }

  // ─── Live TTS — sentence queue ────────────────────────────────────────────
  // Fired during Gemini streaming: each time a sentence boundary is detected
  // in the accumulating response, the completed sentence is enqueued for backend
  // TTS synthesis immediately — user hears audio ~1s after the first sentence
  // streams in, instead of waiting for [DONE] (~3-5s).
  let liveTtsSentBuf  = '';  // accumulates streamed tokens looking for sentence ends
  let liveTtsQueue    = [];  // sentences waiting to be synthesised
  let liveTtsPlaying  = false;
  let liveTtsGen      = 0;   // stamp to cancel stale queues on new message

  const TE_SENT_END = /[।॥!?.]+\s/;  // Telugu/English sentence boundary

  // Live TTS uses browser Web Speech Synthesis directly — zero HTTP round-trip,
  // starts within ~100ms of the first sentence completing. Sarvam quality TTS
  // is still available when the user taps the speaker button on the full response.
  async function drainLiveTts(myGen, lang) {
    if (liveTtsPlaying || liveTtsGen !== myGen) return;
    if (!window.speechSynthesis) return;  // browser doesn't support speech
    liveTtsPlaying = true;

    while (liveTtsQueue.length > 0 && liveTtsGen === myGen) {
      const sentence = liveTtsQueue.shift();
      if (!sentence || !sentence.trim()) continue;

      await new Promise((resolve) => {
        const utterance = new SpeechSynthesisUtterance(sentence);
        utterance.lang  = lang === 'te' ? 'te-IN' : 'en-IN';
        utterance.rate  = 1.05;  // natural news-anchor pace
        // Prefer a cached Telugu/English voice if available
        const preferred = cachedVoices.find(v => v.lang === utterance.lang)
                       || cachedVoices.find(v => v.lang.startsWith(lang === 'te' ? 'te' : 'en'));
        if (preferred) utterance.voice = preferred;
        utterance.onend   = resolve;
        utterance.onerror = resolve;
        // Abort if: gen changed (new message), voice mode exited, or isSpeaking from explicit tap
        if (liveTtsGen !== myGen || isSpeaking) { resolve(); return; }
        window.speechSynthesis.speak(utterance);
      });

      // Small gap between sentences for natural pacing
      if (liveTtsQueue.length > 0 && liveTtsGen === myGen) {
        await new Promise(r => setTimeout(r, 80));
      }
    }
    liveTtsPlaying = false;
  }

  function feedLiveTts(token, myGen, lang) {
    if (liveTtsGen !== myGen) return;
    liveTtsSentBuf += token;
    // Detect sentence boundary: sentence end punctuation followed by space
    const match = liveTtsSentBuf.match(TE_SENT_END);
    if (match) {
      const idx      = liveTtsSentBuf.indexOf(match[0]) + match[0].length;
      const sentence = liveTtsSentBuf.slice(0, idx).trim();
      liveTtsSentBuf = liveTtsSentBuf.slice(idx);
      const spoken = prepareForTTS(sentence);   // strip markup, gallery lines, echoes
      if (spoken && spoken.trim().length > 20) {   // skip gallery/empty/short fragments
        liveTtsQueue.push(spoken.trim());
        drainLiveTts(myGen, lang);
      }
    }
  }

  // ─── Submit message ────────────────────────────────────────────────────────
  async function submitMessage(el, config) {
    const text = el.input.value.trim();
    if (!text || isTyping) return;

    // Auto-detect script: if user typed in Telugu but lang pill is English (or vice
    // versa), switch lang for this query only — does not change the toggle state.
    const queryLang = detectQueryLang(text);
    if (queryLang !== currentLang) {
      console.log(`[NewsAI] Auto-lang: Telugu detected in English-pill query — switching to te for this query`);
    }

    // Hide chips after first real message
    if (chipsVisible) {
      const chips = document.getElementById('newsai-chips');
      if (chips) chips.classList.add('newsai-chips-hidden');
      chipsVisible = false;
    }

    el.input.value = '';
    el.send.disabled = true;
    track('query', { query: text.slice(0, 100) });

    // ── Detect section for post-response redirect button ──────────────────────
    const _topicForRedirect = detectAndFilterTopic(text, null);
    if (window.NewsAI) window.NewsAI._lastSection = _topicForRedirect ? _topicForRedirect.section : null;

    // ── Non-skippable ad every 3rd prompt (skipped in hands-free voice mode) ──
    promptCount++;
    if (promptCount % 3 === 0 && !voiceMode) {
      await showAdOverlay(config);
    }

    appendMessage(el.messages, 'user', text);
    conversationHistory.push({ role: 'user', content: text });
    trimHistory();
    saveSession();

    isTyping = true;
    showTyping(el.messages);

    // Override config lang for this query if auto-detect fired
    const savedLang = currentLang;
    if (queryLang !== currentLang) currentLang = queryLang;

    try {
      // ── Streaming: create bot bubble upfront, fill as tokens arrive ─────────
      let streamedEl   = null;
      let streamedBubble = null;
      let fullReply    = '';

      lastArticleMeta = [];  // reset per-message; repopulated by the SSE 'meta' event

      // Set up live TTS state for this message
      liveTtsSentBuf = '';
      liveTtsQueue   = [];
      liveTtsPlaying = false;
      const myLiveTtsGen = ++liveTtsGen;
      // Live TTS only fires when the user has voice input active (voiceMode or voiceInputActive)
      // so it doesn't surprise users who just want to read the response.
      const doLiveTts = voiceMode || voiceInputActive;

      config._onStream = (token) => {
        if (!streamedEl) {
          hideTyping();
          streamedEl     = appendMessage(el.messages, 'bot', '');
          streamedBubble = streamedEl.querySelector('.newsai-bubble');
        }
        fullReply += token;
        if (streamedBubble) {
          // Strip content markers from live display (mirrors renderBotText on final render)
          const _normEcho = s => s.replace(/[\u200B-\u200F\u00AD\uFEFF\u2028\u2029]/g, '').replace(/[.!?\u2026]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
          const displayText = fullReply
            .replace(/ ?[—–] ?\(same as headline[^)]*\)/gi, '')
            .replace(/\(same as headline[^)]*\)/gi, '')
            .replace(/ ?[—–] ?\(not available\)/gi, '')
            .replace(/\(not available\)/gi, '')
            // Strip Gemini headline echo: **X** — X during streaming too
            .replace(/\*\*([^*\n]+)\*\*\s*[—–]\s*([^\n*]{5,})/g, (m, h, d) =>
              _normEcho(d) === _normEcho(h) ? `**${h}**` : m);
          streamedBubble.textContent = displayText;
          scrollToBottom(el.messages);
        }
        // Feed sentence detector for live TTS (voice mode only)
        if (doLiveTts && !isSpeaking) feedLiveTts(token, myLiveTtsGen, queryLang);
      };

      const reply = await callClaude(config);
      // Restore lang in case auto-detect overrode it
      currentLang = savedLang;
      delete config._onStream;

      // Snap and consume _lastArticles before any async gaps
      let lastArticles = window.NewsAI && window.NewsAI._lastArticles;
      if (window.NewsAI) window.NewsAI._lastArticles = null;
      // DOM fallback: when backend was unavailable, keyword-match against DOM-scraped articles
      if (!lastArticles) {
        const domArts = window.NewsAI && window.NewsAI.articles;
        const lastUser = conversationHistory.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
        if (domArts && domArts.length && lastUser) {
          lastArticles = domFallbackArticles(lastUser, domArts);
        }
      }

      if (!streamedEl) {
        hideTyping();
        streamedEl = appendMessage(el.messages, 'bot', reply || '(empty response)');
        // Don't inject article links when AI explicitly says info isn't in today's paper
        if (!isNoInfoReply(reply)) {
          injectArticleLinks(streamedEl, lastArticles);
          renderImageStrip(streamedEl, lastArticleMeta);
        }
      } else {
        const finalText = reply || fullReply;
        // Upgrade from textContent (safe during streaming) to rendered HTML with clickable links
        if (streamedBubble) streamedBubble.innerHTML = renderBotText(finalText);
        // Replace speak button: streaming created it with data-text="" (empty).
        // Cloning removes the old empty-text listener before we re-wire with final text.
        const oldSpeakBtn = streamedEl.querySelector('.newsai-speak-btn');
        if (oldSpeakBtn) {
          const newSpeakBtn = oldSpeakBtn.cloneNode(true);
          newSpeakBtn.dataset.text = finalText;
          oldSpeakBtn.parentNode.replaceChild(newSpeakBtn, oldSpeakBtn);
        }
        // Same fix for share button — update data-text to final streamed content.
        const oldShareBtn = streamedEl.querySelector('.newsai-share-btn');
        if (oldShareBtn) {
          const newShareBtn = oldShareBtn.cloneNode(true);
          newShareBtn.dataset.text = finalText;
          oldShareBtn.parentNode.replaceChild(newShareBtn, oldShareBtn);
        }
        // Update copy button data-text to final streamed content (mirrors speak/share update above)
        const oldCopyBtn = streamedEl.querySelector('.newsai-copy-btn');
        if (oldCopyBtn) oldCopyBtn.dataset.text = finalText;
        wireSpeak(streamedEl);
        wireShare(streamedEl);
        wireCopy(streamedEl);
        // Don't inject article links when AI explicitly says info isn't in today's paper
        if (!isNoInfoReply(finalText)) {
          injectArticleLinks(streamedEl, lastArticles);
          renderImageStrip(streamedEl, lastArticleMeta);
        }
        // Scroll to the TOP of the new bot message so user reads from the start
        requestAnimationFrame(() => {
          if (streamedEl) streamedEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
          else scrollToBottom(el.messages);
        });
      }

      const finalReply = reply || fullReply;
      conversationHistory.push({ role: 'assistant', content: finalReply });
      trimHistory();
      saveSession();
      // saveHistory removed — history intentionally clears when tab closes

      if (voiceInputActive) {
        voiceInputActive = false;
        const speakBtn = streamedEl.querySelector('.newsai-speak-btn');
        // Guard: never call startSpeaking with empty text — an empty TTS request returns
        // HTTP 400, which (if not caught as transient) permanently disables backend TTS.
        if (speakBtn && finalReply && finalReply.trim()) {
          if (voiceMode) setVoiceStatus('speaking');
          startSpeaking(speakBtn, finalReply);
        }
      }

      // ── Section redirect button ───────────────────────────────────────────────
      // Keys must match detectAndFilterTopic() output EXACTLY — it emits
      // "Crime & Police" (not "Crime"), so the old "Crime" key never matched.
      const _SECTION_TE_MAP = {
        'Sports': 'క్రీడలు', 'Cinema': 'సినిమా', 'National': 'జాతీయం',
        'International': 'అంతర్జాతీయం', 'Business': 'వ్యాపారం',
        'Telangana': 'తెలంగాణ', 'Andhra Pradesh': 'ఆంధ్రప్రదేశ్',
        'Crime & Police': 'నేరాలు', 'Politics': 'రాజకీయాలు',
        'Family': 'కుటుంబం', 'Women': 'మహిళలు',
        // Previously missing — redirect button was silently dead for these sections
        'Agriculture': 'వ్యవసాయం', 'Education': 'విద్య', 'Public Health': 'ఆరోగ్యం',
        'Technology': 'సాంకేతిక', 'Courts': 'న్యాయస్థానం', 'Railways': 'రైల్వే',
        'Aviation': 'విమానాలు', 'Irrigation': 'నీటిపారుదల',
        'Roads & Buildings': 'రహదారులు', 'Local Bodies': 'స్థానిక సంస్థలు',
        'Public Administration': 'పరిపాలన', 'Lifestyle': 'జీవనశైలి',
      };
      const _lastSection = window.NewsAI && window.NewsAI._lastSection;
      if (_lastSection && streamedEl) {
        window.NewsAI._lastSection = null;
        const sectionUrls = (config && config.sectionUrls) || {};
        const teKey = _SECTION_TE_MAP[_lastSection] || _lastSection;
        const sectionUrl = sectionUrls[teKey] || sectionUrls[_lastSection];
        if (sectionUrl) {
          const sectionBtn = document.createElement('button');
          sectionBtn.className = 'newsai-read-btn';
          sectionBtn.style.cssText = [
            'display:block', 'width:100%', 'margin-top:8px', 'padding:8px 14px',
            'background:var(--newsai-primary,#C0392B)', 'color:#fff', 'border-radius:20px',
            'border:none', 'cursor:pointer', 'font-size:12px', 'font-weight:600',
            'text-align:center',
          ].join(';');
          const brandName = (config && config.brand && config.brand.name) || 'NewsAI';
          sectionBtn.textContent = currentLang === 'te'
            ? `📰 ${brandName} ${teKey} చదవండి →`
            : `📰 Read all ${_lastSection} news on ${brandName} →`;
          sectionBtn.addEventListener('click', function() {
            window.location.href = sectionUrl;
          });
          streamedEl.appendChild(sectionBtn);
        }
      }

      // ── Stream-drop recovery: SSE ended without [DONE] → offer a Retry ────────
      if (!_lastStreamComplete && streamedEl) {
        appendRetryIndicator(streamedEl, el, config);
      }
    } catch (err) {
      delete config._onStream;
      currentLang = savedLang;   // restore in case auto-detect overrode it
      liveTtsGen++;               // cancel any pending live TTS queue
      voiceInputActive = false;
      hideTyping();
      const errText = err?.message || String(err);
      console.error('[NewsAI] API error:', errText, err);
      appendMessage(el.messages, 'bot', t('error'));
    } finally {
      isTyping         = false;
      el.send.disabled = false;
      currentLang      = savedLang;   // always restore (no-op if not overridden)
    }
  }

  // ─── Provider auto-detect from API key prefix ────────────────────────────
  // Returns 'gemini' | 'groq' | 'anthropic' | 'unknown'.
  // NEVER falls back to 'groq' for unrecognised prefixes — that would silently
  // route an invalid key (e.g. a Google OAuth token starting with "AQ.") to Groq,
  // causing confusing "invalid auth" errors from the wrong API.
  function detectProvider(key) {
    if (!key) return 'unknown';
    if (key.startsWith('AIza'))   return 'gemini';   // Google AI Studio API key
    if (key.startsWith('AQ.'))    return 'gemini';   // Google OAuth2 access token
    if (key.startsWith('gsk_'))   return 'groq';
    if (key.startsWith('sk-ant-')) return 'anthropic';
    return 'unknown';
  }

  /**
   * Build the correct URL + headers for a Gemini API call.
   *
   * Both AIza... (Standard) and AQ.Ab... (Auth/new format) keys use the
   * same native Gemini auth: pass as ?key= query parameter.
   * Do NOT use Authorization: Bearer on the native endpoint — that causes
   * "Multiple authentication credentials received" (400/401).
   * Bearer is only relevant for the OpenAI-compat path (/v1beta/openai/...),
   * which we do not use.
   */
  function geminiRequest(apiKey, model, method, streaming) {
    const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}`;
    const url = streaming
      ? `${base}?key=${encodeURIComponent(apiKey)}&alt=sse`
      : `${base}?key=${encodeURIComponent(apiKey)}`;
    return { url, headers: { 'Content-Type': 'application/json' } };
  }

  // ─── Smart topN classifier ────────────────────────────────────────────────
  // Returns the right article budget for a question so we don't send 30 articles
  // for a simple "who scored?" query or 3 articles for a full section digest.
  function classifyTopN(question, cacheActive) {
    // When Gemini context cache is active, all 200 articles are already cached —
    // we only need a handful of articles for the "Read More" link buttons.
    if (cacheActive) return 4;

    const q = question.toLowerCase();

    // Simple factual: short who/what/when/how-many queries
    const isSimple = q.length < 70 && /^(who|what|when|where|how many|ఎవరు|ఏమి|ఎంత|ఎప్పుడు|స్కోర్|కెప్టెన్)/.test(q);
    if (isSimple) return 4;

    // Section digest / "today's X" / "all cricket" / broad summary
    const isBroadDigest = /(summary|summarize|digest|highlights|all articles|all news|today's|ఈ రోజు|అన్ని వార్తలు|హెడ్లైన్స్|సారాంశం|టాప్ వార్తలు)/.test(q);
    if (isBroadDigest) return 12;

    // Section-specific query that needs a few results to scan
    return 6;
  }

  // ─── Backend context fetch ────────────────────────────────────────────────
  async function fetchBackendContext(question) {
    try {
      const cacheActive = !!(geminiCacheId && Date.now() < geminiCacheExpiry);
      const topN = classifyTopN(question, cacheActive);

      const resp = await fetch(`${backendBaseUrl}/api/query`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question, topN, sessionId }),
        signal:  AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.context) return null;
      console.log(`[NewsAI] ✅ Backend RAG: ${data.articles?.length} articles | topN=${topN} | cache=${cacheActive}`);
      // Store top matched articles for redirect buttons (up to 3, URL required)
      if (data.articles && data.articles.length > 0 && window.NewsAI) {
        const _seenUrls = new Set();
        window.NewsAI._lastArticles = data.articles
          .filter(function(a) { return !!a.url && !_seenUrls.has(a.url) && _seenUrls.add(a.url); })
          .slice(0, 3)
          .map(function(a) { return { url: a.url, title: a.title || '', imageUrl: a.imageUrl || '' }; });
        // Also feed the image strip (top 5 with images) for the direct-fallback path,
        // where the backend SSE 'meta' event never fires.
        lastArticleMeta = data.articles
          .slice(0, 5)
          .map(function(a) { return { url: a.url || '', title: a.title || '', imageUrl: a.imageUrl || '' }; });
      }
      // When cache is active, don't pass the context into systemPrompt — the cache
      // already has all articles. Return null so callGemini uses its slim overlay only.
      return cacheActive ? null : data.context;
    } catch (_) {
      return null;
    }
  }

  // ─── Backend AI proxy (key stays server-side) ────────────────────────────
  // POSTs the chat history to /api/ai and consumes the SSE stream. Each event is
  // `data: {"token":"..."}`; the terminal event is `data: [DONE]`. Returns the
  // full concatenated text. Throws on HTTP error so callClaude() can fall back
  // to a direct browser-side provider call.
  async function callBackendAI(messages, lang, sessId, onStream, opts = {}) {
    // 35-second timeout prevents the widget hanging indefinitely on a stalled connection.
    const resp = await fetch(`${backendBaseUrl}/api/ai`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ messages, lang, sessionId: sessId, voiceMode: !!opts.voiceMode }),
      signal:  AbortSignal.timeout(35000),
    });
    if (!resp.ok) throw new Error(`Backend AI HTTP ${resp.status}`);
    if (!resp.body || !resp.body.getReader) throw new Error('Backend AI stream unsupported');

    const reader = resp.body.getReader();
    const dec    = new TextDecoder();
    let buf  = '';
    let full = '';
    // Track clean completion: only a [DONE] token flips this true. If the stream drops
    // (network/timeout) the loop exits via `done` with this still false → caller shows Retry.
    let streamDone = false;
    _lastStreamComplete = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        if (raw === '[DONE]') { streamDone = true; break; }
        try {
          const obj = JSON.parse(raw);
          if (obj.token) { full += obj.token; if (onStream) onStream(obj.token); }
          // Handle meta event — populate Read More article links + image strip
          if (obj.meta && Array.isArray(obj.meta.articles)) {
            lastArticleMeta = obj.meta.articles
              .filter(function(a) { return a && (a.url || a.imageUrl); })
              .map(function(a) { return { url: a.url || '', title: a.title || '', imageUrl: a.imageUrl || '' }; });
            if (window.NewsAI) window.NewsAI._lastArticles = obj.meta.articles;
          }
        } catch (_) { /* partial JSON across chunks — ignore */ }
      }
      if (streamDone) break;
    }
    _lastStreamComplete = streamDone;
    return full;
  }

  // ─── LLM API call (auto-routes by key prefix) ────────────────────────────
  async function callClaude(config) {
    const apiKey = config.geminiApiKey || config.groqApiKey || config.apiKey || config.anthropicApiKey;
    const provider = detectProvider(apiKey); // key prefix is source of truth

    // ── Missing or placeholder key ──────────────────────────────────────────
    if (!apiKey || apiKey.startsWith('REPLACE_WITH') || apiKey.length < 10) {
      console.warn('[NewsAI] No API key found in config. Key value:', apiKey ? `${apiKey.slice(0,6)}... (len ${apiKey.length})` : 'EMPTY');
      return currentLang === 'te'
        ? 'API కీ సెట్ చేయబడలేదు. Extension popup తెరిచి మీ API కీ పేస్ట్ చేయండి (Gemini: aistudio.google.com/apikey | Groq: console.groq.com).'
        : 'API key not set. Open the extension popup and paste your key. Get a free Gemini key at aistudio.google.com/apikey or a free Groq key at console.groq.com.';
    }

    // ── Unrecognised key prefix — show a clear error instead of misrouting ──
    if (provider === 'unknown') {
      console.error('[NewsAI] Unrecognised API key prefix:', apiKey.slice(0, 8));
      return currentLang === 'te'
        ? `API కీ గుర్తించలేకపోయాం. Gemini కీ "AIza" లేదా "AQ." తో మొదలవుతుంది, Groq కీ "gsk_" తో మొదలవుతుంది. Extension popup తెరిచి సరైన కీ పేస్ట్ చేయండి.`
        : `API key not recognised (starts with "${apiKey.slice(0, 6)}..."). Gemini keys start with "AIza" or "AQ.", Groq keys start with "gsk_". Open the extension popup and paste the correct key.`;
    }

    console.log(`[NewsAI] Calling ${provider} | key prefix: ${apiKey.slice(0, 8)}... | history: ${conversationHistory.length} msgs`);

    if (window.NewsAI) {
      window.NewsAI.contentBudget = (provider === 'gemini') ? 10000 : 4500;
    }

    const lastUserMsg = conversationHistory.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

    // ── Wait for section pages if this is a section-specific query ────────────
    // Section pages (sports, cinema, etc.) load asynchronously after page load.
    // If the user asks about a section before they arrive, we wait up to 5s
    // so they never see "not available" just because of a timing race.
    const sectionQuery = detectAndFilterTopic(lastUserMsg, null);
    if (sectionQuery && window.NewsAI && !window.NewsAI.sectionPagesReady) {
      console.log(`[NewsAI] ⏳ Waiting for section pages (${sectionQuery.section} query)...`);
      await new Promise(resolve => {
        const started = Date.now();
        const check = setInterval(() => {
          if ((window.NewsAI && window.NewsAI.sectionPagesReady) || Date.now() - started > 5000) {
            clearInterval(check);
            resolve();
          }
        }, 150);
      });
      const ready = window.NewsAI && window.NewsAI.sectionPagesReady;
      console.log(`[NewsAI] ${ready ? '✅ Section pages ready — proceeding with query' : '⚠️ Timed out — proceeding anyway'}`);
    }

    const histLimit = (provider === 'groq') ? 2 : MAX_HISTORY;
    const messages  = conversationHistory.slice(-histLimit * 2);
    const onStream  = config._onStream || null;

    // ── Try backend AI proxy first (API key stays server-side) ────────────────
    // The backend fetches its own article context and calls Gemini — we don't need
    // to call fetchBackendContext or buildSystemPrompt unless this falls back.
    try {
      const backendResult = await callBackendAI(messages, currentLang, sessionId, onStream,
        { voiceMode: voiceMode || voiceInputActive });
      // Use != null (covers both null and undefined) so an empty string "" is treated as a
      // valid (if empty) response — not as a failure that triggers a redundant direct API call.
      if (backendResult != null) return backendResult;
    } catch (backendErr) {
      console.warn('[NewsAI] Backend AI unavailable, falling back to direct API:', backendErr.message);
      // In extension context (or on sites with strict CSP like Sakshi.com), direct fetch
      // to external APIs is blocked — TypeError "Failed to fetch". Skip the fallback
      // and re-throw so the user sees a clear error message instead of a confusing silent failure.
      const _isExtCtx = typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined' && !!chrome.runtime.id;
      if (_isExtCtx) throw backendErr;
    }

    // ── Fallback: direct browser-side provider call ───────────────────────────
    // Only reached when the backend proxy is unreachable or returned a non-OK status.
    // The backend SSE may have already flipped this false mid-drop; the direct call is a
    // full replacement, so treat it as a clean path and clear the "stream broke" flag.
    _lastStreamComplete = true;
    const backendCtx = await fetchBackendContext(lastUserMsg);
    if (backendCtx && window.NewsAI) window.NewsAI._backendContext = backendCtx;
    const systemPrompt = buildSystemPrompt(config, provider, lastUserMsg);

    if (provider === 'gemini')    return callGemini(apiKey, systemPrompt, messages, onStream);
    if (provider === 'anthropic') return callAnthropic(apiKey, systemPrompt, messages, onStream);
    return callGroq(apiKey, systemPrompt, messages, config.llmModel, onStream);
  }

  async function callGroq(apiKey, systemPrompt, messages, model, onStream, _retries = 0) {
    const chosenModel = (model === 'llama-3.3-70b-versatile' || !model)
      ? 'llama-3.1-8b-instant'
      : model;

    let safePrompt = systemPrompt;
    if (safePrompt.length > 5000) {
      const cutAt = safePrompt.indexOf('TODAY\'S ARTICLES');
      if (cutAt > 0) {
        const header = safePrompt.slice(0, cutAt);
        const rest   = safePrompt.slice(cutAt);
        safePrompt = header + rest.slice(0, 3500) + '\n[Trimmed]';
      }
    }

    const bodyObj = {
      model: chosenModel,
      max_tokens: 8000,   // English replies are more verbose than Telugu — avoid truncation
      temperature: 0.1,
      stream: !!onStream,
      messages: [
        { role: 'system', content: safePrompt },
        ...messages,
      ],
    };

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(bodyObj),
    });

    if (resp.status === 429 && _retries < 1) {
      const err = await resp.json().catch(() => ({}));
      const msg = err.error?.message || '';
      const waitMatch = msg.match(/try again in ([\d.]+)s/i);
      const waitSec = waitMatch ? Math.max(5, Math.ceil(parseFloat(waitMatch[1])) + 1) : 8;
      console.warn(`[NewsAI] Groq rate limited — retrying in ${waitSec}s...`);
      await countdownWait(waitSec);
      return callGroq(apiKey, systemPrompt, messages, chosenModel, onStream, _retries + 1);
    }

    if (resp.status === 429) {
      throw new Error(currentLang === 'te'
        ? 'చాలా ప్రశ్నలు వేశారు. ఒక నిమిషం వేచి తిరిగి ప్రయత్నించండి.'
        : 'Too many requests. Please wait a moment and try again.');
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }

    // ── Streaming path ─────────────────────────────────────────────────────
    if (onStream) {
      const reader = resp.body.getReader();
      const dec    = new TextDecoder();
      let buf = '';
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any remaining partial line that wasn't followed by \n
          if (buf.startsWith('data: ')) {
            const raw = buf.slice(6).trim();
            if (raw && raw !== '[DONE]') {
              try {
                const chunk = JSON.parse(raw);
                const token = chunk.choices?.[0]?.delta?.content || '';
                if (token) { full += token; onStream(token); }
              } catch (_) {}
            }
          }
          break;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const chunk = JSON.parse(raw);
            const token = chunk.choices?.[0]?.delta?.content || '';
            if (token) { full += token; onStream(token); }
          } catch (_) {}
        }
      }
      return full;
    }

    const data = await resp.json();
    const groqText = data.choices?.[0]?.message?.content;
    if (!groqText) { console.error('[NewsAI] Groq empty response:', JSON.stringify(data)); throw new Error('Empty response from Groq'); }
    return groqText;
  }

  async function callAnthropic(apiKey, systemPrompt, messages, onStream) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-calls': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,   // English replies are more verbose than Telugu — avoid truncation
        stream: !!onStream,
        system: systemPrompt,
        messages,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }

    // ── Streaming path ─────────────────────────────────────────────────────
    if (onStream) {
      const reader = resp.body.getReader();
      const dec    = new TextDecoder();
      let buf = '';
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any remaining buffered line
          if (buf.trim()) {
            try {
              const ev = JSON.parse(buf.replace(/^data:\s*/, ''));
              const token = ev.delta?.text || '';
              if (token) { full += token; onStream(token); }
            } catch (_) {}
          }
          break;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]' || !raw) continue;
          try {
            const ev = JSON.parse(raw);
            // Anthropic streams content_block_delta events
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              const token = ev.delta.text || '';
              if (token) { full += token; onStream(token); }
            }
          } catch (_) {}
        }
      }
      return full;
    }

    // ── Non-streaming path ─────────────────────────────────────────────────
    const data = await resp.json();
    const anthropicText = data.content?.[0]?.text;
    if (!anthropicText) { console.error('[NewsAI] Anthropic empty response:', JSON.stringify(data)); throw new Error('Empty response from Anthropic'); }
    return anthropicText;
  }

  // ─── Gemini 2.5 Flash-Lite ────────────────────────────────────────────────
  async function callGemini(apiKey, systemPrompt, messages, onStream, _retries = 0) {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const deduped = contents.filter((m, i) => i === 0 || m.role !== contents[i - 1].role);
    while (deduped.length > 0 && deduped[0].role !== 'user') deduped.shift();
    if (!deduped.length) throw new Error('No user messages to send to Gemini');

    const MODEL = 'gemini-2.5-flash-lite';

    // ── Lazy cache refresh ────────────────────────────────────────────────────
    // At widget open we fetch the cache ID once — but articles may be ingested
    // after that (backend just started, midnight reset, etc.). If we have no cache
    // ID, do a quick 1-second probe now so we benefit from the cache this call.
    if (!geminiCacheId || Date.now() >= geminiCacheExpiry) {
      try {
        const cr = await fetch(`${backendBaseUrl}/api/gemini-cache`,
          { signal: AbortSignal.timeout(1000) });
        const cd = cr.ok ? await cr.json() : null;
        if (cd && cd.active && cd.cacheId) {
          geminiCacheId     = cd.cacheId;
          geminiCacheExpiry = cd.expiresAt || (Date.now() + 23 * 3600 * 1000);
          console.log('[NewsAI] Gemini cache refreshed on-demand:', geminiCacheId);
        }
      } catch (_) { /* cache unavailable — fall through to full prompt */ }
    }

    // Use Gemini context cache when available — avoids resending all articles every request
    // (90% cheaper on cached input tokens). Falls back to full systemInstruction if cache
    // is missing, expired, or the backend doesn't support caching (too few articles).
    const activeCacheId = (geminiCacheId && Date.now() < geminiCacheExpiry) ? geminiCacheId : null;

    // Per-query overlay: language rule + anti-hallucination + basic rules — these change
    // on every request (language toggle, topic, etc.) and must ALWAYS be sent fresh.
    // When cache is active the articles are already in the cache; this slim overlay is the
    // only systemInstruction we send so we don't re-pay for the full article tokens.
    const _isEn = currentLang === 'en';
    const _langOverride = _isEn
      ? 'RESPOND IN ENGLISH ONLY. Translate ALL Telugu article text to English. Every word of your response must be in English.'
      : 'RESPOND IN TELUGU. Every word of your response must be in Telugu script. Only proper nouns may stay in English.';
    const cacheOverlayInstruction = `🔴 LANGUAGE OVERRIDE — HIGHEST PRIORITY: ${_langOverride}
This overrides every previous message in this conversation. Ignore the language used before.

🔴 ANTI-HALLUCINATION — ABSOLUTE RULE:
- ONLY use facts EXPLICITLY WRITTEN in today's cached articles.
- Do NOT invent specific numbers (live scores, prices, index levels, statistics) not written in those articles. If relevant articles exist for the topic: show them using TIER 1 format. Only say "ఈ వివరాలు ఈ రోజు పేపర్‌లో లేవు" if there are NO relevant articles at all. You may add one brief note that live real-time figures may not appear in print — only if the user specifically asked for a live number.

STRICT RULES: Use **bold** only for headlines. Never invent scores, statistics, player names, or numbers. Never include URLs in your response. Never include CMS datelines, timestamps, or "Updated on" text.`;

    // thinkingBudget:0 — Gemini 2.5 models default to outputting "thought:true" tokens
    // first, then the actual response. Our SSE parser takes parts[0].text; without
    // disabling thinking, parts[0] is a thought token and the real response is missed.
    const _genConfig = { maxOutputTokens: 8192, temperature: 0.1, topP: 0.85,
                         thinkingConfig: { thinkingBudget: 0 } };

    const bodyObj = activeCacheId
      ? {
          // cachedContent holds today's articles (pre-cached by backend).
          // ⚠️ Gemini API FORBIDS using systemInstruction alongside cachedContent —
          // error: "CachedContent can not be used with system_instruction".
          // Inject the per-query overlay as a leading user/model exchange in contents[]
          // so it takes effect without conflicting with the cache constraint.
          cachedContent: activeCacheId,
          contents: [
            { role: 'user',  parts: [{ text: cacheOverlayInstruction }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions exactly.' }] },
            ...deduped,
          ],
          generationConfig: _genConfig,
        }
      : {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: deduped,
          generationConfig: _genConfig,
        };

    if (activeCacheId) {
      console.log('[NewsAI] Using Gemini context cache:', activeCacheId);
    }

    // ── Streaming path ─────────────────────────────────────────────────────
    if (onStream) {
      const { url: streamUrl, headers: streamHdrs } = geminiRequest(apiKey, MODEL, 'streamGenerateContent', true);
      const resp = await fetch(streamUrl,
        { method: 'POST', headers: streamHdrs, body: JSON.stringify(bodyObj) }
      );
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(currentLang === 'te'
          ? 'API కీ చెల్లదు లేదా గడువు తీరింది. aistudio.google.com/apikey లో కొత్త AQ.Ab… కీ తీసుకుని Extension popup లో పేస్ట్ చేయండి.'
          : 'API key invalid or expired. Go to aistudio.google.com/apikey → Create API key → paste the new AQ.Ab… key in the extension popup.');
      }
      if (resp.status === 429) {
        if (_retries < 2) { await countdownWait(15); return callGemini(apiKey, systemPrompt, messages, onStream, _retries + 1); }
        throw new Error('Rate limited — wait 60s and try again.');
      }
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(`Gemini: ${e.error?.message || resp.status}`);
      }
      const reader = resp.body.getReader();
      const dec    = new TextDecoder();
      let buf = '';
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush trailing partial line (Gemini doesn't always end with \n)
          if (buf.startsWith('data: ')) {
            const raw = buf.slice(6).trim();
            if (raw && raw !== '[DONE]') {
              try {
                const chunk = JSON.parse(raw);
                const _part = chunk.candidates?.[0]?.content?.parts?.[0];
                if (!_part || _part.thought) { /* skip thinking tokens */ } else {
                  const token = _part.text || '';
                  if (token) { full += token; onStream(token); }
                }
              } catch (_) {}
            }
          }
          break;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const chunk = JSON.parse(raw);
            const _part = chunk.candidates?.[0]?.content?.parts?.[0];
            if (!_part || _part.thought) continue;  // skip thinking tokens
            const token = _part.text || '';
            if (token) { full += token; onStream(token); }
          } catch (_) {}
        }
      }
      return full;
    }

    // ── Non-streaming path ─────────────────────────────────────────────────
    const { url: genUrl, headers: genHdrs } = geminiRequest(apiKey, MODEL, 'generateContent', false);
    const resp = await fetch(genUrl,
      { method: 'POST', headers: genHdrs, body: JSON.stringify(bodyObj) }
    );

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(currentLang === 'te'
        ? 'API కీ చెల్లదు లేదా గడువు తీరింది. aistudio.google.com/apikey లో కొత్త AQ.Ab… కీ తీసుకుని Extension popup లో పేస్ట్ చేయండి.'
        : 'API key invalid or expired. Go to aistudio.google.com/apikey → Create API key → paste the new AQ.Ab… key in the extension popup.');
    }
    if (resp.status === 429) {
      const errBody = await resp.json().catch(() => ({}));
      const retryDetail = errBody.error?.details?.find(d => d.retryDelay);
      const retrySeconds = Math.max(10, retryDetail
        ? parseInt(retryDetail.retryDelay, 10) || 15
        : 15);
      if (_retries < 2) {
        console.warn(`[NewsAI] Gemini rate limited — retrying in ${retrySeconds}s (attempt ${_retries + 1}/2)...`);
        await countdownWait(retrySeconds);
        return callGemini(apiKey, systemPrompt, messages, null, _retries + 1);
      }
      throw new Error(currentLang === 'te'
        ? `చాలా ప్రశ్నలు వేశారు. ${retrySeconds}s తర్వాత మళ్ళీ ప్రయత్నించండి.`
        : `Gemini rate limit reached. Wait ${retrySeconds}s and try again.`);
    }
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const msg = errBody.error?.message || errBody.error?.status || `HTTP ${resp.status}`;
      console.error('[NewsAI] Gemini error:', resp.status, JSON.stringify(errBody));
      if (resp.status === 400 && msg.toLowerCase().includes('api key')) {
        throw new Error('Invalid Gemini API key. Go to aistudio.google.com/apikey and generate a new key, then paste it in the extension popup.');
      }
      throw new Error(`Gemini: ${msg}`);
    }
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.error('[NewsAI] Gemini empty response:', JSON.stringify(data));
      throw new Error('Empty response from Gemini');
    }
    return text;
  }

  // ─── Smart topic pre-filter ───────────────────────────────────────────────
  const TOPIC_FILTERS = [
    { triggers: ['sport','sports','cricket','ipl','football','badminton','boxing','tennis','kabaddi','olympic','match','tournament','league','వ్యాయామం','క్రీడ','క్రీడలు','స్పోర్ట్స్','క్రికెట్','మ్యాచ్','ఫుట్బాల్','ఆట','ఆటలు','కబడ్డీ','హాకీ','టెన్నిస్','బ్యాడ్మింటన్','బాక్సింగ్','ఒలింపిక్స్','టోర్నమెంట్'],
      section: 'Sports',
      bodyKeys: ['cricket','match','tournament','ipl','t20','odi','wicket','batting','bowling','football','badminton','hockey','kabaddi','olympic','medal','sport','player','క్రికెట్','మ్యాచ్','టోర్నమెంట్','వికెట్','క్రీడ','ఆటగాడు','మెడల్','ట్రోఫీ','చాంపియన్'] },
    { triggers: ['cinema','movie','film','tollywood','bollywood','ott','actor','actress','release','సినిమా','నటుడు','నటి','చిత్రం','వినోదం','టాలీవుడ్','ఓటీటీ','మూవీ'],
      section: 'Cinema',
      bodyKeys: ['cinema','movie','film','actor','actress','director','release','ott','tollywood','bollywood','trailer','సినిమా','నటుడు','నటి','చిత్రం','దర్శకుడు','రిలీజ్','ట్రైలర్','హీరో','హీరోయిన్'] },
    { triggers: ['telangana','hyderabad','secunderabad','revanth','ktr','brs','warangal','nizamabad','karimnagar','తెలంగాణ','హైదరాబాద్','సికింద్రాబాద్','వరంగల్','రేవంత్','కేటీఆర్'],
      section: 'Telangana',
      bodyKeys: ['telangana','hyderabad','secunderabad','revanth','ktr','brs','warangal','nizamabad','karimnagar','khammam','తెలంగాణ','హైదరాబాద్','కేటీఆర్','రేవంత్'] },
    { triggers: ['andhra','amaravati','vijayawada','vizag','chandrababu','jagan','tdp','ysrcp','ఆంధ్ర','అమరావతి','విజయవాడ','విజాగ్','చంద్రబాబు','జగన్','ఏపీ'],
      section: 'Andhra Pradesh',
      bodyKeys: ['andhra','amaravati','vijayawada','vizag','visakhapatnam','chandrababu','jagan','tdp','ysrcp','guntur','tirupati','ఆంధ్ర','అమరావతి','విజయవాడ','చంద్రబాబు','జగన్'] },
    { triggers: ['national','india','central','modi','bjp','congress','parliament','lok sabha','జాతీయ','కేంద్ర','ఢిల్లీ','భారత్','మోదీ','పార్లమెంట్'],
      section: 'National',
      bodyKeys: ['national','india','central government','modi','bjp','congress','parliament','lok sabha','rajya sabha','delhi','జాతీయ','కేంద్ర','మోదీ','పార్లమెంట్','లోక్‌సభ'] },
    { triggers: ['international','world','global','usa','america','china','russia','warfare','iran','israel','అంతర్జాతీయ','విదేశీ','ప్రపంచం','అమెరికా','చైనా','యుద్ధం'],
      section: 'International',
      bodyKeys: ['international','world','global','america','usa','china','russia','war','iran','israel','trump','అంతర్జాతీయ','విదేశీ','ప్రపంచం','అమెరికా','యుద్ధం'] },
    { triggers: ['business','economy','market','sensex','nifty','rbi','stock','budget','gdp','వ్యాపారం','ఆర్థిక','మార్కెట్','షేర్','బడ్జెట్','సెన్సెక్స్'],
      section: 'Business',
      bodyKeys: ['business','economy','market','sensex','nifty','rbi','stock','budget','gdp','tax','gst','వ్యాపారం','ఆర్థిక','మార్కెట్','సెన్సెక్స్','బడ్జెట్'] },
    { triggers: ['politics','election','vote','minister','party','రాజకీయ','ఎన్నికలు','మంత్రి','పార్టీ','ముఖ్యమంత్రి'],
      section: 'Politics',
      bodyKeys: ['election','vote','minister','party','assembly','campaign','political','ఎన్నికలు','మంత్రి','పార్టీ','ప్రచారం','రాజకీయ'] },
    { triggers: ['agriculture','farmer','crop','రైతు','వ్యవసాయం','పంట','రైతన్న'],
      section: 'Agriculture',
      bodyKeys: ['farmer','agriculture','crop','paddy','drought','fertilizer','రైతు','వ్యవసాయం','పంట','ఎరువు','కరువు','సాగు'] },
    { triggers: ['education','school','college','exam','student','result','విద్య','పాఠశాల','విద్యార్థి','పరీక్ష','ఫలితాలు'],
      section: 'Education',
      bodyKeys: ['school','college','university','exam','student','result','admission','eamcet','విద్య','పాఠశాల','విద్యార్థి','పరీక్ష','ఫలితాలు','అడ్మిషన్'] },
    { triggers: ['health','hospital','disease','doctor','medicine','ఆరోగ్యం','వైద్యం','ఆసుపత్రి','వ్యాధి'],
      section: 'Public Health',
      bodyKeys: ['health','hospital','disease','doctor','medicine','vaccine','cancer','virus','ఆరోగ్యం','వైద్యం','ఆసుపత్రి','వ్యాధి','వ్యాక్సిన్'] },
    { triggers: ['crime','police','murder','arrest','robbery','fraud','నేరం','పోలీసు','హత్య','అరెస్టు','మోసం','క్రైమ్'],
      section: 'Crime & Police',
      bodyKeys: ['murder','killed','arrested','robbery','fraud','police','crime','theft','నేరం','హత్య','పోలీసు','అరెస్టు','దొంగతనం','మోసం','దాడి'] },
    { triggers: ['technology','cyber','tech','artificial intelligence','mobile','app','software','సాంకేతిక','సైబర్','మొబైల్','యాప్'],
      section: 'Technology',
      bodyKeys: ['technology','cyber','software','app','mobile','internet','ai','digital','hacking','సాంకేతిక','సైబర్','సాఫ్ట్‌వేర్','యాప్','ఇంటర్నెట్'] },
    { triggers: ['court','high court','supreme court','judge','verdict','న్యాయస్థానం','హైకోర్టు','సుప్రీంకోర్టు','తీర్పు'],
      section: 'Courts',
      bodyKeys: ['court','high court','supreme court','judge','verdict','bail','petition','న్యాయస్థానం','హైకోర్టు','సుప్రీంకోర్టు','తీర్పు','బెయిల్'] },
    { triggers: ['railway','train','metro','రైల్వే','రైలు','మెట్రో'],
      section: 'Railways',
      bodyKeys: ['railway','train','metro','irctc','station','రైల్వే','రైలు','మెట్రో','స్టేషన్'] },
    { triggers: ['aviation','airport','flight','airline','విమానం','విమానాశ్రయం','ఫ్లైట్'],
      section: 'Aviation',
      bodyKeys: ['aviation','airport','flight','airline','pilot','విమానం','విమానాశ్రయం','ఫ్లైట్','పైలట్'] },
    { triggers: ['women','woman','మహిళ','మహిళలు','స్త్రీ'],
      section: 'Women',
      bodyKeys: ['women','woman','girl','dowry','domestic violence','మహిళ','స్త్రీ','అమ్మాయి','వరకట్నం','గృహ హింస'] },
    { triggers: ['irrigation','dam','reservoir','flood','water level','నీటిపారుదల','డ్యామ్','జలాశయం','వరద','కాలువ'],
      section: 'Irrigation',
      bodyKeys: ['dam','reservoir','canal','flood','water level','irrigation','godavari','krishna','జలాశయం','డ్యామ్','కాలువ','వరద'] },
    { triggers: ['road','highway','flyover','bridge','రహదారి','హైవే','ఫ్లైఓవర్','వంతెన','రోడ్డు'],
      section: 'Roads & Buildings',
      bodyKeys: ['road','highway','flyover','bridge','expressway','రహదారి','హైవే','ఫ్లైఓవర్','వంతెన','రోడ్డు'] },
    { triggers: ['municipality','panchayat','ghmc','gvmc','mayor','ward','కార్పొరేషన్','నగరపాలక','పంచాయతీ','మేయర్'],
      section: 'Local Bodies',
      bodyKeys: ['municipality','panchayat','ghmc','mayor','ward','councillor','కార్పొరేషన్','నగరపాలక','పంచాయతీ','మేయర్','కౌన్సిలర్'] },
    { triggers: ['lifestyle','fashion','food','travel','fitness','yoga','జీవనశైలి','ఫ్యాషన్','వంట','యోగా'],
      section: 'Lifestyle',
      bodyKeys: ['lifestyle','fashion','food','recipe','travel','fitness','yoga','beauty','జీవనశైలి','ఫ్యాషన్','వంట','టూరిజం','యోగా'] },
    { triggers: ['collector','administration','welfare','scheme','beneficiary','కలెక్టర్','పరిపాలన','సంక్షేమం','పథకం'],
      section: 'Public Administration',
      bodyKeys: ['collector','administration','welfare','scheme','beneficiary','government order','కలెక్టర్','పరిపాలన','సంక్షేమం','పథకం','లబ్ధిదారులు'] },
  ];

  // Extract the named section's headline block from todayContent string.
  // ONLY extracts the "SectionName:" block — stops at FULL TEXT (cross-section, risky).
  function extractSectionFromContent(content, sectionName) {
    if (!content) return '';
    const lines = content.split('\n');
    const sectionLines = [];
    let capturing = false;
    const needle = sectionName.toLowerCase();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === 'FULL TEXT:') break;
      if (trimmed.endsWith(':') && /^[A-Za-z& ]+:$/.test(trimmed)) {
        capturing = trimmed.slice(0, -1).trim().toLowerCase() === needle;
        if (capturing) sectionLines.push(line);
        continue;
      }
      if (capturing) sectionLines.push(line);
    }
    return sectionLines.join('\n').trim();
  }

  function detectAndFilterTopic(msg, articles) {
    if (!msg) return null;
    const lower = msg.toLowerCase();
    for (const f of TOPIC_FILTERS) {
      if (!f.triggers.some(t => lower.includes(t.toLowerCase()))) continue;
      if (!articles || !articles.length) return { section: f.section, filter: f, articles: null };
      // Section label only — no bodyKeys contamination risk
      const matching = articles.filter(a => a.section === f.section);
      return { section: f.section, filter: f, articles: matching };
    }
    return null;
  }

  /**
   * Extract first meaningful sentence from body text.
   * Done in JS — the LLM copies this, never generates it. Eliminates hallucination.
   */
  function extractFirstSentence(text) {
    if (!text || text.length < 30) return '';
    const m = text.match(/^.{20,150}?[.?!।\n]/);
    if (m) return m[0].trim();
    const cut = text.slice(0, 120);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
  }

  function stripTimestamps(text) {
    if (!text) return text;
    return text
      // Strip CMS datelines like "సాక్షి, వైఎస్సార్‌ జిల్లా:" embedded in article bodies
      .replace(/సాక్షి\s*,\s*[^\n:]{1,60}:\s*/g, '')
      .replace(/\s*\|?\s*Updated\s+on\s+[A-Za-z]{3,9}\.?\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)/gi, '')
      .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)/gi, '')
      // Strip Telugu CMS date patterns like "2023 ఫిబ్రవరి" leaking from metadata
      .replace(/\b\d{4}\s+(?:జనవరి|ఫిబ్రవరి|మార్చి|ఏప్రిల్|మే|జూన్|జూలై|ఆగస్టు|సెప్టెంబర్|అక్టోబర్|నవంబర్|డిసెంబర్)\b/g, '')
      .replace(/\s*\|\s*$/gm, '').replace(/^\s*\|\s*/gm, '')
      .trim();
  }

  function buildTopicContext(section, matching) {
    if (!matching.length) {
      return `ఈ రోజు ${section} వార్తలు అందుబాటులో లేవు. Today's edition has no ${section} articles.`;
    }
    let out = `${section} articles in today's edition:\n\n`;
    matching.forEach(a => {
      const rawBody = stripTimestamps((a.bodyTe || a.body || '').trim());
      const body = dedupContent(rawBody);  // collapse repeated fragments from CMS bugs
      // Skip articles with no real body — they add no grounding value and a
      // headline-only entry only tempts the model to invent a description.
      if (body.length < 150 || body === a.headline) return;  // skip — no body
      out += `Headline: ${a.headline}\n`;
      // Pre-extract first sentence in JS — LLM copies Summary field, never generates it.
      const summary = extractFirstSentence(body);
      const normStr = s => s.replace(/[.?!।\s]+$/g, '').replace(/^\s+/, '').toLowerCase();
      if (summary && normStr(summary) !== normStr(a.headline)) {
        out += `Summary: ${summary}\n`;
      }
      out += `Body: ${body.slice(0, 450)}\n`;
      // URL intentionally excluded — LLM must never print URLs in responses.
      out += '\n';
    });
    return out;
  }

  // ─── System prompt builder ─────────────────────────────────────────────────
  function buildSystemPrompt(config, provider, userMessage) {
    const { brand, sections } = config;

    // ── Backend briefing takes priority ────────────────────────────────────
    if (window.NewsAI && window.NewsAI._backendContext) {
      const backendContent = stripTimestamps(window.NewsAI._backendContext);
      delete window.NewsAI._backendContext;

      const isEnglish = currentLang === 'en';
      const langRule = isEnglish
        ? 'RESPOND IN ENGLISH ONLY. TRANSLATE everything to English — including all article headlines, summaries, and section names that are in Telugu. Every single word of your response must be in English. Do NOT leave any Telugu script in your output.'
        : 'RESPOND IN TELUGU. Every word of your response must be in Telugu script. Only proper nouns may stay in English.';
      // Closing line must follow the selected language, otherwise a hardcoded
      // Telugu sentence forces small models back into Telugu output.
      const closingLine = isEnglish
        ? 'Ask me which story you would like the full details for.'
        : 'ఏ వార్త పూర్తి వివరాలు కావాలో అడగండి.';

      return `You are ${brand.name}, a newspaper AI assistant.

🔴 LANGUAGE OVERRIDE — HIGHEST PRIORITY: ${langRule}
This overrides the language of every previous message in this conversation. Ignore what language was used before. Your ENTIRE response must follow the rule above — translate every Telugu word to English if English is required, or respond fully in Telugu if Telugu is required. The conversation history language does NOT determine your output language. This rule does.

🔴 ANTI-HALLUCINATION — ABSOLUTE RULE:
- ONLY use information EXPLICITLY WRITTEN in TODAY'S ARTICLES below.
- Do NOT invent or generate specific numbers (live scores, stock prices, index levels, exchange rates, statistics) not written word-for-word in TODAY'S ARTICLES.
- If RELEVANT ARTICLES EXIST for the topic: show them using TIER 1 format. You may add one brief note that live real-time figures may not appear in today's print edition — only if the user specifically asked for a live number.
- Only say "ఈ వివరాలు ఈ రోజు పేపర్‌లో లేవు" if there are truly NO relevant articles about the topic at all.

STRICT RULES:
1. ONLY use information present in TODAY'S ARTICLES below. Never add facts from training knowledge.
2. NEVER invent scores, statistics, player names, or any numbers not in the article text.
3. If Body says "[HEADLINE ONLY — DO NOT ADD ANY DESCRIPTION]": INTERNAL TAG — never print it. Output only the bold **Headline**.
4. No bullet points, no [1][2] numbers. Plain text only.
5. Never write the same sentence twice.
6. NEVER include URLs, links, or web addresses in your response.
7. Do NOT truncate. Finish the response completely. Never cut off mid-sentence.
8. NEVER include dates, timestamps, or "Updated on" text — strip them.
9. NEVER include CMS datelines like "సాక్షి, X జిల్లా:". Strip them.

── TIER 1: News listing (section query / top headlines / "ఈ రోజు వార్తలు") ──
When the user asks for a category of news, top stories, or today's headlines:
• For EACH article: write the Headline in bold: **Headline text**
• If a "Summary:" field exists AND its text differs from the Headline: write 1 sentence of that summary on the next line as plain text. Do NOT write the word "Summary:".
• ⛔ NEVER read or quote the "Body:" field in TIER 1. Body content is strictly for TIER 2 only.
• If Body says "[HEADLINE ONLY...]": bold headline only — nothing else.
• Blank line between each article.
End with exactly: "${closingLine}"

── TIER 2: Single article detail ("వివరాలు చెప్పు" / "tell me more about X") ──
When the user EXPLICITLY asks for more detail about ONE specific article ("tell me more", "వివరాలు", "explain X", "మరింత వివరంగా"):
• Find that article in TODAY'S ARTICLES.
• Write 4–5 sentences using ONLY what the "Body:" field contains. Copy verbatim, do not rephrase or add anything.
• If the user says "short" / "సంక్షిప్తంగా": 2–3 sentences from Body.
• If Body says "[HEADLINE ONLY...]": say (in the response language) "Only the headline is available for this article."
• If the article is not found: one sentence saying it is not in today's edition.

⛔ HALLUCINATION FORBIDDEN. ⛔ ${langRule}

TODAY'S ARTICLES:
${backendContent}

---
FINAL REMINDER — LANGUAGE: ${langRule}
FINAL REMINDER — NO HALLUCINATION: If a fact is not in TODAY'S ARTICLES above, do not write it.`;
    }

    // ── DOM fallback ─────────────────────────────────────────────────────────
    const fullContent = stripTimestamps((window.NewsAI && window.NewsAI.todayContent) || '');
    let todayContent = fullContent || 'Content is loading. Please wait a moment and try again.';

    const arts = window.NewsAI && window.NewsAI.articles;
    console.log(`[NewsAI Filter] arts=${arts ? arts.length : 'NONE'} todayContent=${fullContent.length} chars | query="${userMessage.slice(0,60)}"`);
    const topicResult = detectAndFilterTopic(userMessage, arts);
    let topicConstraint = '';
    if (topicResult) {
      const sec = topicResult.section;
      let filtered = null;

      // Method A: filter structured articles array by section label
      if (topicResult.articles && topicResult.articles.length > 0) {
        filtered = buildTopicContext(sec, topicResult.articles);
        console.log(`[NewsAI Filter] Method A: ${topicResult.articles.length} articles for "${sec}"`);
      }

      // Method B: extract section headline block from content string
      if (!filtered) {
        const extracted = extractSectionFromContent(fullContent, sec);
        if (extracted) {
          filtered = `${sec} news today:\n${extracted}`;
          console.log(`[NewsAI Filter] Method B: extracted ${extracted.length} chars for "${sec}"`);
        }
      }

      // Method C: section filter failed but we DO have articles — pass full content + constraint
      // Better than returning "not available" when scraping worked but section tagging failed.
      if (!filtered) {
        const hasContent = fullContent.length > 50 &&
          !fullContent.startsWith('No articles') &&
          !fullContent.startsWith('Content is loading');
        if (hasContent) {
          filtered = fullContent;
          console.log(`[NewsAI Filter] Method C: falling back to full content (${fullContent.length} chars)`);
        } else {
          filtered = `ఈ రోజు ${sec} వార్తలు అందుబాటులో లేవు. వెబ్‌సైట్ నుండి కంటెంట్ లోడ్ కాలేదు — దయచేసి పేజీని రిఫ్రెష్ చేయండి.`;
          console.warn(`[NewsAI Filter] ⚠️ No content at all. arts=${arts?.length} fullContent="${fullContent.slice(0,50)}"`);
        }
      }

      todayContent = filtered;
      const noContentSentence = currentLang === 'en'
        ? `No ${sec} news found in today's edition.`
        : `ఈ రోజు ${sec} వార్తలు కనుగొనలేదు.`;
      topicConstraint = `\n\n⚠️ STRICT: The user asked about "${sec}" ONLY. Respond ONLY about ${sec}. Do NOT list or mention any article about crime, murder, politics, court cases, international news, or any topic that is NOT ${sec}. If TODAY'S ARTICLES has no ${sec} content, write: "${noContentSentence}" and stop.`;
    }

    // Groq: trim if very long (small context window)
    if (provider === 'groq' && todayContent.length > 5000) {
      todayContent = todayContent.slice(0, 5000) + '\n[...more articles]';
    }

    const isEnglish = currentLang === 'en';
    const langRule = isEnglish
      ? 'RESPOND IN ENGLISH ONLY. TRANSLATE everything to English — including all article headlines, summaries, and section names from the Telugu content. Every single word of your response must be in English. Do NOT leave any Telugu script in your output.'
      : 'RESPOND IN TELUGU. Every word of your response must be in Telugu script. Only proper nouns (names, places) may stay in English letters.';
    // Language-aware closing line + "not found" text. Hardcoding Telugu here
    // caused English-mode replies to drift back into Telugu.
    const closingLine = isEnglish
      ? 'Ask me which story you would like the full details for.'
      : 'ఏ వార్త పూర్తి వివరాలు కావాలో అడగండి.';
    const notFoundLine = isEnglish
      ? "No [topic] news found in today's edition."
      : 'ఈ రోజు [topic] వార్తలు కనుగొనలేదు.';

    return `You are ${brand.name}, a newspaper AI assistant.

🔴 LANGUAGE OVERRIDE — HIGHEST PRIORITY: ${langRule}
This overrides every previous message in this conversation. Ignore the language used before. ${isEnglish ? 'Translate ALL Telugu text in TODAY\'S ARTICLES to English. Every word of your response must be English.' : 'Every word of your response must be Telugu script.'}

🔴 ANTI-HALLUCINATION — ABSOLUTE RULE:
- ONLY use information EXPLICITLY WRITTEN in TODAY'S ARTICLES below.
- Do NOT invent or generate specific numbers (live scores, prices, index levels, statistics) not written in TODAY'S ARTICLES. If relevant articles exist for the topic: show them using TIER 1 format. You may add one brief note that live real-time figures may not appear in today's print edition — only if the user specifically asked for a live number. Only say "ఈ వివరాలు ఈ రోజు పేపర్‌లో లేవు" if there are NO relevant articles at all.

STRICT RULES:
1. ONLY use information present in TODAY'S ARTICLES below. Never add facts from your training knowledge.
2. NEVER invent scores, statistics, player names, run counts, wickets, vote counts, prices, or any numbers not written in the article text below.
3. If the article body does not contain a specific fact, DO NOT write that fact. If asked for details not in the text, say (in the response language) that the details are not available.
4. No bullet points, no [1][2] numbers. Use **double asterisks** only to bold headlines as instructed below.
5. Never write the same sentence twice in a single response.
6. Complete your answer — do not stop mid-list. List EVERY article and finish fully. Never truncate.
7. NEVER include URLs, links, or web addresses in your response. URL fields are internal data only — do NOT print them.
8. NEVER include dates, timestamps, times, or "Updated on" text in your response — these are article metadata, not news content. Strip them out entirely.
9. NEVER include CMS datelines like "సాక్షి, X జిల్లా:" or any "PublicationName, PlaceName:" prefix. Strip them completely.

TWO-TIER RESPONSE MODE:

── TIER 1: Topic / domain / section query ──
Triggered when the user asks for news about ANY of these domains (in Telugu or English):
  Sports / క్రీడలు — cricket, football, badminton, kabaddi, boxing, tennis, IPL, T20, Olympics, match, tournament
  Cinema / సినిమా — movies, actors, OTT, Tollywood, Bollywood, trailers, songs, releases
  Politics / రాజకీయాలు — elections, parties, ministers, campaigns, assembly, parliament
  Telangana / తెలంగాణ — Hyderabad, Revanth, KTR, BRS, Warangal, Nizamabad, Karimnagar
  Andhra Pradesh / ఆంధ్రప్రదేశ్ — Amaravati, Vijayawada, Chandrababu, Jagan, Vizag, Tirupati
  National / జాతీయం — Modi, central govt, Delhi, Lok Sabha, Rajya Sabha, budget, union
  International / అంతర్జాతీయం — world news, USA, China, Russia, war, diplomacy, UN
  Business / వ్యాపారం — market, Sensex, economy, RBI, stocks, GST, budget, companies
  Agriculture / వ్యవసాయం — farmers, crops, rainfall, irrigation policy, seeds, fertilizer
  Education / విద్య — schools, colleges, exams, results, admissions, EAMCET, students
  Public Health / ఆరోగ్యం — hospitals, disease, doctors, vaccines, medicine, outbreak
  Crime & Police / నేరాలు — murders, arrests, fraud, robbery, police, court cases
  Technology / సాంకేతిక — cyber crime, AI, mobiles, apps, software, IT
  Courts / న్యాయస్థానం — High Court, Supreme Court, judgements, bail, hearings
  Railways / రైల్వే — trains, metro, IRCTC, rail accidents, new routes
  Aviation / విమానాలు — flights, airports, airlines, pilot, air routes
  Women / మహిళలు — women's issues, safety, schemes, SHGs, domestic violence
  Irrigation / నీటిపారుదల — dams, reservoirs, canals, water levels, floods, rivers
  Roads & Buildings / రహదారులు — highways, flyovers, bridges, potholes, construction
  Local Bodies / స్థానిక సంస్థలు — GHMC, municipality, panchayat, ward, mayor, councillor
  Lifestyle / జీవనశైలి — health tips, food, travel, beauty, fitness, fashion
  Public Administration / పరిపాలన — collectors, govt orders, welfare schemes, beneficiaries

For ANY of the above (or any variant/synonym the user types):
→ For EACH article in TODAY'S ARTICLES:
   • Write the Headline in bold: **Headline text** (wrap exactly in double asterisks).
   • On the next line: if a "Summary:" field is present, write its text — everything after "Summary: ". Do NOT write the word "Summary:" itself.
   • If Body says "[HEADLINE ONLY — DO NOT ADD ANY DESCRIPTION]": that is an INTERNAL TAG — NEVER print it. Write the bold **Headline** only, nothing else.
   • Leave a blank line between each article.
→ List ALL articles. End with exactly this sentence: "${closingLine}"
→ If TODAY'S ARTICLES is empty or says "వార్తలు అందుబాటులో లేవు": write "${notFoundLine}" and stop.

⛔ HALLUCINATION IS FORBIDDEN: Do not write any sentence that does not appear word-for-word in TODAY'S ARTICLES. Print summary text content verbatim, NEVER the "Summary:" label. NEVER print "[HEADLINE ONLY...]" — it is an internal marker, invisible to readers.

── TIER 2: Single article drill-down ──
User names or refers to a specific headline from the previous list, or asks "మొదటి వార్త వివరాలు" / "tell me more about X".
→ Find that article in TODAY'S ARTICLES.
→ Write 4–5 sentences using ONLY what the article Body says. Copy sentences from Body — do not rephrase.
→ If the user asks for more detail ("మరింత వివరంగా" / "elaborate" / "explain more"): write up to 8 sentences.
→ If the user asks for a brief ("short" / "సంక్షిప్తంగా"): write 2–3 sentences.
→ If Body is "[HEADLINE ONLY...]": say (in the response language) that only the headline is available and details are not.
→ If not found: one sentence (in the response language) saying it is not in today's edition.

── ALL NEWS query (ఈ రోజు వార్తలు / today's news / అన్ని వార్తలు) ──
→ List every article section by section. For each article: Headline (exact), then 1 sentence from Body if Body is available, nothing otherwise.
→ End with exactly this sentence: "${closingLine}"

TODAY'S ARTICLES:
${todayContent}

---
🔴 FINAL LANGUAGE REMINDER: ${langRule}
🔴 FINAL ANTI-HALLUCINATION REMINDER: Do NOT invent numbers (scores, prices, statistics) not in TODAY'S ARTICLES. If relevant articles exist for the topic, show them. Only say "not in paper" when NO relevant articles exist.
${topicConstraint}`;
  }

  // ─── Language switch ───────────────────────────────────────────────────────
  function switchLang(lang, el, wrapper, config) {
    currentLang = lang;
    try { sessionStorage.setItem('newsai_lang', lang); } catch (_) {}
    wrapper.querySelectorAll('.newsai-lang-btn').forEach(btn => {
      btn.classList.toggle('newsai-lang-active', btn.dataset.lang === lang);
    });
    el.input.placeholder = t('placeholder');
    if (recognition) recognition.lang = lang === 'te' ? 'te-IN' : 'en-IN';

    // Rebuild the welcome card in the new language (welcome text, digest, sample
    // cards, section chips) — but only while the welcome is what's on screen
    // (no conversation started yet). Otherwise just refresh the (hidden) chips,
    // which _injectSectionChips no-ops on when hidden.
    if (conversationHistory.length === 0 && chipsVisible && el.messages) {
      el.messages.innerHTML = '';
      renderWelcome(el, config);
    } else {
      _injectSectionChips(todaySections);
    }

    track('lang_switch', { lang });
  }

  // ─── Voice Input ──────────────────────────────────────────────────────────
  function initVoice(el) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      el.mic.classList.add('newsai-hidden');
      return;
    }

    recognition = new SpeechRec();
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = currentLang === 'te' ? 'te-IN' : 'en-IN';

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      el.input.value = transcript;
      el.send.disabled = false;
      stopListening(el);
      voiceInputActive = true; // flag so submitMessage auto-speaks the reply
      setTimeout(() => el.send.click(), 100);
    };

    recognition.onerror = () => stopListening(el);
    recognition.onend   = () => { if (isListening) stopListening(el); };

    // Silence timeout
    let silenceTimer;
    recognition.onsoundend = () => {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => { if (isListening) recognition.stop(); }, 2000);
    };

    el.mic.addEventListener('click', () => {
      // Podcast-style voice mode: a single tap toggles a hands-free conversation.
      if (voiceMode) { exitVoiceMode(); return; }
      // If a legacy push-to-talk session is somehow running, stop it first.
      if (isListening) { recognition.stop(); stopListening(el); return; }
      enterVoiceMode();
    });
  }

  // ─── Podcast-style continuous voice mode ──────────────────────────────────
  // Enters a full-panel "listening" overlay (like ChatGPT / Gemini voice):
  //   listen (continuous) → 1.5s silence auto-submits → AI answers with TTS →
  //   TTS ends → mic restarts. Tap ✕ or say "stop"/"ఆపు" to exit.
  function enterVoiceMode() {
    if (voiceMode) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition || !widgetEl) return;   // no speech support — silently ignore
    voiceMode = true;
    voiceProcessing = false;

    voiceModeEl = document.createElement('div');
    voiceModeEl.className = 'newsai-voice-overlay';
    voiceModeEl.innerHTML = `
      <div class="newsai-voice-inner">
        <div class="newsai-voice-bars">
          <span></span><span></span><span></span><span></span><span></span>
        </div>
        <div class="newsai-voice-text">
          <div class="newsai-voice-status" id="newsai-voice-status">Listening…</div>
          <div class="newsai-voice-transcript" id="newsai-voice-transcript"></div>
        </div>
        <button class="newsai-voice-exit" id="newsai-voice-exit" aria-label="Exit voice mode">✕</button>
      </div>
    `;
    // Append to the widget panel (scoped), falling back to body if not found.
    const panel = document.getElementById('newsai-panel');
    (panel || document.body).appendChild(voiceModeEl);
    const exitBtn = document.getElementById('newsai-voice-exit');
    if (exitBtn) exitBtn.onclick = exitVoiceMode;

    setVoiceStatus('listening');
    startVoiceListening();
  }

  function exitVoiceMode() {
    voiceMode = false;
    voiceProcessing = false;
    clearTimeout(voiceSilenceTimer);
    if (recognition) { try { recognition.stop(); } catch (_) {} }
    // Stop AI speech if playing — covers all TTS types (PCM, SSE, Web Speech)
    stopSpeaking();
    if (voiceModeEl) { try { voiceModeEl.remove(); } catch (_) {} voiceModeEl = null; }
    // Explicit reset point: drop the persisted session history when the user leaves voice mode.
    clearHistory();
  }

  // status: 'listening' | 'thinking' | 'speaking' | null
  function setVoiceStatus(status) {
    const statusEl = document.getElementById('newsai-voice-status');
    const labels = currentLang === 'te'
      ? { listening: 'వింటున్నాను…', thinking: 'ఆలోచిస్తున్నాను…', speaking: 'చెబుతున్నాను…' }
      : { listening: 'Listening…',   thinking: 'Thinking…',       speaking: 'Speaking…' };
    if (statusEl) statusEl.textContent = labels[status] || '';
    if (voiceModeEl) voiceModeEl.dataset.state = status || '';
  }

  function startVoiceListening() {
    if (!voiceMode) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { exitVoiceMode(); return; }

    // Capture in a local const so all handlers close over THIS specific instance (rec).
    // If the module-level `recognition` variable is used inside handlers, a second call to
    // startVoiceListening() re-assigns `recognition` to a new object — the OLD onend handler
    // then calls recognition.start() on the NEW (already-running) instance → InvalidStateError.
    const rec = new SpeechRecognition();
    recognition = rec;   // keep module-level ref in sync for exitVoiceMode / stopListening
    rec.lang = currentLang === 'te' ? 'te-IN' : 'en-IN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let finalTranscript = '';

    rec.onstart = () => { if (voiceMode && !voiceProcessing) setVoiceStatus('listening'); };

    rec.onresult = (e) => {
      // Barge-in: if the AI is somehow still speaking, stop it and listen.
      if (isSpeaking) {
        stopSpeaking();   // covers all TTS types (backend-pcm, backend, Web Speech)
        setVoiceStatus('listening');
      }

      let interim = '';
      let hasFinal = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const tr = e.results[i][0].transcript;
        if (e.results[i].isFinal) { finalTranscript += tr + ' '; hasFinal = true; }
        else interim += tr;
      }
      const display = (finalTranscript + interim).trim();
      const transcriptEl = document.getElementById('newsai-voice-transcript');
      if (transcriptEl) transcriptEl.textContent = display;
      if (widgetEl && widgetEl.input) widgetEl.input.value = display; // mirror into input box

      // Reset silence timer ONLY on final results.
      // Interim-only events (ambient noise misrecognised as speech) must NOT reset the
      // timer — otherwise background noise prevents auto-submit in noisy environments.
      if (hasFinal) {
        clearTimeout(voiceSilenceTimer);
        if (finalTranscript.trim()) {
          voiceSilenceTimer = setTimeout(() => {
            if (!voiceMode) return;
            const q = finalTranscript.trim();
            finalTranscript = '';
            if (transcriptEl) transcriptEl.textContent = '';
            // Spoken "stop" / "ఆపు" exits voice mode.
            if (/^(stop|exit|quit|ఆపు|ఆపండి|నిలిపివేయి)\.?$/i.test(q)) { exitVoiceMode(); return; }
            if (q) submitVoiceQuery(q);
          }, VOICE_SILENCE_MS);
        }
      }
    };

    rec.onend = () => {
      // Auto-restart unless we intentionally stopped (processing) or AI is speaking.
      // Uses `rec` (local), NOT `recognition` (module-level) — avoids the race where
      // a newer startVoiceListening() call has already replaced `recognition` with a
      // new instance and this stale handler would re-start the wrong object.
      if (voiceMode && !isSpeaking && !voiceProcessing) {
        setTimeout(() => {
          if (voiceMode && !isSpeaking && !voiceProcessing) { try { rec.start(); } catch (_) {} }
        }, 300);
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' && voiceMode && !voiceProcessing) {
        try { rec.start(); } catch (_) {}
      } else if (e.error !== 'aborted') {
        console.warn('[NewsAI Voice] Recognition error:', e.error);
      }
    };

    try { rec.start(); } catch (_) {}
  }

  async function submitVoiceQuery(query) {
    if (!voiceMode || !widgetEl || !widgetConfig) return;
    voiceProcessing = true;
    setVoiceStatus('thinking');
    // Stop the mic while the AI thinks + speaks (so it never transcribes its own voice).
    try { recognition.stop(); } catch (_) {}
    clearTimeout(voiceSilenceTimer);

    // Reuse the SAME pipeline the text input uses. voiceInputActive makes
    // submitMessage auto-speak the reply; the resetBtn hook in startSpeaking then
    // restarts listening once TTS finishes.
    widgetEl.input.value = query;
    widgetEl.send.disabled = false;
    voiceInputActive = true;
    try {
      await submitMessage(widgetEl, widgetConfig);
    } catch (err) {
      console.warn('[NewsAI Voice] Query error:', err && err.message);
    }

    // Fallback: if no TTS ever started (empty reply / speech unavailable / error),
    // resetBtn won't fire — resume listening here. Guarded by voiceProcessing so it
    // never double-starts once resetBtn has already restarted the mic.
    setTimeout(() => {
      if (voiceMode && voiceProcessing && !isSpeaking) {
        voiceProcessing = false;
        setVoiceStatus('listening');
        startVoiceListening();
      }
    }, 800);
  }

  // Singleton AudioContext for beeps — avoids creating a new context on every mic
  // start/stop, which would hit Chrome's ~6-context limit after ~3 voice turns.
  let _beepCtx = null;
  function _getBeepCtx() {
    if (!_beepCtx || _beepCtx.state === 'closed') {
      try { _beepCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
    }
    return _beepCtx;
  }
  function playBeep(freq = 660, duration = 120) {
    try {
      const ctx = _getBeepCtx();
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
      osc.start(); osc.stop(ctx.currentTime + duration / 1000);
    } catch (_) {}
  }

  function showListeningBanner(el, show) {
    let banner = document.getElementById('newsai-listening-banner');
    if (show) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'newsai-listening-banner';
        banner.style.cssText = `
          position:absolute; bottom:130px; left:50%; transform:translateX(-50%);
          background:var(--newsai-primary,#C0392B); color:#fff; padding:6px 16px; border-radius:20px;
          font-size:12px; font-weight:600; white-space:nowrap;
          box-shadow:0 2px 8px rgba(0,0,0,0.2); z-index:99;
          animation: newsai-fadein 0.2s ease;
        `;
        el.panel.appendChild(banner);
      }
      banner.textContent = currentLang === 'te' ? '🎙 వింటున్నాను...' : '🎙 Listening...';
    } else {
      if (banner) banner.remove();
    }
  }

  function startListening(el) {
    if (!recognition) return;
    isListening = true;
    el.mic.classList.add('newsai-listening');
    el.input.placeholder = t('listening');
    el.input.style.borderColor = 'var(--newsai-primary,#C0392B)';
    showListeningBanner(el, true);
    playBeep(660, 120);   // high beep = start
    recognition.lang = currentLang === 'te' ? 'te-IN' : 'en-IN';
    try { recognition.start(); } catch (_) { stopListening(el); }
  }

  function stopListening(el) {
    isListening = false;
    el.mic.classList.remove('newsai-listening');
    el.input.placeholder = t('placeholder');
    el.input.style.borderColor = '';
    showListeningBanner(el, false);
    playBeep(440, 100);   // low beep = stop
  }

  // ─── Voice Output ─────────────────────────────────────────────────────────
  function makeSpeakBtn(text) {
    return `<button class="newsai-speak-btn" data-text="${escAttr(text)}" aria-label="Read aloud" title="Read aloud">
      ${ICONS.speaker}
    </button>`;
  }

  function wireSpeak(msgEl) {
    const btn = msgEl.querySelector('.newsai-speak-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const text = btn.dataset.text;
      if (isSpeaking && speakingMsgEl === btn) {
        stopSpeaking();
      } else {
        stopSpeaking();
        startSpeaking(btn, text);
      }
    });
  }

  // ─── Copy button ──────────────────────────────────────────────────────────
  function wireCopy(msgEl) {
    const btn = msgEl.querySelector('.newsai-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      // Prefer raw markdown stored in data-text — strip ** markers but keep \n separators
      // so each article line pastes on its own line. bubble.textContent is layout-unaware
      // and collapses block-element newlines, producing joined text on paste.
      const rawMd = btn.dataset.text;
      let text;
      if (rawMd) {
        text = rawMd
          .replace(/\*\*([^*\n]+)\*\*/g, '$1')
          .replace(/\[HEADLINE ONLY[^\]]*\]/gi, '')
          .replace(/ ?[—–] ?\(same as headline[^)]*\)/gi, '')
          .replace(/ ?[—–] ?\(not available\)/gi, '')
          .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      } else {
        const bubble = msgEl.querySelector('.newsai-bubble');
        text = bubble ? (bubble.innerText || bubble.textContent || '').trim() : '';
      }
      if (!text) return;

      const markCopied = () => {
        btn.innerHTML = ICONS.check;
        btn.classList.add('newsai-copy-btn--copied');
        setTimeout(() => {
          btn.innerHTML = ICONS.copy;
          btn.classList.remove('newsai-copy-btn--copied');
        }, 1500);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(markCopied).catch(() => fallbackCopy(text, markCopied));
      } else {
        fallbackCopy(text, markCopied);
      }
    });
  }

  // ─── DOM fallback for article links ──────────────────────────────────────
  // Used when backend is down/slow: keyword-matches user query against DOM-scraped
  // window.NewsAI.articles and returns top 3 as { url, title } for injectArticleLinks.
  function domFallbackArticles(userQuery, domArticles) {
    if (!domArticles || !domArticles.length || !userQuery) return null;
    const qWords = userQuery.toLowerCase().replace(/[^\wఀ-౿\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    if (!qWords.length) return null;

    const scored = domArticles.map(a => {
      const text = ((a.headline || a.title || '') + ' ' + (a.summary || '') + ' ' + (a.section || '')).toLowerCase();
      const score = qWords.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
      return { url: a.url, title: a.headline || a.title || '', score };
    }).filter(a => a.url && /^https?:\/\//i.test(a.url) && a.score > 0);

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 3);
    return top.length ? top : null;
  }

  // ─── Read full article links ──────────────────────────────────────────────
  function truncateTitle(title, maxLen) {
    if (!title) return '';
    return title.length > maxLen ? title.slice(0, maxLen).trim() + '…' : title;
  }

  // Returns true when the AI response is a "not in today's paper" refusal.
  // In that case, showing article links below is contradictory — suppress them.
  function isNoInfoReply(text) {
    if (!text) return false;
    return text.includes('ఈ వివరాలు ఈ రోజు పేపర్‌లో లేవు') ||
           text.includes('not in today\'s paper') ||
           text.includes('not in today\'s edition') ||
           text.includes('This information is not in today') ||
           text.includes('not available in today');
  }

  function injectArticleLinks(msgEl, articles) {
    if (!articles || !articles.length) return;
    const valid = articles.filter(a => a.url && /^https?:\/\//i.test(a.url));
    if (!valid.length) return;

    const container = document.createElement('div');
    container.className = 'newsai-article-links';

    if (valid.length === 1) {
      container.innerHTML =
        '<a class="newsai-article-link newsai-article-link--single" href="' + escAttr(valid[0].url) +
        '" target="_blank" rel="noopener noreferrer">📰 Read full article →</a>';
    } else {
      container.innerHTML = valid.map(a =>
        '<a class="newsai-article-link" href="' + escAttr(a.url) +
        '" target="_blank" rel="noopener noreferrer">📰 ' +
        escHtml(truncateTitle(a.title, 55)) + ' →</a>'
      ).join('');
    }

    // Track article link clicks
    container.querySelectorAll('.newsai-article-link').forEach(link => {
      link.addEventListener('click', () => track('article_click', { url: link.href }));
    });

    // Thumbnails are now handled by renderImageStrip() (driven by lastArticleMeta),
    // appended separately below the bubble — so we don't duplicate images here.
    msgEl.appendChild(container);
  }

  // ─── Image strip (Task 4) ─────────────────────────────────────────────────
  // Horizontal strip of small image cards (thumbnail + truncated title) appended
  // below a bot bubble. Driven by lastArticleMeta populated from the SSE 'meta'
  // event (or fetchBackendContext in the direct-API fallback path).
  function renderImageStrip(msgEl, meta) {
    if (!msgEl || !Array.isArray(meta)) return;
    // Skip articles with empty/falsy imageUrl
    const withImages = meta
      .filter(a => a && a.imageUrl && /^https?:\/\//i.test(a.imageUrl))
      .slice(0, 5);
    if (withImages.length === 0) return;                     // only show if ≥1 image
    if (msgEl.querySelector('.newsai-image-strip')) return;  // never inject twice

    const strip = document.createElement('div');
    strip.className = 'newsai-image-strip';
    strip.innerHTML = withImages.map(a => {
      const href  = /^https?:\/\//i.test(a.url || '') ? escAttr(a.url) : '#';
      const title = a.title
        ? '<div class="newsai-img-card-title">' + escHtml(truncateTitle(a.title, 60)) + '</div>'
        : '';
      return '<a href="' + href + '" target="_blank" rel="noopener" class="newsai-img-card">' +
               '<img src="' + escAttr(a.imageUrl) + '" alt="" loading="lazy" ' +
               'onerror="this.closest(\'.newsai-img-card\').remove()">' +
               title +
             '</a>';
    }).join('');
    strip.querySelectorAll('.newsai-img-card').forEach(card => {
      card.addEventListener('click', () => track('article_click', { url: card.href }));
    });
    msgEl.appendChild(strip);
  }

  // ─── Stream-drop retry indicator (Task 2) ─────────────────────────────────
  // Appended to a bot bubble when the SSE stream ended without [DONE]. Offers a
  // one-click retry that re-sends the last user message.
  function appendRetryIndicator(streamedEl, el, config) {
    if (!streamedEl || streamedEl.querySelector('.newsai-retry-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'newsai-retry-wrap';
    const warn = document.createElement('span');
    warn.className = 'newsai-retry-warn';
    warn.textContent = currentLang === 'te' ? '⚠ కనెక్షన్ కోల్పోయింది. ' : '⚠ Connection lost. ';
    const btn = document.createElement('button');
    btn.className = 'newsai-retry-btn';
    btn.type = 'button';
    btn.textContent = currentLang === 'te' ? '↺ మళ్ళీ' : '↺ Retry';
    btn.addEventListener('click', () => {
      wrap.remove();
      // Keep history consistent: drop the half-streamed assistant entry, then re-send the
      // last user message (popping it too so submitMessage re-adds it exactly once).
      if (conversationHistory.length && conversationHistory[conversationHistory.length - 1].role === 'assistant') {
        conversationHistory.pop();
      }
      let lastUserText = '';
      if (conversationHistory.length && conversationHistory[conversationHistory.length - 1].role === 'user') {
        lastUserText = conversationHistory[conversationHistory.length - 1].content;
        conversationHistory.pop();
      } else {
        const lu = conversationHistory.filter(m => m.role === 'user').slice(-1)[0];
        lastUserText = lu ? lu.content : '';
      }
      saveSession();
      if (!lastUserText) return;
      el.input.value = lastUserText;
      el.send.disabled = false;
      submitMessage(el, config);
    });
    wrap.appendChild(warn);
    wrap.appendChild(btn);
    const bubble = streamedEl.querySelector('.newsai-bubble') || streamedEl;
    bubble.appendChild(wrap);
  }

  // ─── WhatsApp share button ────────────────────────────────────────────────
  function makeShareBtn(text) {
    return `<button class="newsai-share-btn" data-text="${escAttr(text)}" aria-label="Share on WhatsApp" title="Share on WhatsApp">${ICONS.whatsapp}</button>`;
  }

  function wireShare(msgEl) {
    const btn = msgEl.querySelector('.newsai-share-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const text = btn.dataset.text || msgEl.querySelector('.newsai-bubble')?.textContent?.trim() || '';
      if (!text) return;
      const url = 'https://wa.me/?text=' + encodeURIComponent(text);
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }

  function fallbackCopy(text, onDone) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      onDone();
    } catch (_) {}
  }

  // ── Telugu digit → word conversion (prevents Hindi TTS reading numbers in Hindi) ──
  function digitsToTeluguWords(text) {
    const ones  = ['సున్నా','ఒకటి','రెండు','మూడు','నాలుగు','అయిదు','ఆరు','ఏడు','ఎనిమిది','తొమ్మిది'];
    const teens = ['పది','పదకొండు','పన్నెండు','పదమూడు','పదునాలుగు','పదిహేను','పదహారు','పదిహేడు','పదెనిమిది','పంతొమ్మిది'];
    const tens  = ['','పది','ఇరవై','ముప్పై','నలభై','యాభై','అరవై','డెబ్బై','ఎనభై','తొంభై'];
    function nw(n) {
      if (n < 10)     return ones[n];
      if (n < 20)     return teens[n - 10];
      if (n < 100)    return tens[Math.floor(n/10)] + (n%10 ? ' ' + ones[n%10] : '');
      if (n < 1000)   return ones[Math.floor(n/100)] + ' వందలు' + (n%100 ? ' ' + nw(n%100) : '');
      if (n < 100000) { const t = Math.floor(n/1000);  return nw(t) + ' వేలు'  + (n%1000   ? ' '+nw(n%1000)   : ''); }
      if (n < 1e7)    { const l = Math.floor(n/100000);return nw(l) + ' లక్షలు'+ (n%100000 ? ' '+nw(n%100000): ''); }
      return String(n);
    }
    return text.replace(/\b(\d+)\b/g, (_, m) => { const n=parseInt(m,10); return isNaN(n)?m:nw(n); });
  }

  // Strip markdown and punctuation so TTS reads clean prose.
  // voiceLang: the lang of the voice that will actually speak (e.g. 'te-IN', 'hi-IN', 'en-IN').
  // digitsToTeluguWords() only applies when the voice IS a Telugu voice (te-IN/te-*).
  function cleanForSpeech(text, voiceLang) {
    const isTeluguCtx = (text.match(/[ఀ-౿]/g) || []).length > 2;
    const useTeluguDigits = isTeluguCtx && voiceLang && voiceLang.startsWith('te');
    let out = text
      .replace(/\[HEADLINE ONLY[^\]]*\]/gi, '')      // strip internal content marker
      .replace(/\[\d+\]/g, '')                       // [1] citation markers
      .replace(/▸|►|•|·|–|—/g, ' ')                  // bullets/dashes → pause
      .replace(/\*\*(.+?)\*\*/g, '$1')               // **bold**
      .replace(/\*(.+?)\*/g, '$1')                   // *italic*
      .replace(/^[\*\-]\s*/gm, '')                   // list dashes
      .replace(/`([^`]+)`/g, '$1')                   // `code`
      .replace(/#{1,6}\s/g, '')                      // ## headers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')       // [link](url)
      .replace(/https?:\/\/\S+/g, '')                // URLs
      .replace(/\.{2,}/g, '. ')                      // .. or ... → single pause
      .replace(/:/g, ', ')                            // colons → comma pause (not "colon")
      .replace(/;/g, ', ')                            // semicolons → comma pause
      .replace(/!/g, '. ')                            // ! → period (not "exclamation")
      .replace(/\n{3,}/g, '\n\n')                    // collapse excess blank lines
      // Abbreviation expansions
      .replace(/\bT[-\s]?20I?\b/gi, 'టీ ట్వెంటీ')
      .replace(/\bODI\b/gi, 'వన్ డే')
      .replace(/\bTest\s+match\b/gi, 'టెస్ట్ మ్యాచ్')
      .replace(/\bIPL\b/g, 'ఐపీఎల్').replace(/\bBCCI\b/g, 'బీసీసీఐ')
      .replace(/\bNDA\b/g, 'ఎన్డీఏ').replace(/\bUPA\b/g, 'యూపీఏ')
      .replace(/\bBJP\b/g, 'బీజేపీ').replace(/\bCM\b/g, 'సీఎం')
      .replace(/\bPM\b/g, 'పీఎం').replace(/\bMLA\b/g, 'ఎమ్మెల్యే')
      .replace(/\bMP\b/g, 'ఎంపీ').replace(/\bDGP\b/g, 'డీజీపీ')
      .replace(/\bSP\b/g, 'ఎస్పీ').replace(/\bCI\b/g, 'సీఐ')
      .replace(/\bkm\/h\b/gi, 'కిలోమీటర్ పర్ అవర్')
      .replace(/\bkmph\b/gi, 'కిలోమీటర్ పర్ అవర్')
      .replace(/\bkm\b/gi, 'కిలోమీటర్లు').replace(/\bkg\b/gi, 'కిలోగ్రాములు')
      .replace(/\brs\.?\s*/gi, 'రూపాయలు ').replace(/₹\s*/g, 'రూపాయలు ')
      .replace(/%/g, ' శాతం');

    if (isTeluguCtx) {
      // Sports fixture "X" → "వర్సస్" (e.g. "ఇంగ్లండ్ X ఆస్ట్రేలియా")
      out = out.replace(/\s+X\s+/g, ' వర్సస్ ');
      // Strip any remaining ** bold markers
      out = out.replace(/\*\*/g, ' ');
      // Digit-to-Telugu-word conversion ONLY for te-IN voice.
      // For hi-IN/en-IN fallback voices, digits stay as digits — they cannot read Telugu words.
      if (useTeluguDigits) out = digitsToTeluguWords(out);
      // Strip ALL remaining Western punctuation — voices read "," as "comma" etc.
      out = out.replace(/[,;:.!?\-।()'"""'']/g, ' ');
      out = out.replace(/\s{2,}/g, ' ');
    }

    return out.trim();
  }

  // ─── Voice Output ─────────────────────────────────────────────────────────
  // TTS tiers (in order of quality):
  //   Tier 1: Backend /api/tts — Sarvam Bulbul v3 (WAV output, emotion-aware pace).
  //           Telugu: anushka  |  English: vidya
  //           Used for BOTH languages — gives proper headline gaps + emotional prosody.
  //   Tier 2: Web Speech API — fallback when backend is unavailable.
  //
  // TTS tier availability — null=unchecked, true=working, false=skip this session
  let backendTtsAvailable    = null;
  let ttsBackendCooldownUntil = 0;  // epoch ms — backend TTS skipped until this time (429 recovery)

  // ── AudioWorklet PCM processor (inlined as Blob URL — widget is self-contained) ──
  // Loaded on first PCM stream use and cached; subsequent calls reuse the same URL.
  //
  // Why a ring-buffer worklet instead of scheduled AudioBufferSources:
  //   The SSE approach decodes each WAV chunk and schedules it via source.start(time).
  //   If a chunk's audio ends before the next AudioBuffer is decoded+scheduled, there's
  //   an audible micro-pause (silence gap). The worklet approach is fundamentally different:
  //   it runs at block rate (128 samples / ~5.8 ms), consuming from a FIFO queue that is
  //   continuously topped up by the HTTP binary stream. As long as the queue stays ahead
  //   of real-time — which 2-chunk lookahead synthesis guarantees — audio is seamless.
  const _NEWSAI_PCM_WORKLET = `
class NewsAiPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._q   = [];     // queue of Float32Array slices
    this._cur = null;   // slice currently being drained
    this._off = 0;      // read offset into _cur
    this._end = false;  // set when server stream is fully received
    this.port.onmessage = ({ data }) => {
      if (data.t === 'p') this._q.push(data.s);         // push PCM samples
      else if (data.t === 'e') this._end = true;         // stream ended
    };
  }
  process(inputs, outputs) {
    const ch = outputs[0][0];
    if (!ch) return true;
    let w = 0;
    while (w < ch.length) {
      // Refill _cur from queue head.
      if (!this._cur || this._off >= this._cur.length) {
        if (!this._q.length) { ch.fill(0, w); break; }  // underrun — output silence
        this._cur = this._q.shift();
        this._off = 0;
      }
      const n = Math.min(this._cur.length - this._off, ch.length - w);
      ch.set(this._cur.subarray(this._off, this._off + n), w);
      this._off += n; w += n;
    }
    // Terminate processor only when stream is done AND queue is fully drained.
    const drained = !this._q.length && (!this._cur || this._off >= this._cur.length);
    if (this._end && drained) { this.port.postMessage('done'); return false; }
    return true;
  }
}
registerProcessor('newsai-pcm', NewsAiPcmProcessor);
`;
  let _pcmWorkletUrl = null;  // cached blob URL — avoids re-creating the blob on every speak()

  // Light clean for neural TTS: strip markdown but KEEP punctuation (helps prosody)
  // Light clean for neural TTS: strip markdown but KEEP punctuation (helps prosody)
  // IMPORTANT: preserve newlines — backend uses them to detect headline lists and insert pauses.
  function stripMarkdownForTTS(text) {
    return text
      .replace(/\[HEADLINE ONLY[^\]]*\]/gi, '')  // strip internal content marker
      .replace(/\[\d+\]/g, '')
      .replace(/\*\*(.+?)\*\*/gs, '\n$1\n')  // each bold headline → its own line (prevents concatenation)
      .replace(/\*(.+?)\*/gs, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[▸►•·–—]/g, '')
      // Strip ALL invisible / zero-width characters — ZWSP, ZWNJ (U+200C), ZWJ (U+200D),
      // LRM/RLM, soft hyphen, BOM, line/paragraph separators. Sakshi's CMS embeds these
      // for Telugu ligature control; Sarvam's preprocessor stumbles on them and emits
      // noise (a spurious leading "dot"), or treats them as word breaks mid-word.
      .replace(/[\u200B-\u200F\u00AD\uFEFF\u2028\u2029]/g, '')
      // Convert danda (।) and double-danda (॥) → period — Sarvam reads these aloud as
      // "dot" instead of treating them as silent sentence-end pauses.
      .replace(/[।॥]/g, '.')
      // Horizontal ellipsis (… U+2026) is a SINGLE char — `\.{2,}` below never matched it,
      // and Sarvam speaks it as "dot dot dot". Normalise to a comma pause.
      .replace(/[…⋯᠁]/g, ',')
      // Normalize consecutive dots (.. or ...) — Sarvam treats them as sentence-end pauses.
      // Replace with a comma so intonation stays natural without a long gap.
      .replace(/\.{2,}/g, ',')
      // Separator / horizontal-rule lines are never speech.
      .replace(/^[ \t]*[-—–_=~]{2,}[ \t]*$/gm, '')
      // Collapse isolated punctuation runs (". . .") that Sarvam reads mark-by-mark.
      .replace(/(?:[.,;:]\s+){2,}[.,;:]?\s*/g, '. ')
      // Strip parenthetical photo/video annotations that appear in Sakshi headlines
      // e.g. "(చిత్రాలు)", "(వీడియో)", "(photos)", "(video)". These aren't news content.
      .replace(/\(\s*(?:చిత్రాలు|ఫోటోలు|ఫొటోలు|వీడియో|video|photos?|gallery)\s*\)/gi, '')
      // Remove curly / directional single quotes that Sarvam may pause on
      .replace(/['']/g, '')
      .replace(/[ \t]{2,}/g, ' ')       // collapse multiple spaces (NOT newlines)
      .replace(/\n{3,}/g, '\n\n')       // cap at double newline
      // Never open the utterance with punctuation — Sarvam vocalises it ("dot", "dash").
      .replace(/^[\s.,;:!?।॥…·•*_=~\-–—]+/, '')
      .trim();
  }

  // ⚡ Fast audio — trailing-silence trim for gapless chunk chaining.
  // Sarvam WAV chunks sometimes carry trailing digital silence; scheduling the NEXT
  // chunk at `startAt + audioBuf.duration` would then leave an audible gap. We instead
  // schedule against the audio's REAL end (last non-silent sample + a 5ms tail so the
  // waveform isn't hard-clipped), producing seamless back-to-back playback.
  function trimTrailingSilence(audioBuffer, threshold = 0.0005) {
    try {
      const data = audioBuffer.getChannelData(0);
      let endSample = data.length - 1;
      while (endSample > 0 && Math.abs(data[endSample]) < threshold) endSample--;
      // Keep a tiny 5ms tail to avoid a hard cutoff click.
      const keepSamples = Math.min(
        endSample + Math.floor(audioBuffer.sampleRate * 0.005),
        data.length
      );
      const trimmedDuration = keepSamples / audioBuffer.sampleRate;
      // Guard against pathological all-silence buffers → fall back to full duration.
      return trimmedDuration > 0.02 ? trimmedDuration : audioBuffer.duration;
    } catch (_) {
      return audioBuffer.duration;
    }
  }

  // ⚡ Fast audio — thin "audio loading" progress bar under a message.
  // Pure perceived-latency win: gives the user immediate feedback that audio is
  // coming while chunk 0 synthesises. Removed the instant real audio starts playing.
  function createTtsLoader(btn) {
    try {
      const msgEl = btn.closest('.newsai-msg');
      if (!msgEl) return null;
      const bar = document.createElement('div');
      bar.className = 'newsai-tts-loading';
      bar.innerHTML = '<div class="newsai-tts-loading-fill"></div>';
      msgEl.appendChild(bar);
      return bar;
    } catch (_) { return null; }
  }

  // Show a temporary non-blocking toast inside the chat panel (for TTS rate-limit notice)
  function _showTtsToast(seconds) {
    const panel = document.getElementById('newsai-panel');
    if (!panel) return;
    const existing = panel.querySelector('.newsai-tts-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'newsai-tts-toast';
    toast.textContent = currentLang === 'te'
      ? `🔊 Sarvam TTS ${seconds}s విరామం — స్వయంచాలకంగా పునఃప్రారంభమవుతుంది`
      : `🔊 Sarvam voice paused ${seconds}s (rate limit) — will resume automatically`;
    panel.appendChild(toast);
    setTimeout(() => toast.remove(), (seconds + 2) * 1000);
  }

  async function startSpeaking(btn, text) {
    // Guard: never call TTS with empty text — backend returns HTTP 400 which can
    // permanently disable backend TTS for the session if the error handler treats it as fatal.
    if (!text || !text.trim()) return;

    // Sanitise for spoken output BEFORE any TTS tier sees the text — strips
    // markdown, UI prompts, photo-gallery article lines, and cross-contaminated
    // headline echoes. Both the Sarvam backend path (stripMarkdownForTTS) and the
    // Web Speech fallback (cleanForSpeech) consume this cleaned text.
    text = prepareForTTS(text);
    if (!text.trim()) return;   // nothing speakable remained after sanitisation

    if (window.speechSynthesis) speechSynthesis.cancel();
    if (currentUtterance?._type === 'backend') { try { currentUtterance.stop(); } catch (_) {} }

    track('tts');
    isSpeaking = true;
    speakingMsgEl = btn;
    currentUtterance = null;
    btn.innerHTML = ICONS.speakerOff + ' <span style="font-size:10px">' + t('speakStop') + '</span>';
    btn.classList.add('newsai-speaking');

    const myGen = ++speakGen; // unique stamp for THIS startSpeaking call
    let   ttsLoaderEl = null; // ⚡ Fast audio — progress bar handle (see createTtsLoader)
    const removeTtsLoader = () => { if (ttsLoaderEl) { try { ttsLoaderEl.remove(); } catch (_) {} ttsLoaderEl = null; } };
    const resetBtn = () => {
      removeTtsLoader();
      btn.innerHTML = ICONS.speaker; btn.classList.remove('newsai-speaking');
      // Only clear global speaking state if this button is STILL the active speaker
      // AND no newer speak call has started (speakGen !== myGen means a newer call
      // already took over — clearing state here would race with and clobber it).
      if (speakingMsgEl !== btn || speakGen !== myGen) return;
      isSpeaking = false; speakingMsgEl = null; currentUtterance = null;
      // Podcast voice mode: AI finished speaking → resume listening automatically.
      if (voiceMode) {
        voiceProcessing = false;
        setVoiceStatus('listening');
        setTimeout(() => { if (voiceMode && !isSpeaking) startVoiceListening(); }, 400);
      }
    };

    // Language for TTS follows the active pill (currentLang), not text-content detection.
    // Pill = 'te' → Telugu backend TTS (Sarvam anushka) → Web Speech Telugu fallback.
    // Pill = 'en' → English backend TTS (Sarvam vidya) → Web Speech English fallback.
    const lang         = currentLang === 'en' ? 'en' : 'te';
    const isTeluguText = lang === 'te'; // kept for voice-selection logic below

    // Prepare text for backend TTS.
    // Strategy: extract short lines (headlines, ≤120 chars) first — these are the
    // most important content and the backend can add proper gaps between them.
    // If the extracted headlines alone fit within 2000 chars, send only headlines
    // (gives cleaner audio). Otherwise fall back to the first 2000 chars of full text.
    const neuralFull = stripMarkdownForTTS(text);
    const TTS_LIMIT = 4000;  // streaming starts playback after chunk 0, so longer text is fine
    let neuralText;
    if (neuralFull.length > TTS_LIMIT) {
      // For long responses (digest lists), extract HEADLINE-only lines.
      // After stripMarkdownForTTS, **Headline** becomes its own line and " — Description"
      // is a separate line starting with "—". We keep only the headline lines (not "—" lines)
      // and cap at 12 so we speak at most 12 headlines — one per article.
      // Old code used slice(0,6) on ALL short lines (headlines + descriptions mixed) which
      // gave only 3 headlines because 6 slots = 3 headlines + 3 descriptions.
      const allLines = neuralFull.split('\n').filter(l => l.trim().length > 0);
      const headlineLines = allLines.filter(l => {
        const t = l.trim();
        // Skip description lines (start with dash/em-dash) and very long lines
        return t.length <= 160 && !t.startsWith('—') && !t.startsWith('-') && !t.startsWith('•');
      }).slice(0, 12);  // at most 12 headlines
      const headlinesOnly = headlineLines.join('\n');
      if (headlinesOnly.length >= 30) {
        if (headlinesOnly.length > TTS_LIMIT) {
          // Guard: cap within TTS_LIMIT at a newline boundary
          const cut = headlinesOnly.lastIndexOf('\n', TTS_LIMIT);
          neuralText = headlinesOnly.slice(0, cut > 0 ? cut : TTS_LIMIT);
        } else {
          neuralText = headlinesOnly;
        }
      } else {
        const cut = neuralFull.lastIndexOf(' ', TTS_LIMIT);
        neuralText = neuralFull.slice(0, cut > 0 ? cut : TTS_LIMIT);
      }
    } else {
      neuralText = neuralFull;
    }

    // Guard: if stripping markdown left us with nothing, bail — don't send a 400.
    if (!neuralText || !neuralText.trim()) { resetBtn(); return; }

    // ── Tier 1a: /api/tts/stream-binary — AudioWorklet PCM ring buffer ──────────
    // AudioContext MUST be created synchronously inside a user-gesture handler.
    // We do it here (before any await) so Chrome/Safari grant autoplay permission.
    //
    // Why this is better than the SSE approach:
    //   SSE: decode WAV → schedule AudioBufferSource at a future timestamp → gaps if
    //        the next chunk isn't decoded in time.
    //   Binary PCM: Int16 bytes arrive → ÷32768 → pushed into an AudioWorklet FIFO.
    //   The worklet drains the FIFO at block rate (128 samples / ~5.8 ms). As long as
    //   the queue stays non-empty — guaranteed by 2-chunk lookahead synthesis — audio
    //   is gapless. No WAV decode, no base64, no scheduling.
    if (backendTtsAvailable !== false && Date.now() >= ttsBackendCooldownUntil
        && typeof AudioWorkletNode !== 'undefined') {

      let _pcmAudioCtx;
      let _pcmHandled = false;

      try {
        _pcmAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });
        if (_pcmAudioCtx.state === 'suspended') await _pcmAudioCtx.resume();

        // Load worklet from cached blob URL (created once, reused every speak call).
        if (!_pcmWorkletUrl) {
          const blob = new Blob([_NEWSAI_PCM_WORKLET], { type: 'application/javascript' });
          _pcmWorkletUrl = URL.createObjectURL(blob);
        }
        await _pcmAudioCtx.audioWorklet.addModule(_pcmWorkletUrl);

        const worklet = new AudioWorkletNode(_pcmAudioCtx, 'newsai-pcm', { outputChannelCount: [1] });
        const gain    = _pcmAudioCtx.createGain();
        worklet.connect(gain);
        gain.connect(_pcmAudioCtx.destination);

        const _pcmAbort = new AbortController();
        currentUtterance = {
          _type: 'backend-pcm',
          stop: () => {
            try { _pcmAbort.abort(); } catch (_) {}
            try {
              if (_pcmAudioCtx && _pcmAudioCtx.state !== 'closed') {
                gain.gain.setValueAtTime(gain.gain.value, _pcmAudioCtx.currentTime);
                gain.gain.linearRampToValueAtTime(0.0001, _pcmAudioCtx.currentTime + 0.08);
              }
            } catch (_) {}
            setTimeout(() => { if (_pcmAudioCtx && _pcmAudioCtx.state !== 'closed') try { _pcmAudioCtx.close(); } catch (_) {} }, 130);
          },
        };

        // worklet sends 'done' when it has drained the last sample → reset button.
        worklet.port.onmessage = (e) => {
          if (e.data === 'done') {
            if (_pcmAudioCtx && _pcmAudioCtx.state !== 'closed') try { _pcmAudioCtx.close(); } catch (_) {}
            resetBtn();
          }
        };

        console.log(`[NewsAI TTS] Binary PCM request (${lang}, ${neuralText.length} chars)…`);
        ttsLoaderEl = createTtsLoader(btn);

        const resp = await fetch(`${backendBaseUrl}/api/tts/stream-binary`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: neuralText, lang, voice: (widgetConfig && widgetConfig.ttsVoice) || undefined }),
          signal:  _pcmAbort.signal,
        });

        if (resp.status === 429) {
          ttsBackendCooldownUntil = Date.now() + 60_000;
          _showTtsToast(60);
          throw new Error('429');
        }
        if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
        backendTtsAvailable = true;

        const reader     = resp.body.getReader();
        let leftover     = new Uint8Array(0);
        let firstData    = true;
        let totalSamples = 0;
        const streamStart = Date.now();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (speakingMsgEl !== btn) { reader.cancel(); break; } // superseded

          // Merge with any leftover bytes from previous read.
          const merged   = new Uint8Array(leftover.length + value.length);
          merged.set(leftover);
          merged.set(value, leftover.length);

          // Must process an even number of bytes (16-bit samples = 2 bytes each).
          const complete = merged.length - (merged.length % 2);
          if (complete > 0) {
            const int16   = new Int16Array(merged.buffer, 0, complete >>> 1);
            const float32 = new Float32Array(int16.length);
            for (let k = 0; k < int16.length; k++) float32[k] = int16[k] / 32768.0;
            // Transfer ownership (zero-copy) to the AudioWorklet thread.
            worklet.port.postMessage({ t: 'p', s: float32 }, [float32.buffer]);
            totalSamples += int16.length;

            if (firstData) {
              removeTtsLoader();
              firstData = false;
              console.log(`[NewsAI TTS] ✅ PCM stream playing (${lang})`);
            }
          }
          leftover = (complete < merged.length) ? merged.slice(complete) : new Uint8Array(0);
        }

        // Signal the worklet that no more samples are coming.
        worklet.port.postMessage({ t: 'e' });
        _pcmHandled = true;

        // Safety reset in case the worklet's 'done' message never fires
        // (e.g. if the stream ended early / all chunks errored on the server).
        // Use the higher of: computed sample duration OR wall-clock streaming time,
        // so that chunk-error scenarios (where totalSamples underestimates the
        // actual audio the user hears) still wait long enough before resetting.
        const sampleDurMs    = (totalSamples / 22050) * 1000;
        const streamElapsedMs = Date.now() - streamStart;
        const estMs = Math.max(4000, Math.max(sampleDurMs, streamElapsedMs) + 2000);
        setTimeout(() => { if (isSpeaking && speakingMsgEl === btn) resetBtn(); }, estMs);

      } catch (err) {
        removeTtsLoader();
        if (_pcmAudioCtx && _pcmAudioCtx.state !== 'closed') try { _pcmAudioCtx.close(); } catch (_) {}
        if (err.name === 'AbortError') return;  // user stopped — don't start SSE either
        if (String(err.message) !== '429') {
          // Any non-429 error: log and fall through to SSE.
          console.warn('[NewsAI TTS PCM] Falling through to SSE:', err.message);
          // If the AudioWorklet module load itself failed (CSP blocking blob: URLs, old browser),
          // revoke and clear the cached URL so the next speak() recreates a fresh blob
          // rather than re-attempting a URL that the browser has already rejected.
          // Also fires when the page CSP (e.g. Sakshi.com) blocks blob: scripts —
          // matches DOMException messages like "Failed to load", "ContentSecurityPolicy", etc.
          if ((/worklet|module|blob|csp|content.?security|policy|failed to load/i.test(err.message) || err instanceof DOMException) && _pcmWorkletUrl) {
            try { URL.revokeObjectURL(_pcmWorkletUrl); } catch (_) {}
            _pcmWorkletUrl = null;
          }
        }
        // 429: cooldown already set; SSE check below also sees it → falls to Web Speech
      }

      if (_pcmHandled) return; // PCM success → audio handled, skip SSE
    }

    // ── Tier 1b: Backend /api/tts/stream (SSE, WAV chunks) ─────────────────────
    // Fallback when AudioWorklet is unavailable (old Safari, CSP that blocks blob: URLs).
    // AudioContext is created SYNCHRONOUSLY here (inside the user-gesture handler)
    // so Chrome/Safari grant autoplay permission before any async work starts.
    // Each WAV chunk is decoded and scheduled via source.start(time) for gapless chain.
    if (backendTtsAvailable !== false && Date.now() >= ttsBackendCooldownUntil) {
      let audioCtx;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
      } catch (_) { audioCtx = null; }

      if (audioCtx) {
        const abortCtrl   = new AbortController();
        const activeSrcs  = [];   // track all AudioBufferSources so stop() can halt them
        let   nextStart   = 0;    // audioCtx-time cursor — updated per chunk

        currentUtterance = {
          _type: 'backend',
          stop: () => {
            try { abortCtrl.abort(); } catch (_) {}
            for (const s of activeSrcs) { try { s.stop(); } catch (_) {} }
            if (audioCtx && audioCtx.state !== 'closed') try { audioCtx.close(); } catch (_) {}
          },
        };

        try {
          console.log(`[NewsAI TTS] Streaming request (${lang}, ${neuralText.length} chars)...`);
          // ⚡ Fast audio — show the "audio loading" bar the moment we ask for audio.
          ttsLoaderEl = createTtsLoader(btn);
          let expectedChunks = 0; // populated from the 'meta' event
          const resp = await fetch(`${backendBaseUrl}/api/tts/stream`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ text: neuralText, lang, voice: (widgetConfig && widgetConfig.ttsVoice) || undefined }),
            signal:  abortCtrl.signal,
          });

          if (resp.status === 429) {
            // Rate limited — cooldown 60s then auto-recover (not a permanent failure)
            const cooldownMs = 60 * 1000;
            ttsBackendCooldownUntil = Date.now() + cooldownMs;
            _showTtsToast(60);
            throw new Error('HTTP 429');
          }
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          backendTtsAvailable = true;

          // Guard: resp.body is null in some environments (very old browsers, opaque responses)
          if (!resp.body) throw new Error('SSE stream unavailable');
          const reader    = resp.body.getReader();
          const decoder    = new TextDecoder();
          let   sseBuf     = '';
          let   chunkIdx   = 0;
          let   lastSrc    = null;
          let   superseded = false; // set when a newer speak takes over mid-stream

          outer: while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (speakingMsgEl !== btn) { superseded = true; reader.cancel(); break; } // newer speak took over

            sseBuf += decoder.decode(value, { stream: true });
            const parts = sseBuf.split('\n\n');
            sseBuf = parts.pop(); // last entry may be an incomplete SSE frame

            for (const part of parts) {
              const line = part.trim();
              if (!line.startsWith('data: ')) continue;
              let ev;
              try { ev = JSON.parse(line.slice(6)); } catch { continue; }

              if (ev.type === 'meta') {
                // ⚡ Fast audio — how many chunks to expect, for the progress bar.
                expectedChunks = ev.total || 0;

              } else if (ev.type === 'chunk' && ev.audio) {
                // ⚡ Fast audio — advance the loading bar as each chunk lands.
                if (ttsLoaderEl && expectedChunks > 0) {
                  const pct = Math.min(100, Math.round(((ev.chunk + 1) / expectedChunks) * 100));
                  const fill = ttsLoaderEl.firstChild;
                  if (fill) { fill.style.width = pct + '%'; ttsLoaderEl.classList.add('newsai-tts-loading-active'); }
                }
                // base64 WAV → Uint8Array → ArrayBuffer copy (slice avoids detach issues)
                const bin   = atob(ev.audio);
                const bytes = new Uint8Array(bin.length);
                for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);

                try {
                  const audioBuf = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
                  if (speakingMsgEl !== btn) { superseded = true; break outer; } // superseded during decode

                  const src      = audioCtx.createBufferSource();
                  src.buffer     = audioBuf;
                  // GainNode per chunk — lets us apply a short fade-out ramp at the
                  // end of each chunk's scheduled window. Without this, hard-cutting
                  // from a non-zero PCM sample to silence causes an audible click/pop
                  // at the inter-chunk boundary in the AudioContext timeline.
                  const gainNode = audioCtx.createGain();
                  src.connect(gainNode);
                  gainNode.connect(audioCtx.destination);
                  activeSrcs.push(src);

                  // First chunk: play 20ms from now (buffer for decode jitter).
                  // Subsequent: chain immediately after the previous chunk ends.
                  // ⚡ Fast audio — schedule against the trimmed (silence-free) duration
                  // so chunks butt up seamlessly instead of leaving a trailing-silence gap.
                  const playDur = trimTrailingSilence(audioBuf);
                  const startAt = chunkIdx === 0
                    ? audioCtx.currentTime + 0.02
                    : Math.max(nextStart, audioCtx.currentTime + 0.01);
                  src.start(startAt);
                  // Schedule a 10ms gain ramp to silence at the very end of this chunk.
                  // This removes the hard waveform discontinuity at the chunk boundary.
                  const fadeOutAt = startAt + playDur - 0.010;
                  gainNode.gain.setValueAtTime(1.0, Math.max(startAt, fadeOutAt));
                  gainNode.gain.linearRampToValueAtTime(0.0001, startAt + playDur);
                  nextStart = startAt + playDur;
                  lastSrc   = src;
                  chunkIdx++;

                  if (chunkIdx === 1) {
                    // Real audio is now playing — drop the loading bar immediately.
                    removeTtsLoader();
                    console.log(`[NewsAI TTS] ✅ Streaming TTS playing (${lang})`);
                  }
                } catch (e) {
                  console.warn('[NewsAI TTS] Chunk decode error:', e);
                }

              } else if (ev.type === 'done') {
                // All chunks streamed — wire resetBtn to the last scheduled source
                if (lastSrc) {
                  lastSrc.onended = () => { if (audioCtx && audioCtx.state !== 'closed') try { audioCtx.close(); } catch (_) {} resetBtn(); };
                } else {
                  resetBtn(); // nothing decoded (empty response)
                }
              } else if (ev.type === 'error') {
                console.warn(`[NewsAI TTS] Server chunk error: ${ev.message}`);
              }
            }
          }

          // Post-stream cleanup:
          removeTtsLoader(); // ⚡ Fast audio — bar never outlives the stream
          if (lastSrc) {
            // At least one chunk decoded and started — audio is/was playing.
            // Wire resetBtn to the last chunk's onended (in case 'done' event didn't arrive).
            if (!lastSrc.onended) {
              lastSrc.onended = () => { if (audioCtx && audioCtx.state !== 'closed') try { audioCtx.close(); } catch (_) {} resetBtn(); };
            }
            return; // audio handled — skip Web Speech
          }
          // No audio decoded: either superseded (newer speak took over) or Sarvam failed all chunks.
          if (audioCtx && audioCtx.state !== 'closed') try { audioCtx.close(); } catch (_) {}
          if (superseded) return; // newer speak owns this button — do NOT start Web Speech for old btn
          // ALL chunks errored from Sarvam — fall through to Web Speech API as last resort
          console.warn('[NewsAI TTS] All Sarvam chunks failed — falling back to Web Speech');

        } catch (e) {
          removeTtsLoader(); // ⚡ Fast audio — clear bar on any streaming failure
          if (e.name === 'AbortError') { resetBtn(); return; } // user pressed stop
          console.warn('[NewsAI TTS] Streaming failed, falling back to Web Speech:', e.message);
          if (audioCtx && audioCtx.state !== 'closed') try { audioCtx.close(); } catch (_) {}
          // 429: cooldown already set — don't permanently disable
          if (/HTTP \d/.test(e.message) && e.message !== 'HTTP 429') backendTtsAvailable = false;
        }
        // Non-AbortError failure: fall through to Web Speech API below
      } // closes if (audioCtx)
    } // closes if (backendTtsAvailable !== false)

    // ── Tier 2: Web Speech API fallback ──────────────────────────────────────
    // Superseded while awaiting the backend fetch — a newer speak owns playback now.
    if (speakingMsgEl !== btn) return;
    if (!window.speechSynthesis) { resetBtn(); return; }

    const voices = cachedVoices.length ? cachedVoices : speechSynthesis.getVoices();
    let voice;
    if (isTeluguText) {
      // hi-IN intentionally excluded — Hindi voice reads only digits, silences Telugu script.
      voice = voices.find(v => v.lang === 'te-IN')
           || voices.find(v => v.lang.startsWith('te'))
           || voices.find(v => v.lang === 'en-IN')
           || voices.find(v => v.lang === 'en-US')
           || voices.find(v => v.lang.startsWith('en'))
           || voices[0] || null;
    } else {
      voice = voices.find(v => v.lang === 'en-IN')
           || voices.find(v => v.lang === 'en-US')
           || voices.find(v => v.lang.startsWith('en'))
           || voices[0] || null;
    }

    const uttLang  = voice ? voice.lang : (isTeluguText ? 'te-IN' : 'en-IN');

    // If Telugu text but only an English voice is available, Web Speech will skip Telugu
    // script and read only numbers/English — show a notice instead of reading garbage.
    if (isTeluguText && voice && !voice.lang.startsWith('te') && !voice.lang.startsWith('hi')) {
      const toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;bottom:110px;left:50%;transform:translateX(-50%);background:#444;color:#fff;padding:7px 16px;border-radius:20px;font-size:12px;z-index:999999;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
      toast.textContent = t('teVoiceFallback');
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3500);
      resetBtn();
      return;
    }

    const cleanText = cleanForSpeech(text, uttLang).trim();
    if (!cleanText) { resetBtn(); return; }

    const utterance    = new SpeechSynthesisUtterance(cleanText);
    utterance.lang     = uttLang;
    if (voice) utterance.voice = voice;
    utterance.rate     = 1.05;  // natural news-anchor pace
    utterance.onend    = resetBtn;
    utterance.onerror  = (e) => {
      if (e.error !== 'interrupted') console.warn('[NewsAI TTS] Web Speech error:', e.error);
      resetBtn();
    };

    currentUtterance = { _type: 'webspeech', utterance };
    speechSynthesis.speak(utterance);
    console.log(`[NewsAI TTS] Web Speech fallback (${uttLang}, voice: ${voice ? voice.name : 'default'}, len: ${cleanText.length})`);
  }

  function stopSpeaking() {
    liveTtsGen++;           // cancel any in-progress drainLiveTts loop
    if (currentUtterance) {
      // Use .stop() for any backend TTS path (backend-pcm, backend, etc.)
      if (typeof currentUtterance.stop === 'function') {
        currentUtterance.stop();
      } else if (window.speechSynthesis) {
        speechSynthesis.cancel();
      }
    } else if (window.speechSynthesis) {
      speechSynthesis.cancel();
    }
    isSpeaking = false;
    if (speakingMsgEl) {
      speakingMsgEl.innerHTML = ICONS.speaker;
      speakingMsgEl.classList.remove('newsai-speaking');
    }
    speakingMsgEl = null;
    currentUtterance = null;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────
  function scrollToBottom(el) {
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }

  function timeStr() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\n/g, '<br>');
  }

  function escAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Render bot response text as safe HTML with clickable links.
   * Extracts URLs before escaping so they survive HTML entity conversion.
   */
  function renderBotText(text) {
    // Strip internal content markers — AI sometimes echoes these despite prompt instructions
    text = text.replace(/\[HEADLINE ONLY[^\]]*\]/g, '').replace(/\[ *HEADLINE ONLY[^\]]*\]/gi, '');
    // Strip buildArticleContext internal markers that Gemini occasionally echoes
    text = text.replace(/ ?[—–] ?\(same as headline[^)]*\)/gi, '');
    text = text.replace(/\(same as headline[^)]*\)/gi, '');
    text = text.replace(/ ?[—–] ?\(not available\)/gi, '');
    text = text.replace(/\(not available\)/gi, '');
    // Strip Gemini headline echo: **X** — X (description is a normalized copy of the headline).
    // Happens when Gemini ignores Rule 5 and repeats the headline as its own description.
    text = text.replace(/\*\*([^*\n]+)\*\*\s*[—–]\s*([^\n*]{5,})/g, (match, headline, desc) => {
      const norm = s => s.replace(/[\u200B-\u200F\u00AD\uFEFF\u2028\u2029]/g, '').replace(/[.!?\u2026]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
      return norm(desc) === norm(headline) ? `**${headline}**` : match;
    });
    // Strip headline-tail repetition: Telugu cinema headlines often end with a person's
    // name ("Quote: Actor Name") and Gemini starts the description with that same name
    // ("Actor Name says X…"). Remove the repeated tail words so the description is fresh.
    text = text.replace(/\*\*([^*\n]+)\*\*\s*[—–]\s*([^\n*]{5,})/g, (match, headline, desc) => {
      const nw = s => s.replace(/[^\w\sఀ-౿]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      const headWords = nw(headline).split(' ').filter(Boolean);
      const descWords = desc.trim().split(/\s+/);
      const descNorm = nw(desc);
      // Check ALL contiguous word sequences of length 2-5 from the headline
      // (not just the tail) — catches "సల్మాన్ ఖాన్" appearing mid-headline while
      // the body starts with that same name.
      for (let i = 0; i <= headWords.length - 2; i++) {
        for (let n = Math.min(5, headWords.length - i); n >= 2; n--) {
          const seq = headWords.slice(i, i + n).join(' ');
          if (seq.length < 5) continue;
          if (descNorm.startsWith(seq)) {
            const rest = descWords.slice(n).join(' ').replace(/^[\s:,.।—\-–]+/, '').trim();
            if (rest.length >= 15) return `**${headline}** — ${rest}`;
          }
        }
      }
      return match;
    });

    // ── Newline-recovery pass (runs BEFORE auto-bold) ────────────────────────
    // Flash-Lite sometimes omits the blank line between articles, joining them as:
    //   "...description. NextHeadline — next desc..."
    // Insert \n before the next headline so the auto-bold regex (below) can see it.
    // Pattern: sentence-ending punct immediately followed by Telugu or Uppercase English
    // text that itself precedes a " — " separator (marks a headline).
    text = text.replace(/([.!?।])([ఀ-౿][^\n—–]{5,200}? [—–] )/g, '$1\n$2');
    text = text.replace(/([.!?।])([A-Z][^\n—–]{5,200}? [—–] )/g, '$1\n$2');
    // ── Auto-bold safety net ──────────────────────────────────────────────────
    // Gemini occasionally outputs "Headline — description" without **bold** markers.
    // Any line that (a) does not already start with ** and (b) contains " — "
    // has its pre-dash portion auto-wrapped in **...**  so the display is consistent.
    // The Telugu em-dash separator can appear as — (U+2014) or – (U+2013).
    text = text.replace(
      /^(?!\*\*)([^\n*]{10,300}?) [—–] (.+)$/gm,
      '**$1** — $2'
    );
    // ─────────────────────────────────────────────────────────────────────────

    const urls = [];
    // Step 1: extract URLs before HTML-escaping (& in URLs becomes &amp; otherwise)
    const placeholder = text.replace(/https?:\/\/[^\s<>"']+/g, function(url) {
      // trim trailing punctuation that isn't part of the URL
      const clean = url.replace(/[.,;:!?)\]]+$/, '');
      urls.push(clean);
      return '\x01' + (urls.length - 1) + '\x01';
    });
    // Step 1b: add \n AFTER closing **bold** when it's immediately followed by text.
    // Previous regex added \n before opening ** which broke mid-headline: "**headlin\n**description"
    // caused the bold regex to fail (it rejects \n inside **...**). This version correctly
    // places the break AFTER the closing **, preserving the full **headline** for rendering.
    // Also ensures a new **headline** always starts on its own line.
    const withBreaks = placeholder
      .replace(/(\*\*[^*\n]{1,150}?\*\*)(?! ?[—–])([^\n])/g, '$1\n$2')   // add \n after **X** only when NOT followed by em-dash (keeps "headline — desc" on one line)
      .replace(/([^\n])(\*\*[^\s*])/g, '$1\n$2');               // ensure new **headline starts on own line
    // Step 2: HTML-escape (also converts \n → <br>)
    let html = escHtml(withBreaks);
    // Step 2b: render **bold** headlines — applied after escaping so < > are safe
    html = html.replace(/\*\*([^*\n<]{1,150}?)\*\*/g, '<strong>$1</strong>');
    // Step 3: restore URLs as anchor tags
    html = html.replace(/\x01(\d+)\x01/g, function(_, idx) {
      const url = urls[parseInt(idx, 10)];
      const safeHref = escAttr(url);
      const safeText = escHtml(url).replace(/<br>/g, '');
      return '<a href="' + safeHref + '" target="_blank" rel="noopener noreferrer" ' +
             'style="color:var(--newsai-primary,#C0392B);word-break:break-all;text-decoration:underline;">' +
             safeText + '</a>';
    });
    // Step 4: copy-paste structure preservation.
    // Wrap each article line in a block-level <div> so the clipboard serializes a
    // newline between them (WhatsApp, Notes, email body strip stray <br>s).
    // Gemini often emits a SINGLE \n between articles → single <br>, so the old
    // <br><br>-only trigger never fired. Trigger for list responses (3+ bold
    // headlines) and split on any <br>. Fall back to <br><br> for non-list text.
    const boldLineCount = (text.match(/\*\*[^*\n]+\*\*/g) || []).length;
    if (boldLineCount >= 3) {
      const parts = html.split(/<br\s*\/?>/i).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 3) {
        html = parts.map(s => `<div style="margin-bottom:7px">${s}</div>`).join('');
      }
    } else if (/<br><br>/i.test(html)) {
      html = html.split(/<br><br>/i).map(s => s.trim()).filter(Boolean)
        .map(s => `<div style="margin-bottom:8px">${s}</div>`).join('');
    }
    return html;
  }

  /**
   * Remove repeated sentences/fragments from article body text.
   * Handles RSS/CMS bugs where the same text is copy-pasted many times.
   */
  function dedupContent(text) {
    if (!text || text.length < 60) return text;

    // Pass 1: deduplicate at sentence boundaries (., ?, !, ।)
    const tokens = text.split(/([.?!।])/);
    const seenSent = new Set();
    const outTokens = [];
    for (var si = 0; si < tokens.length; si += 2) {
      var sent  = (tokens[si]  || '').trim();
      var delim = tokens[si + 1] || '';
      var norm  = sent.toLowerCase().replace(/\s+/g, ' ');
      if (norm.length >= 15) {
        if (seenSent.has(norm)) continue;
        seenSent.add(norm);
      }
      if (sent || delim) outTokens.push(sent + delim);
    }
    var result = outTokens.join(' ');

    // Pass 2: collapse consecutive repeated word-windows (no sentence boundary)
    // e.g., "phrase phrase phrase" where phrase has no punctuation
    var words = result.split(/\s+/);
    if (words.length < 15) return result.trim();
    var WIN = 5;
    var outWords = [];
    var wi = 0;
    while (wi < words.length) {
      if (wi + WIN * 3 <= words.length) {
        var win  = words.slice(wi, wi + WIN).join(' ');
        var nxt1 = words.slice(wi + WIN, wi + WIN * 2).join(' ');
        var nxt2 = words.slice(wi + WIN * 2, wi + WIN * 3).join(' ');
        if (win === nxt1 && win === nxt2) {
          // keep first occurrence, skip all subsequent
          outWords.push.apply(outWords, words.slice(wi, wi + WIN));
          var wj = wi + WIN;
          while (wj + WIN <= words.length && words.slice(wj, wj + WIN).join(' ') === win) wj += WIN;
          wi = wj;
          continue;
        }
      }
      outWords.push(words[wi]);
      wi++;
    }
    return outWords.join(' ').trim();
  }

  function trimHistory() {
    if (conversationHistory.length > MAX_HISTORY) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY);
    }
    // Gemini requires the first message to be 'user' role.
    // After slicing, an even-numbered trim can leave an 'assistant' at position 0.
    while (conversationHistory.length > 0 && conversationHistory[0].role !== 'user') {
      conversationHistory = conversationHistory.slice(1);
    }
  }

  function saveSession() {
    // Cap at the last 20 messages before saving to avoid hitting the sessionStorage quota.
    try { sessionStorage.setItem('newsai_history', JSON.stringify(conversationHistory.slice(-20))); } catch (_) {}
  }

  // Explicit reset of the persisted session history (not called on normal page close —
  // sessionStorage clears itself when the tab closes). Wrapped in try/catch for private mode.
  function clearHistory() {
    try { sessionStorage.removeItem('newsai_history'); } catch (_) {}
  }

  // ─── Content loading status ────────────────────────────────────────────────
  function setContentLoading(panel, loading) {
    panel.classList.toggle('newsai-content-loading', loading);
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────
  async function init() {
    // Wait for config
    await (window.NewsAI && window.NewsAI._configReady ? window.NewsAI._configReady : Promise.resolve());
    const config = (window.NewsAI && window.NewsAI.config) || {};
    // Set backend base URL from config so the widget works in production, not just localhost
    if (config.backendUrl) backendBaseUrl = config.backendUrl.replace(/\/$/, '');
    // Expose API key for Gemini TTS — stored on NewsAI namespace so startSpeaking can access it
    const _resolvedKey = config.geminiApiKey || config.groqApiKey || config.apiKey || config.anthropicApiKey || null;
    if (window.NewsAI) window.NewsAI._ttsApiKey = _resolvedKey;

    // Inject CSS if not already present
    if (!document.getElementById('newsai-styles')) {
      const link = document.createElement('link');
      link.id = 'newsai-styles';
      link.rel = 'stylesheet';
      // Try to resolve relative to this script
      const scripts = document.querySelectorAll('script[src*="newsai-widget"]');
      const base = scripts.length ? scripts[scripts.length - 1].src.replace(/newsai-widget\.js.*$/, '') : '';
      link.href = base + 'newsai-widget.css';
      document.head.appendChild(link);
    }

    // Load Noto Sans Telugu for better text rendering on Windows/Android
    if (!document.getElementById('newsai-noto-font')) {
      // Preconnect for faster font load
      const preconn = document.createElement('link');
      preconn.rel = 'preconnect';
      preconn.href = 'https://fonts.googleapis.com';
      preconn.crossOrigin = 'anonymous';
      document.head.appendChild(preconn);
      const preconn2 = document.createElement('link');
      preconn2.rel = 'preconnect';
      preconn2.href = 'https://fonts.gstatic.com';
      preconn2.crossOrigin = 'anonymous';
      document.head.appendChild(preconn2);
      // Non-blocking font load
      const fontLink = document.createElement('link');
      fontLink.id = 'newsai-noto-font';
      fontLink.rel = 'stylesheet';
      fontLink.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Telugu:wght@400;600;700&display=swap';
      document.head.appendChild(fontLink);
    }

    const el = buildWidget(config);

    // Fetch Gemini context cache ID in background — used by callGemini()
    fetch(backendBaseUrl + '/api/gemini-cache', { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.active && data.cacheId) {
          geminiCacheId     = data.cacheId;
          geminiCacheExpiry = data.expiresAt || 0;
          console.log('[NewsAI] Gemini context cache active:', geminiCacheId);
        }
      })
      .catch(() => {});  // cache miss — fall through to full system prompt

    // Pre-fetch digest at startup — will be ready by the time user opens the panel
    fetch(backendBaseUrl + '/api/digest', { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.ready) {
          dailyDigest   = { te: data.te || null, en: data.en || null };
          todaySections = Array.isArray(data.sections) ? data.sections : [];
          _injectDigest(dailyDigest[currentLang]);       // inject digest if panel is already open
          _injectSectionChips(todaySections);            // update chips with real sections
        }
      })
      .catch(() => {});  // digest unavailable — loading slot remains; user can ask directly

    // Load content
    if (window.NewsAI && window.NewsAI.loadContent) {
      const panel = document.getElementById('newsai-panel');
      setContentLoading(panel, true);
      try {
        await window.NewsAI.loadContent(config);
      } catch (err) {
        console.warn('[NewsAI] Content load failed:', err.message);
      } finally {
        setContentLoading(panel, false);
        // Remove loading FAB state
        const fab = document.getElementById('newsai-fab');
        if (fab) fab.closest('.newsai-wrapper').classList.remove('newsai-loading');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
