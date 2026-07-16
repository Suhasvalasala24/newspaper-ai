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
  let recognition = null;
  let isListening = false;
  let voiceInputActive = false; // true when current message came from mic
  const MAX_HISTORY = 4;  // keep last 4 exchanges — saves ~1200+ tokens per request
  let promptCount = 0;  // increments on each user message; non-skippable ad every 3rd
  let backendBaseUrl = 'http://localhost:3001'; // overridden from config.backendUrl in init()

  // ─── Gemini context cache (Feature: backend caching) ─────────────────────
  let geminiCacheId     = null;
  let geminiCacheExpiry = 0;

  // ─── Daily digest cache (Feature: pre-generated digest) ──────────────────
  let dailyDigest = { te: null, en: null };

  // ─── Font size preference (Feature: A/A+ control) ────────────────────────
  let fontSizePref = 'normal';

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
      }).catch(() => {});
    } catch (_) {}
  }

  // ─── Next word suggestions ────────────────────────────────────────────────
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
        e.preventDefault();
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
        if (Array.isArray(parsed)) conversationHistory = parsed;
      }
      const savedLang = sessionStorage.getItem('newsai_lang');
      if (savedLang && (savedLang === 'te' || savedLang === 'en')) currentLang = savedLang;
    } catch (_) {}

    // Sanitise brand fields before injecting into innerHTML
    const safeName      = escHtml(brand.name || 'NewsAI').replace(/<br>/g, ' ');
    const safeShortName = escHtml(brand.shortName || (brand.name || 'N').charAt(0) || 'N').replace(/<br>/g, ' ');
    const safeNameAttr  = escAttr(brand.name || 'NewsAI');
    const safeLogoUrl   = (brand.logoUrl && /^https?:\/\//i.test(brand.logoUrl)) ? escAttr(brand.logoUrl) : '';

    const wrapper = document.createElement('div');
    wrapper.className = 'newsai-wrapper' + (position === 'bottom-left' ? ' newsai-pos-left' : '');
    wrapper.setAttribute('aria-label', 'News AI Chatbot');

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
            <span class="newsai-hf-status" style="display:none;font-size:11px;color:#888;margin-left:auto;"></span>
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

    return el;
  }

  // ─── Panel open/close ──────────────────────────────────────────────────────
  function openPanel(el, config) {
    isOpen = true;
    el.panel.classList.add('newsai-open');
    el.badge.classList.add('newsai-hidden');
    track('open');

    // Fetch dynamic chips in background
    fetch(backendBaseUrl + '/api/chips', { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Array.isArray(data.te) && data.te.length > 0) {
          SUGGESTIONS.te = data.te;
          SUGGESTIONS.en = data.en && data.en.length > 0 ? data.en : SUGGESTIONS.en;
        }
      })
      .catch(() => {});

    // Fetch digest in background
    fetch(backendBaseUrl + '/api/digest', { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.ready) {
          dailyDigest = { te: data.te || null, en: data.en || null };
        }
      })
      .catch(() => {});

    // Render welcome or restore session — only into an EMPTY container.
    if (el.messages.children.length === 0) {
      if (conversationHistory.length === 0) {
        renderWelcome(el, config);
        // Run silent diagnostic on first open — shows key/backend status in console
        runDiagnostic(el, config);
      } else {
        restoreMessages(el, conversationHistory);
      }
    }
    setTimeout(() => el.input.focus(), 300);
  }

  /** Silent startup check — logs key + backend status to browser console. */
  async function runDiagnostic(el, config) {
    const apiKey = config.geminiApiKey || config.groqApiKey || config.apiKey || config.anthropicApiKey || '';
    const provider = detectProvider(apiKey);

    console.group('[NewsAI] 🔍 Startup Diagnostic');
    console.log('API key:', apiKey ? `${apiKey.slice(0, 8)}... (len ${apiKey.length})` : '❌ EMPTY');
    console.log('Provider detected:', provider);
    console.log('Articles in DOM:', window.NewsAI?.articles?.length || 0);
    console.log('Today content chars:', window.NewsAI?.todayContent?.length || 0);

    // Check backend
    try {
      const r = await fetch(`${backendBaseUrl}/`, { signal: AbortSignal.timeout(2000) });
      const d = await r.json();
      console.log('Backend:', d.status === 'ok' ? '✅ Running' : '⚠️ ' + JSON.stringify(d));
      const q = await fetch(`${backendBaseUrl}/api/articles/today`, { signal: AbortSignal.timeout(2000) });
      const qd = await q.json();
      console.log('Articles in portal:', qd.stats?.total ?? 0);
    } catch (e) {
      console.warn('Backend: ❌ Not running or unreachable —', e.message);
    }

    if (!apiKey || apiKey.length < 10) {
      const warn = currentLang === 'te'
        ? '⚠️ API కీ సెట్ చేయబడలేదు. Extension icon క్లిక్ చేసి కీ పేస్ట్ చేయండి.'
        : '⚠️ No API key found. Click the extension icon and paste your Gemini or Groq key.';
      appendMessage(el.messages, 'bot', warn);
    } else if (provider === 'unknown') {
      const warn = currentLang === 'te'
        ? `⚠️ API కీ format సరికాదు (${apiKey.slice(0,6)}...). Gemini కీ "AIza" లేదా "AQ." తో, Groq కీ "gsk_" తో మొదలవుతుంది.`
        : `⚠️ API key format not recognised (starts: ${apiKey.slice(0,6)}...). Gemini keys start with "AIza" or "AQ.", Groq with "gsk_".`;
      appendMessage(el.messages, 'bot', warn);
    }

    console.groupEnd();
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
    const chips = currentLang === 'te'
      ? ['ఈ రోజు ముఖ్య వార్తలు', 'క్రికెట్‌ స్కోర్‌', 'సినిమా వార్తలు', 'తెలంగాణ వార్తలు', 'ఆంధ్రప్రదేశ్‌ వార్తలు']
      : ['Top headlines today', 'Cricket score', 'Cinema news', 'Telangana news', 'Andhra Pradesh news'];

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

    // Pre-generated digest — shown if available, collapsed by default
    const digestText = dailyDigest[currentLang] || null;
    const digestHtml = digestText
      ? `<div class="newsai-digest-card" id="newsai-digest-card">
          <div class="newsai-digest-header" id="newsai-digest-toggle">
            <span>${currentLang === 'te' ? '📰 ఈ రోజు సారాంశం' : '📰 Today\'s Digest'}</span>
            <span class="newsai-digest-arrow">▾</span>
          </div>
          <div class="newsai-digest-body" id="newsai-digest-body" style="display:none">
            ${renderBotText(digestText.slice(0, 500) + (digestText.length > 500 ? '…' : ''))}
            ${digestText.length > 500
              ? `<button class="newsai-digest-more" id="newsai-digest-expand">
                  ${currentLang === 'te' ? 'మరింత చదవండి →' : 'Read more →'}
                </button>` : ''}
          </div>
        </div>`
      : '';

    const msgEl = document.createElement('div');
    msgEl.className = 'newsai-msg newsai-msg-bot';
    msgEl.innerHTML = `
      <div class="newsai-bubble">
        ${escHtml(welcome)}
        ${digestHtml}
        <div class="newsai-news-cards">
          ${sampleCards.map(c => `
            <div class="newsai-news-card">
              <div class="newsai-news-card-section">${c.section}</div>
              <div class="newsai-news-card-headline">${c.headline}</div>
            </div>`).join('')}
        </div>
        <div class="newsai-chips" id="newsai-chips">
          ${chips.map(c => `<button class="newsai-chip">${c}</button>`).join('')}
        </div>
        ${sectionNavHtml}
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        ${makeSpeakBtn(welcome)}
        ${makeShareBtn(welcome)}
        <button class="newsai-copy-btn" title="Copy" aria-label="Copy message">${ICONS.copy}</button>
        <span class="newsai-msg-time">${timeStr()}</span>
      </div>
    `;

    // Wire digest toggle + expand
    if (digestText) {
      const toggle = msgEl.querySelector('#newsai-digest-toggle');
      const body   = msgEl.querySelector('#newsai-digest-body');
      const arrow  = msgEl.querySelector('.newsai-digest-arrow');
      if (toggle && body) {
        toggle.addEventListener('click', () => {
          const open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          if (arrow) arrow.textContent = open ? '▾' : '▴';
        });
      }
      const expandBtn = msgEl.querySelector('#newsai-digest-expand');
      if (expandBtn && body) {
        expandBtn.addEventListener('click', () => {
          body.innerHTML = renderBotText(digestText);
          expandBtn.remove();
        });
      }
    }

    el.messages.appendChild(msgEl);
    wireCopy(msgEl);
    wireShare(msgEl);

    // Wire chips
    msgEl.querySelectorAll('.newsai-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        el.input.value = chip.textContent;
        el.send.disabled = false;
        submitMessage(el, config);
      });
    });

    wireSpeak(msgEl);
  }

  // ─── Restore session messages ────────────────────────────────────────────────
  function restoreMessages(el, history) {
    history.forEach(msg => {
      appendMessage(el.messages, msg.role === 'user' ? 'user' : 'bot', msg.content, false);
    });
    scrollToBottom(el.messages);
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
          '<button class="newsai-copy-btn" title="Copy" aria-label="Copy message">' + ICONS.copy + '</button>' +
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
    if (scroll) scrollToBottom(container);
    return msgEl;
  }

  // ─── Typing indicator ────────────────────────────────────────────────────────
  function showTyping(container) {
    const el = document.createElement('div');
    el.className = 'newsai-msg newsai-msg-bot';
    el.id = 'newsai-typing';
    el.innerHTML = `<div class="newsai-typing"><span></span><span></span><span></span></div>`;
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
      el.innerHTML = `<div class="newsai-typing"><span></span><span></span><span></span></div>`;
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

      let maxTimer;  // declared here so cleanup() can clear it (Bug 5 fix)
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

      maxTimer = setTimeout(() => { cleanup(); resolve(); }, 15000);
    });
  }

  // ─── Submit message ────────────────────────────────────────────────────────
  async function submitMessage(el, config) {
    const text = el.input.value.trim();
    if (!text || isTyping) return;

    // Response language is controlled by the toggle (currentLang), not the input script.
    // Hide chips after first real message
    if (chipsVisible) {
      const chips = document.getElementById('newsai-chips');
      if (chips) chips.classList.add('newsai-chips-hidden');
      chipsVisible = false;
    }

    track('query', { query: text.slice(0, 100) });
    el.input.value = '';
    el.send.disabled = true;

    // ── Detect section for post-response redirect button ──────────────────────
    const _topicForRedirect = detectAndFilterTopic(text, null);
    if (window.NewsAI) window.NewsAI._lastSection = _topicForRedirect ? _topicForRedirect.section : null;

    // ── Non-skippable ad every 3rd prompt ────────────────────────────────────
    promptCount++;
    if (promptCount % 3 === 0) {
      await showAdOverlay(config);
    }

    appendMessage(el.messages, 'user', text);
    conversationHistory.push({ role: 'user', content: text });
    trimHistory();
    saveSession();

    isTyping = true;
    showTyping(el.messages);

    try {
      // ── Streaming: create bot bubble upfront, fill as tokens arrive ─────────
      let streamedEl   = null;
      let streamedBubble = null;
      let fullReply    = '';

      config._onStream = (token) => {
        if (!streamedEl) {
          hideTyping();
          streamedEl     = appendMessage(el.messages, 'bot', '');
          streamedBubble = streamedEl.querySelector('.newsai-bubble');
        }
        fullReply += token;
        if (streamedBubble) {
          streamedBubble.textContent = fullReply;
          scrollToBottom(el.messages);
        }
      };

      const reply = await callClaude(config);
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
        // Non-streaming path — provider didn't call onStream
        hideTyping();
        streamedEl = appendMessage(el.messages, 'bot', reply || '(empty response)');
        if (!isNoInfoReply(reply)) injectArticleLinks(streamedEl, lastArticles);
      } else {
        // Streaming done — re-render with final text, re-wire buttons
        const finalText = reply || fullReply;
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
        wireSpeak(streamedEl);
        wireShare(streamedEl);
        wireCopy(streamedEl);
        if (!isNoInfoReply(finalText)) injectArticleLinks(streamedEl, lastArticles);
        scrollToBottom(el.messages);
      }

      const finalReply = reply || fullReply;
      conversationHistory.push({ role: 'assistant', content: finalReply });
      trimHistory();
      saveSession();

      if (voiceInputActive) {
        voiceInputActive = false;
        const speakBtn = streamedEl.querySelector('.newsai-speak-btn');
        // Guard: never call startSpeaking with empty text — an empty TTS request returns
        // HTTP 400, which (if not caught as transient) permanently disables backend TTS.
        if (speakBtn && finalReply && finalReply.trim()) startSpeaking(speakBtn, finalReply);
      }

      // ── Section redirect button ───────────────────────────────────────────────
      // Maps English internal section names → Telugu keys in config.sectionUrls
      // Maps the classifier's INTERNAL section names (e.g. "Crime & Police",
      // "Andhra Pradesh") to the Telugu keys used in config.sectionUrls.
      // NOTE: keys must match detectAndFilterTopic() output EXACTLY — it emits
      // "Crime & Police" (not "Crime"), so the old "Crime" key never matched.
      const _SECTION_TE_MAP = {
        'Sports': 'క్రీడలు', 'Cinema': 'సినిమా', 'National': 'జాతీయం',
        'International': 'అంతర్జాతీయం', 'Business': 'వ్యాపారం',
        'Telangana': 'తెలంగాణ', 'Andhra Pradesh': 'ఆంధ్రప్రదేశ్',
        'Crime & Police': 'నేరాలు', 'Politics': 'రాజకీయాలు',
        'Family': 'కుటుంబం', 'Women': 'మహిళలు',
        // Previously missing — redirect button was silently dead for these sections
        'Agriculture': 'వ్యవసాయం',
        'Education': 'విద్య',
        'Public Health': 'ఆరోగ్యం',
        'Technology': 'సాంకేతిక',
        'Courts': 'న్యాయస్థానం',
        'Railways': 'రైల్వే',
        'Aviation': 'విమానాలు',
        'Irrigation': 'నీటిపారుదల',
        'Roads & Buildings': 'రహదారులు',
        'Local Bodies': 'స్థానిక సంస్థలు',
        'Public Administration': 'పరిపాలన',
        'Lifestyle': 'జీవనశైలి',
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
          sectionBtn.textContent = currentLang === 'te'
            ? `📰 సాక్షి ${teKey} చదవండి →`
            : `📰 Read all ${_lastSection} news →`;
          sectionBtn.addEventListener('click', function() {
            window.location.href = sectionUrl;
          });
          streamedEl.appendChild(sectionBtn);
        }
      }
    } catch (err) {
      delete config._onStream;
      voiceInputActive = false;
      hideTyping();
      const errText = err?.message || String(err);
      console.error('[NewsAI] API error:', errText, err);
      // Show a generic user-friendly message — never leak internal error strings to the reader.
      appendMessage(el.messages, 'bot', t('error'));
    } finally {
      isTyping      = false;
      el.send.disabled = false;
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
   * Both AIza... (Standard) and AQ.Ab... (Auth/new format from Jun 2026) keys
   * use the same native Gemini auth: pass as ?key= query parameter.
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

  // ─── Backend context fetch ────────────────────────────────────────────────
  /**
   * Calls /api/query on the local backend — keyword RAG over today's ingested articles.
   * Articles are added to the in-memory store by newsai-content.js on page load.
   * Returns null if backend is offline or store is empty → caller falls back to DOM.
   */
  async function fetchBackendContext(question) {
    try {
      const resp = await fetch(`${backendBaseUrl}/api/query`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question, topN: 30 }),  // 30 so full section lists fit
        signal:  AbortSignal.timeout(3000),  // 3s max — keyword search is instant
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.context) return null;  // null = no articles ingested yet → DOM fallback
      console.log(`[NewsAI] ✅ Backend RAG: ${data.articles?.length} articles matched`);
      // Store top matched articles for redirect buttons (up to 3, URL required)
      if (data.articles && data.articles.length > 0 && window.NewsAI) {
        const _seenUrls = new Set();
        window.NewsAI._lastArticles = data.articles
          .filter(function(a) { return !!a.url && !_seenUrls.has(a.url) && _seenUrls.add(a.url); })
          .slice(0, 3)
          .map(function(a) { return { url: a.url, title: a.title || '' }; });
      }
      return data.context;
    } catch (_) {
      // Backend offline — silent fallback to DOM content
      return null;
    }
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

    // Set content budget: Groq free tier is tight (20k TPM), Gemini is generous.
    // This value is read by newsai-content.js buildContextString to cap the context.
    if (window.NewsAI) {
      window.NewsAI.contentBudget = (provider === 'gemini') ? 10000 : 4500;
    }

    // Pre-filter articles by topic so small models don't mix unrelated sections.
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

    // ── Try backend briefing first (has full body text for all articles) ──────
    // If backend is running: uses real ingested content → zero hallucination.
    // If backend is offline: falls back to DOM-scraped content silently.
    const backendCtx = await fetchBackendContext(lastUserMsg);
    if (backendCtx) {
      // Store for buildSystemPrompt to pick up; cleared after use
      if (window.NewsAI) window.NewsAI._backendContext = backendCtx;
    }

    const systemPrompt = buildSystemPrompt(config, provider, lastUserMsg);

    // Groq: limit history to last 2 exchanges to save tokens
    const histLimit = (provider === 'groq') ? 2 : MAX_HISTORY;
    const messages = conversationHistory.slice(-histLimit * 2);

    const onStream = config._onStream || null;
    if (provider === 'gemini')    return callGemini(apiKey, systemPrompt, messages, onStream);
    if (provider === 'anthropic') return callAnthropic(apiKey, systemPrompt, messages, onStream);
    return callGroq(apiKey, systemPrompt, messages, config.llmModel, onStream);
  }

  async function callGroq(apiKey, systemPrompt, messages, model, onStream, _retries = 0) {
    // Always use llama-3.1-8b-instant (20k TPM free). Reject the 70b model
    // even if it appears in config — it has only 6k TPM and hits limits fast.
    const chosenModel = (model === 'llama-3.3-70b-versatile' || !model)
      ? 'llama-3.1-8b-instant'
      : model;

    // Hard cap: trim content section if total prompt is too large (413 defence).
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
      const waitSec = waitMatch ? Math.max(10, Math.ceil(parseFloat(waitMatch[1])) + 2) : 15;
      console.warn(`[NewsAI] Groq 429 — retrying in ${waitSec}s...`);
      await countdownWait(waitSec);
      return callGroq(apiKey, systemPrompt, messages, chosenModel, onStream, _retries + 1);
    }

    if (resp.status === 413 && _retries < 1) {
      console.warn('[NewsAI] Groq 413 (too large) — trimming content and retrying...');
      updateTypingStatus(currentLang === 'te' ? '✂️ కంటెంట్ తగ్గిస్తున్నారు...' : '✂️ Trimming content...');
      const cutAt = systemPrompt.indexOf('TODAY\'S ARTICLES');
      const trimmed = cutAt > 0
        ? systemPrompt.slice(0, cutAt) + 'TODAY\'S ARTICLES:\n' + systemPrompt.slice(cutAt).slice(0, 1000) + '\n[Trimmed]'
        : systemPrompt.slice(0, 2000);
      return callGroq(apiKey, trimmed, messages.slice(-2), chosenModel, onStream, _retries + 1);
    }

    if (resp.status === 429) {
      throw new Error(currentLang === 'te'
        ? 'చాలా ప్రశ్నలు వేశారు. ఒక నిమిషం వేచి తిరిగి ప్రయత్నించండి.'
        : 'Too many requests. Please wait a minute and try again.');
    }

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Groq ${resp.status}: ${err.error?.message || 'Unknown error'}`);
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

    // ── Non-streaming path ─────────────────────────────────────────────────
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

    if (onStream) {
      const reader = resp.body.getReader();
      const dec    = new TextDecoder();
      let buf = '';
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buf.startsWith('data: ')) {
            const raw = buf.slice(6).trim();
            if (raw && raw !== '[DONE]') {
              try {
                const ev = JSON.parse(raw);
                const token = ev.delta?.text || '';
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
          if (raw === '[DONE]' || !raw) continue;
          try {
            const ev = JSON.parse(raw);
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              const token = ev.delta.text || '';
              if (token) { full += token; onStream(token); }
            }
          } catch (_) {}
        }
      }
      return full;
    }

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
    // Deduplicate consecutive same-role messages (Gemini rejects them)
    const deduped = contents.filter((m, i) => i === 0 || m.role !== contents[i - 1].role);
    // Gemini requires first message to be 'user' — drop any leading 'model' turns
    while (deduped.length > 0 && deduped[0].role !== 'user') deduped.shift();
    if (!deduped.length) throw new Error('No user messages to send to Gemini');

    const MODEL = 'gemini-2.5-flash-lite';

    // Use backend context cache if active — saves ~90% on cached tokens
    const activeCacheId = (geminiCacheId && Date.now() < geminiCacheExpiry) ? geminiCacheId : null;

    // Per-query overlay: language rule + anti-hallucination — change every request and must
    // always be sent fresh even when cache is active (cache only holds today's articles).
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

    const bodyObj = activeCacheId
      ? {
          cachedContent: activeCacheId,
          systemInstruction: { parts: [{ text: cacheOverlayInstruction }] },
          contents: deduped,
          generationConfig: { maxOutputTokens: 8192, temperature: 0.1, topP: 0.85 },
        }
      : {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: deduped,
          generationConfig: { maxOutputTokens: 8192, temperature: 0.1, topP: 0.85 },
        };

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
          if (buf.startsWith('data: ')) {
            const raw = buf.slice(6).trim();
            if (raw && raw !== '[DONE]') {
              try {
                const chunk = JSON.parse(raw);
                const token = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
            const token = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
        ? 'API కీ చెల్లదు లేదా గడువు తీరింది. aistudio.google.com/apikey లో కొత్త AIza… కీ తీసుకుని Extension popup లో పేస్ట్ చేయండి.'
        : 'API key invalid or expired. Go to aistudio.google.com/apikey → Create API key → paste the new AIza… key in the extension popup.');
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

  // ─── System prompt builder ─────────────────────────────────────────────────
  // Restored to the working MODE 1/2/3 architecture from the reference build.
  // Key insight: MODE 2 lets the AI SEMANTICALLY search for sports/cinema articles
  // anywhere in the content — it doesn't need a "Sports:" section label to exist.
  // The previous "SECTION → if empty: no articles" rule caused false negatives when
  // section classification was imperfect.
  // ─── Topic pre-filter: detect section from user message and narrow the context ──
  // ─── Smart topic pre-filter ───────────────────────────────────────────────
  // Each entry has:
  //   triggers  — words the USER types that activate this filter
  //   section   — the section label used by the classifier
  //   bodyKeys  — additional keywords searched in headline+body text
  //               to catch articles that were misclassified into the wrong section
  const TOPIC_FILTERS = [
    { triggers: ['sport','sports','cricket','ipl','football','badminton','boxing','tennis','kabaddi','olympic','match','tournament','league','వ్యాయామం','క్రీడ','క్రీడలు','స్పోర్ట్స్','క్రికెట్','మ్యాచ్','ఫుట్బాల్','ఆట','ఆటలు','కబడ్డీ','హాకీ','టెన్నిస్','బ్యాడ్మింటన్','బాక్సింగ్','ఒలింపిక్స్','టోర్నమెంట్'],
      section: 'Sports',
      bodyKeys: ['cricket','match','tournament','ipl','t20','odi','wicket','batting','bowling','football','badminton','hockey','kabaddi','olympic','medal','sport','player','క్రికెట్','మ్యాచ్','టోర్నమెంట్','వికెట్','క్రీడ','ఆటగాడు','మెడల్','ట్రోఫీ','చాంపియన్'] },

    { triggers: ['cinema','movie','film','tollywood','bollywood','ott','actor','actress','release','సినిమా','నటుడు','నటి','చిత్రం','వినోదం','టాలీవుడ్','ఓటీటీ','సినిమా వార్తలు','మూవీ'],
      section: 'Cinema',
      bodyKeys: ['cinema','movie','film','actor','actress','director','release','ott','tollywood','bollywood','trailer','సినిమా','నటుడు','నటి','చిత్రం','దర్శకుడు','రిలీజ్','ట్రైలర్','హీరో','హీరోయిన్'] },

    { triggers: ['telangana','hyderabad','secunderabad','revanth','ktr','brs','warangal','nizamabad','karimnagar','తెలంగాణ','హైదరాబాద్','సికింద్రాబాద్','వరంగల్','రేవంత్','కేటీఆర్'],
      section: 'Telangana',
      bodyKeys: ['telangana','hyderabad','secunderabad','revanth','ktr','brs','warangal','nizamabad','karimnagar','khammam','nalgonda','రంగారెడ్డి','తెలంగాణ','హైదరాబాద్','కేటీఆర్','రేవంత్'] },

    { triggers: ['andhra','amaravati','vijayawada','vizag','chandrababu','jagan','tdp','ysrcp','ఆంధ్ర','అమరావతి','విజయవాడ','విజాగ్','చంద్రబాబు','జగన్','ఏపీ'],
      section: 'Andhra Pradesh',
      bodyKeys: ['andhra','amaravati','vijayawada','vizag','visakhapatnam','chandrababu','jagan','tdp','ysrcp','guntur','tirupati','nellore','ఆంధ్ర','అమరావతి','విజయవాడ','విజాగ్','చంద్రబాబు','జగన్'] },

    { triggers: ['national','india','central','modi','bjp','congress','parliament','lok sabha','rajya sabha','జాతీయ','కేంద్ర','ఢిల్లీ','భారత్','మోదీ','బీజేపీ','కాంగ్రెస్','పార్లమెంట్'],
      section: 'National',
      bodyKeys: ['national','india','central government','modi','bjp','congress','parliament','lok sabha','rajya sabha','delhi','union','జాతీయ','కేంద్ర','మోదీ','పార్లమెంట్','లోక్‌సభ'] },

    { triggers: ['international','world','global','usa','america','china','russia','warfare','iran','israel','అంతర్జాతీయ','విదేశీ','ప్రపంచం','అమెరికా','చైనా','యుద్ధం'],
      section: 'International',
      bodyKeys: ['international','world','global','america','usa','china','russia','war','iran','israel','pakistan','trump','biden','అంతర్జాతీయ','విదేశీ','ప్రపంచం','అమెరికా','యుద్ధం'] },

    { triggers: ['business','economy','market','sensex','nifty','rbi','stock','budget','gdp','వ్యాపారం','ఆర్థిక','మార్కెట్','షేర్','బడ్జెట్','సెన్సెక్స్'],
      section: 'Business',
      bodyKeys: ['business','economy','market','sensex','nifty','rbi','stock','budget','gdp','tax','gst','company','వ్యాపారం','ఆర్థిక','మార్కెట్','సెన్సెక్స్','బడ్జెట్','జీఎస్టీ'] },

    { triggers: ['politics','election','vote','minister','party','assembly','రాజకీయ','ఎన్నికలు','మంత్రి','పార్టీ','ముఖ్యమంత్రి','అసెంబ్లీ'],
      section: 'Politics',
      bodyKeys: ['election','vote','minister','party','assembly','campaign','rally','political','ఎన్నికలు','మంత్రి','పార్టీ','ప్రచారం','రాజకీయ'] },

    { triggers: ['agriculture','farmer','crop','రైతు','వ్యవసాయం','పంట','రైతన్న','కిసాన్'],
      section: 'Agriculture',
      bodyKeys: ['farmer','agriculture','crop','paddy','drought','fertilizer','irrigation','రైతు','వ్యవసాయం','పంట','ఎరువు','కరువు','సాగు'] },

    { triggers: ['education','school','college','exam','student','result','admission','విద్య','పాఠశాల','కళాశాల','విద్యార్థి','పరీక్ష','ఫలితాలు','ఎంసెట్','ఎంట్రన్స్'],
      section: 'Education',
      bodyKeys: ['school','college','university','exam','student','result','admission','eamcet','jee','neet','విద్య','పాఠశాల','కళాశాల','విద్యార్థి','పరీక్ష','ఫలితాలు','అడ్మిషన్'] },

    { triggers: ['health','hospital','disease','doctor','medicine','vaccine','outbreak','ఆరోగ్యం','వైద్యం','ఆసుపత్రి','వ్యాధి','డాక్టర్'],
      section: 'Public Health',
      bodyKeys: ['health','hospital','disease','doctor','medicine','vaccine','cancer','diabetes','virus','outbreak','ఆరోగ్యం','వైద్యం','ఆసుపత్రి','వ్యాధి','వైద్యుడు','వ్యాక్సిన్'] },

    { triggers: ['crime','police','murder','arrest','robbery','fraud','నేరం','పోలీసు','హత్య','అరెస్టు','దొంగతనం','మోసం','క్రైమ్'],
      section: 'Crime & Police',
      bodyKeys: ['murder','killed','arrested','robbery','fraud','police','crime','theft','rape','నేరం','హత్య','పోలీసు','అరెస్టు','దొంగతనం','మోసం','దాడి'] },

    { triggers: ['technology','cyber','tech','artificial intelligence','mobile','app','software','it sector','సాంకేతిక','సైబర్','టెక్','మొబైల్','యాప్'],
      section: 'Technology',
      bodyKeys: ['technology','cyber','software','app','mobile','internet','ai','digital','hacking','సాంకేతిక','సైబర్','సాఫ్ట్‌వేర్','యాప్','ఇంటర్నెట్','డిజిటల్'] },

    { triggers: ['court','high court','supreme court','judge','verdict','న్యాయస్థానం','హైకోర్టు','సుప్రీంకోర్టు','తీర్పు','న్యాయమూర్తి'],
      section: 'Courts',
      bodyKeys: ['court','high court','supreme court','judge','verdict','bail','petition','న్యాయస్థానం','హైకోర్టు','సుప్రీంకోర్టు','తీర్పు','న్యాయమూర్తి','బెయిల్','పిటిషన్'] },

    { triggers: ['railway','train','metro','రైల్వే','రైలు','మెట్రో','వందేభారత్'],
      section: 'Railways',
      bodyKeys: ['railway','train','metro','irctc','station','రైల్వే','రైలు','మెట్రో','స్టేషన్','ట్రెయిన్'] },

    { triggers: ['aviation','airport','flight','airline','విమానం','విమానాశ్రయం','ఫ్లైట్'],
      section: 'Aviation',
      bodyKeys: ['aviation','airport','flight','airline','pilot','విమానం','విమానాశ్రయం','ఫ్లైట్','పైలట్'] },

    { triggers: ['women','woman','మహిళ','మహిళలు','స్త్రీ','అమ్మాయి'],
      section: 'Women',
      bodyKeys: ['women','woman','girl','dowry','domestic violence','మహిళ','స్త్రీ','అమ్మాయి','వరకట్నం','గృహ హింస'] },

    { triggers: ['irrigation','dam','reservoir','flood','water level','నీటిపారుదల','డ్యామ్','జలాశయం','వరద','కాలువ'],
      section: 'Irrigation',
      bodyKeys: ['dam','reservoir','canal','flood','water level','irrigation','godavari','krishna','జలాశయం','డ్యామ్','కాలువ','వరద','నీటి మట్టం'] },

    { triggers: ['road','highway','flyover','bridge','రహదారి','హైవే','ఫ్లైఓవర్','వంతెన','రోడ్డు'],
      section: 'Roads & Buildings',
      bodyKeys: ['road','highway','flyover','bridge','expressway','రహదారి','హైవే','ఫ్లైఓవర్','వంతెన','రోడ్డు'] },

    { triggers: ['municipality','panchayat','ghmc','gvmc','mayor','ward','కార్పొరేషన్','నగరపాలక','పంచాయతీ','మేయర్','వార్డు'],
      section: 'Local Bodies',
      bodyKeys: ['municipality','panchayat','ghmc','gvmc','mayor','ward','councillor','కార్పొరేషన్','నగరపాలక','పంచాయతీ','మేయర్','కౌన్సిలర్'] },

    { triggers: ['lifestyle','fashion','food','travel','fitness','yoga','జీవనశైలి','ఫ్యాషన్','వంట','ప్రయాణం','యోగా','ఫిట్నెస్'],
      section: 'Lifestyle',
      bodyKeys: ['lifestyle','fashion','food','recipe','travel','fitness','yoga','beauty','జీవనశైలి','ఫ్యాషన్','వంట','టూరిజం','యోగా','అందం'] },

    { triggers: ['collector','administration','welfare','scheme','beneficiary','కలెక్టర్','పరిపాలన','సంక్షేమం','పథకం','లబ్ధిదారులు'],
      section: 'Public Administration',
      bodyKeys: ['collector','administration','welfare','scheme','beneficiary','government order','కలెక్టర్','పరిపాలన','సంక్షేమం','పథకం','లబ్ధిదారులు','ప్రభుత్వ ఉత్తర్వు'] },
  ];

  // Extract the named section's headline block from todayContent string.
  // ONLY extracts the "SectionName:" block — does NOT scan FULL TEXT (which is mixed).
  // FULL TEXT contains all sections together, so bodyKey matching would risk including
  // wrong-section articles. Section headline block is guaranteed to be correctly classified.
  function extractSectionFromContent(content, sectionName) {
    if (!content) return '';
    const lines = content.split('\n');
    const sectionLines = [];
    let capturing = false;
    const needle = sectionName.toLowerCase();
    for (const line of lines) {
      const trimmed = line.trim();
      // Stop at FULL TEXT — section blocks end here; FULL TEXT is cross-section
      if (trimmed === 'FULL TEXT:') break;
      // Section header: "Sports:", "Crime & Police:", "Roads & Buildings:", etc.
      if (trimmed.endsWith(':') && /^[A-Za-z& ]+:$/.test(trimmed)) {
        capturing = trimmed.slice(0, -1).trim().toLowerCase() === needle;
        if (capturing) sectionLines.push(line);  // include the header line
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
      // Method A uses ONLY section label — no bodyKeys contamination risk.
      // The classifier in content.js is well-tuned; trust it over keyword matching.
      const matching = articles.filter(a => a.section === f.section);
      return { section: f.section, filter: f, articles: matching };
    }
    return null;
  }

  /**
   * Extract the first meaningful sentence from article body text.
   * This is done in JavaScript — the LLM never "generates" the summary,
   * it only copies this pre-computed string. Eliminates hallucination risk.
   */
  function extractFirstSentence(text) {
    if (!text || text.length < 30) return '';
    // Match first sentence ending with ., ?, !, ।, or after 100 chars
    const m = text.match(/^.{20,150}?[.?!।\n]/);
    if (m) return m[0].trim();
    // Fallback: cut at last space within 120 chars
    const cut = text.slice(0, 120);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
  }

  /**
   * Strip publication/update timestamps from article text so the AI never
   * echoes "Jul 7 2026 7:49 AM | Updated on Jul 7 2026 10:56 AM" in its reply.
   * These metadata tokens come from the CMS scrape and are not news content.
   */
  function stripTimestamps(text) {
    if (!text) return text;
    return text
      // Strip newspaper CMS datelines like "సాక్షి, వైఎస్సార్‌ జిల్లా:" or "సాక్షి, హైదరాబాద్:"
      // These are source attribution prefixes embedded in article bodies by sakshi.com CMS.
      .replace(/సాక్షి\s*,\s*[^\n:]{1,60}:\s*/g, '')
      // "Updated on Month D YYYY H:MM AM/PM" (with optional preceding pipe)
      .replace(/\s*\|?\s*Updated\s+on\s+[A-Za-z]{3,9}\.?\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)/gi, '')
      // "Month D YYYY H:MM AM/PM" standalone
      .replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)/gi, '')
      // Telugu month names with year: "2023 ఫిబ్రవరి", "2025 జనవరి", etc.
      .replace(/\b\d{4}\s+(?:జనవరి|ఫిబ్రవరి|మార్చి|ఏప్రిల్|మే|జూన్|జూలై|ఆగస్టు|సెప్టెంబర్|అక్టోబర్|నవంబర్|డిసెంబర్)\b/g, '')
      // Orphaned pipe separators left over after above removals
      .replace(/\s*\|\s*$/gm, '').replace(/^\s*\|\s*/gm, '')
      .trim();
  }

  function buildTopicContext(section, matching) {
    if (!matching.length) {
      return `ఈ రోజు ${section} వార్తలు అందుబాటులో లేవు. Today's edition has no ${section} articles.`;
    }
    let out = `${section} articles in today's edition:\n\n`;
    matching.forEach(a => {
      out += `Headline: ${a.headline}\n`;
      const rawBody = stripTimestamps((a.bodyTe || a.body || '').trim());
      const body = dedupContent(rawBody);  // collapse repeated fragments from CMS bugs
      // Normalise for comparison: remove trailing punctuation + whitespace + lowercase
      const normStr = s => s.replace(/[.?!।\s]+$/g, '').replace(/^\s+/, '').toLowerCase();
      if (body.length >= 150 && body !== a.headline) {
        // Pre-extract first sentence in JS so the LLM never needs to generate it.
        const summary = extractFirstSentence(body);
        // Only include Summary if it is meaningfully different from the Headline.
        // sakshi.com body often STARTS with the headline text — skip it if so to
        // prevent the AI from printing "**Headline**: Headline." on one line.
        if (summary && normStr(summary) !== normStr(a.headline)) {
          out += `Summary: ${summary}\n`;
        }
        // Full body still included for DETAIL mode queries
        out += `Body: ${body.slice(0, 450)}\n`;
      } else {
        // Too short — LLM shows headline only
        out += `Body: [HEADLINE ONLY — DO NOT ADD ANY DESCRIPTION]\n`;
      }
      // URL intentionally excluded — LLM must never print URLs in responses.
      // Section redirect button is handled client-side from config.sectionUrls.
      out += '\n';
    });
    return out;
  }

  function buildSystemPrompt(config, provider, userMessage) {
    const { brand, sections } = config;

    // ── Backend briefing takes priority over DOM-scraped content ─────────────
    // When /api/chat returned a context, use it directly — it has full body text
    // for ALL articles (fetched once per day by the backend). No topic filtering
    // needed here because the backend already filtered by section.
    if (window.NewsAI && window.NewsAI._backendContext) {
      const backendContent = stripTimestamps(window.NewsAI._backendContext);
      delete window.NewsAI._backendContext;   // consume it — use once per query

      const isEnglish = currentLang === 'en';
      const langRule = isEnglish
        ? 'RESPOND IN ENGLISH ONLY. TRANSLATE everything to English — including all article headlines, summaries, and section names that are in Telugu. Every single word of your response must be in English. Do NOT leave any Telugu script in your output.'
        : 'RESPOND IN TELUGU. Every word of your response must be in Telugu script. Only proper nouns may stay in English.';
      // Closing line + fallback must follow the selected language, otherwise a
      // hardcoded Telugu sentence forces small models back into Telugu output.
      const closingLine = isEnglish
        ? 'Ask me which story you would like the full details for.'
        : 'ఏ వార్త పూర్తి వివరాలు కావాలో అడగండి.';

      return `You are ${brand.name}, a newspaper AI assistant.

🔴 LANGUAGE OVERRIDE — HIGHEST PRIORITY: ${langRule}
This overrides every previous message in this conversation. Ignore the language used before. ${isEnglish ? "Translate ALL Telugu text in TODAY'S ARTICLES to English. Every word of your response must be English." : "Every word of your response must be Telugu script."}

🔴 ANTI-HALLUCINATION — ABSOLUTE RULE:
- ONLY use information EXPLICITLY WRITTEN in TODAY'S ARTICLES below.
- Do NOT invent or generate specific numbers (live scores, prices, index levels, statistics) not written in TODAY'S ARTICLES. If relevant articles exist for the topic: show them using TIER 1 format. You may add one brief note that live real-time figures may not appear in today's print edition — only if the user specifically asked for a live number. Only say "ఈ వివరాలు ఈ రోజు పేపర్‌లో లేవు" if there are NO relevant articles at all.

STRICT RULES:
1. ONLY use information present in TODAY'S ARTICLES below. Never add facts from training knowledge.
2. NEVER invent scores, statistics, player names, or any numbers not in the article text.
3. If Body says "[HEADLINE ONLY — DO NOT ADD ANY DESCRIPTION]": that is an INTERNAL DATA TAG. NEVER print it. Output ONLY the bold **Headline text** and nothing else.
4. No bullet points, no [1][2] numbers. Plain text only.
5. Never write the same sentence twice.
6. NEVER include URLs, links, or web addresses in your response. URL fields are internal data only — do NOT print them.
7. Do NOT truncate. Finish the response completely. Never cut off mid-sentence.
8. NEVER include dates, timestamps, times, or "Updated on" text in your response — these are metadata and must be stripped out. Output only the news content itself.
9. NEVER include CMS datelines like "సాక్షి, X జిల్లా:" or any "PublicationName, PlaceName:" prefix. These are internal CMS attribution markers, not part of the news story. Strip them completely from your output.

── TIER 1: News listing (section query / top headlines / "ఈ రోజు వార్తలు") ──
When the user asks for a category of news, top stories, or today's headlines:
• Line 1: Write the Headline in bold: **Headline text** — wrap ONLY the headline in double asterisks, nothing else.
• Line 2 (only if Summary field exists AND its text differs from the Headline): write 1 sentence of the summary as plain text on its OWN LINE. Do NOT put it inside ** markers. Do NOT write the word "Summary:".
• ⛔ NEVER read or quote the "Body:" field in TIER 1. Body content is strictly for TIER 2 only.
• If Body says "[HEADLINE ONLY...]": NEVER print that tag. Write the bold **Headline** only. Nothing else.
• If the Headline is just a location or person name with no news action, SKIP it — it is a section divider, not an article.
• Leave a blank line between each article.
End with exactly this sentence: "${closingLine}"

── TIER 2: Single article detail ("వివరాలు చెప్పు" / "tell me more about X") ──
When the user EXPLICITLY asks for more detail about ONE specific article ("tell me more", "వివరాలు", "explain X", "మరింత వివరంగా"):
• Find that article in TODAY'S ARTICLES.
• Write 4–5 sentences using ONLY what the "Body:" field contains. Copy verbatim, do not rephrase or add anything.
• If the user says "short" / "సంక్షిప్తంగా": 2–3 sentences from Body.
• If Body says "[HEADLINE ONLY...]": say (in the response language) "Only the headline is available for this article."
• If the article is not found: one sentence saying it is not in today's edition.

⛔ NEVER put summary text inside the **bold** markers alongside the headline.
⛔ NEVER repeat the headline text as the summary. If they match, show only the headline.
⛔ HALLUCINATION FORBIDDEN.
⛔ HALLUCINATION FORBIDDEN: Do not generate descriptions. Print summary text verbatim only.

TODAY'S ARTICLES:
${backendContent}

---
🔴 FINAL LANGUAGE REMINDER: ${langRule}
🔴 FINAL ANTI-HALLUCINATION REMINDER: Do NOT invent numbers (scores, prices, statistics) not in TODAY'S ARTICLES. If relevant articles exist for the topic, show them. Only say "not in paper" when NO relevant articles exist.`;
    }

    // ── DOM fallback — backend not running or no briefing yet ─────────────────
    let todayContent = stripTimestamps(
      (window.NewsAI && window.NewsAI.todayContent)
      || 'Content is loading. Please wait a moment and try again.'
    );

    // Smart topic pre-filter — three-tier fallback:
    // 1. Filter window.NewsAI.articles array (best — has section + body)
    // 2. Extract section block from todayContent string (fallback when articles empty)
    // 3. Inject hard constraint at END of system prompt (catches LLM drift)
    const arts = window.NewsAI && window.NewsAI.articles;
    const fullContent = (window.NewsAI && window.NewsAI.todayContent) || '';
    console.log(`[NewsAI Filter] arts=${arts ? arts.length : 'NONE'} todayContent=${fullContent.length} chars | query="${userMessage.slice(0,60)}"`);
    const topicResult = detectAndFilterTopic(userMessage, arts);
    let topicConstraint = '';
    if (topicResult) {
      const sec = topicResult.section;
      let filtered = null;

      // Method A: filter the structured articles array by section label (most reliable)
      if (topicResult.articles && topicResult.articles.length > 0) {
        filtered = buildTopicContext(sec, topicResult.articles);
        console.log(`[NewsAI Filter] Method A: ${topicResult.articles.length} articles for "${sec}"`);
      }

      // Method B: extract section block from content string (headline block only, no FULL TEXT)
      if (!filtered) {
        const extracted = extractSectionFromContent(fullContent, sec);
        if (extracted) {
          filtered = `${sec} news today:\n${extracted}`;
          console.log(`[NewsAI Filter] Method B: extracted ${extracted.length} chars for "${sec}"`);
        }
      }

      // Method C fallback — if neither method found section-specific content but we DO have
      // a full article list, use it with a topic constraint. This is safer than returning
      // "not available" when articles exist but section tagging failed.
      // Only show "not available" when the page genuinely has no content at all.
      if (!filtered) {
        const hasAnyContent = fullContent && fullContent.length > 50 &&
          !fullContent.startsWith('No articles loaded') &&
          !fullContent.startsWith('Content is loading');
        if (hasAnyContent) {
          // We have articles but section filter failed — give full content + strong constraint
          filtered = fullContent;
          console.log(`[NewsAI Filter] Method C (fallback): passing full content (${fullContent.length} chars) with topic constraint`);
        } else {
          // Genuinely no content — tell the LLM
          filtered = `ఈ రోజు ${sec} వార్తలు అందుబాటులో లేవు. వెబ్‌సైట్ నుండి కంటెంట్ లోడ్ కాలేదు. Today's articles could not be loaded — please refresh the page.`;
          console.warn(`[NewsAI Filter] ⚠️ No content found anywhere. arts=${arts?.length} fullContent="${fullContent.slice(0,50)}"`);
        }
      }

      todayContent = filtered;
      console.log(`[NewsAI Filter] todayContent set to ${todayContent.length} chars`);

      // Hard constraint — always appended regardless of which method succeeded
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
    // (as before) caused English-mode replies to drift back into Telugu.
    const closingLine = isEnglish
      ? 'Ask me which story you would like the full details for.'
      : 'ఏ వార్త పూర్తి వివరాలు కావాలో అడగండి.';
    const notFoundLine = isEnglish
      ? "No [topic] news found in today's edition."
      : 'ఈ రోజు [topic] వార్తలు కనుగొనలేదు.';

    return `You are ${brand.name}, a newspaper AI assistant.

🔴 LANGUAGE OVERRIDE — HIGHEST PRIORITY: ${langRule}
This overrides every previous message in this conversation. Ignore the language used before. ${isEnglish ? "Translate ALL Telugu text in TODAY'S ARTICLES to English. Every word of your response must be English." : "Every word of your response must be Telugu script."}

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
9. NEVER include CMS datelines like "సాక్షి, X జిల్లా:" or any "PublicationName, PlaceName:" prefix. Strip them completely from your output.

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
   • Line 1: Write the Headline in bold: **Headline text** — ONLY the headline inside ** markers.
   • Line 2 (only if Summary field exists AND text differs from Headline): write the summary as plain text on its OWN SEPARATE LINE. Do NOT put it inside the **bold** markers. Do NOT write the word "Summary:".
   • If Body says "[HEADLINE ONLY — DO NOT ADD ANY DESCRIPTION]": NEVER print that tag. Bold headline only, nothing else.
   • If the Headline is just a location or person name with no news action (e.g., "Dr. B R Ambedkar Konaseema" alone): SKIP that item — it is a section divider.
   • Leave a blank line between each article.
→ List ALL articles. End with exactly this sentence: "${closingLine}"
→ If TODAY'S ARTICLES is empty or says "వార్తలు అందుబాటులో లేవు": write "${notFoundLine}" and stop.

⛔ NEVER put summary inside the **bold** markers with the headline.
⛔ NEVER repeat the headline as the summary. If they are the same sentence, show only the headline.
⛔ HALLUCINATION IS FORBIDDEN: Do not write any sentence not in TODAY'S ARTICLES. Print summary verbatim, NEVER the "Summary:" label.

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
      if (isListening) {
        recognition.stop();
        stopListening(el);
      } else {
        startListening(el);
      }
    });
  }

  function playBeep(freq = 660, duration = 120) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
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
      const bubble = msgEl.querySelector('.newsai-bubble');
      const text = bubble ? bubble.textContent.trim() : '';
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

  // Returns true when AI response is a "not in today's paper" refusal — suppress article links.
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

    // Thumbnail strip — only for articles that have imageUrl
    const withImages = valid.filter(a => a.imageUrl && /^https?:\/\//i.test(a.imageUrl));
    if (withImages.length > 0) {
      const thumbStrip = document.createElement('div');
      thumbStrip.className = 'newsai-thumb-strip';
      thumbStrip.innerHTML = withImages.slice(0, 3).map(a =>
        '<a href="' + escAttr(a.url) + '" target="_blank" rel="noopener noreferrer" class="newsai-thumb-link">' +
        '<img class="newsai-thumb" src="' + escAttr(a.imageUrl) + '" alt="' + escAttr(truncateTitle(a.title, 40)) +
        '" loading="lazy" onerror="this.parentElement.style.display=\'none\'">' +
        '</a>'
      ).join('');
      msgEl.appendChild(thumbStrip);
    }

    const container = document.createElement('div');
    container.className = 'newsai-article-links';

    if (valid.length === 1) {
      const link = '<a class="newsai-article-link newsai-article-link--single" href="' + escAttr(valid[0].url) +
        '" target="_blank" rel="noopener noreferrer">📰 Read full article →</a>';
      container.innerHTML = link;
      container.querySelector('a').addEventListener('click', () => {
        track('article_click', { url: valid[0].url });
      });
    } else {
      container.innerHTML = valid.map(a =>
        '<a class="newsai-article-link" href="' + escAttr(a.url) +
        '" target="_blank" rel="noopener noreferrer">📰 ' +
        escHtml(truncateTitle(a.title, 55)) + ' →</a>'
      ).join('');
      container.querySelectorAll('a').forEach((link, i) => {
        link.addEventListener('click', () => {
          track('article_click', { url: valid[i] ? valid[i].url : '' });
        });
      });
    }

    msgEl.appendChild(container);
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
  // voiceLang: lang of the voice that will speak (e.g. 'te-IN', 'hi-IN', 'en-IN').
  // digitsToTeluguWords() only applies for te-IN voices.
  function cleanForSpeech(text, voiceLang) {
    const isTeluguCtx = (text.match(/[ఀ-౿]/g) || []).length > 2;
    const useTeluguDigits = isTeluguCtx && voiceLang && voiceLang.startsWith('te');
    let out = text
      .replace(/\[HEADLINE ONLY[^\]]*\]/gi, '')      // strip internal content marker
      .replace(/\[\d+\]/g, '')
      .replace(/▸|►|•|·|–|—/g, ' ')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/^[\*\-]\s*/gm, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/#{1,6}\s/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\.{2,}/g, '. ')           // .. or ... → single pause
      .replace(/:/g, ', ')                // colons → comma (not "colon")
      .replace(/;/g, ', ')                // semicolons → comma
      .replace(/!/g, '. ')                // ! → period (not "exclamation")
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\bT[-\s]?20I?\b/gi, 'టీ ట్వెంటీ')
      .replace(/\bODI\b/gi, 'వన్ డే').replace(/\bIPL\b/g, 'ఐపీఎల్')
      .replace(/\bBCCI\b/g, 'బీసీసీఐ').replace(/\bNDA\b/g, 'ఎన్డీఏ')
      .replace(/\bUPA\b/g, 'యూపీఏ').replace(/\bBJP\b/g, 'బీజేపీ')
      .replace(/\bCM\b/g, 'సీఎం').replace(/\bPM\b/g, 'పీఎం')
      .replace(/\bMLA\b/g, 'ఎమ్మెల్యే').replace(/\bMP\b/g, 'ఎంపీ')
      .replace(/\bDGP\b/g, 'డీజీపీ').replace(/\bSP\b/g, 'ఎస్పీ').replace(/\bCI\b/g, 'సీఐ')
      .replace(/\bkm\/h\b/gi, 'కిలోమీటర్ పర్ అవర్').replace(/\bkmph\b/gi, 'కిలోమీటర్ పర్ అవర్')
      .replace(/\bkm\b/gi, 'కిలోమీటర్లు').replace(/\bkg\b/gi, 'కిలోగ్రాములు')
      .replace(/\brs\.?\s*/gi, 'రూపాయలు ').replace(/₹\s*/g, 'రూపాయలు ')
      .replace(/%/g, ' శాతం');
    if (isTeluguCtx) {
      out = out.replace(/\s+X\s+/g, ' వర్సస్ ');
      out = out.replace(/\*\*/g, ' ');
      // Digit conversion ONLY for te-IN voice — hi-IN/en-IN can't read Telugu words
      if (useTeluguDigits) out = digitsToTeluguWords(out);
      // Strip ALL remaining Western punctuation — voices read "," as "comma" etc.
      out = out.replace(/[,;:.!?\-।()'"""'']/g, ' ');
      out = out.replace(/\s{2,}/g, ' ');
    }
    return out.trim();
  }

  // ─── Voice Output ─────────────────────────────────────────────────────────
  // Two-tier TTS:
  //   Tier 1: Backend /api/tts — Python edge-tts, te-IN-ShrutiNeural. Works for Telugu.
  //           Text limited to 1000 chars to keep latency under 10s.
  //   Tier 2: Web Speech API — fallback when backend is unavailable.
  //           Telugu: no te-IN voice on this system, so en-IN plays (digits + English only).
  //
  // backendTtsAvailable: null=unchecked, true=working, false=skip this session
  let backendTtsAvailable = null;

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
      .replace(/[ \t]{2,}/g, ' ')       // collapse multiple spaces (NOT newlines)
      .replace(/\n{3,}/g, '\n\n')       // cap at double newline
      .trim();
  }

  async function startSpeaking(btn, text) {
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (currentUtterance?._type === 'backend') { try { currentUtterance.stop(); } catch (_) {} }

    track('tts');
    isSpeaking = true;
    speakingMsgEl = btn;
    currentUtterance = null;
    btn.innerHTML = ICONS.speakerOff + ' <span style="font-size:10px">' + t('speakStop') + '</span>';
    btn.classList.add('newsai-speaking');

    const resetBtn = () => {
      btn.innerHTML = ICONS.speaker; btn.classList.remove('newsai-speaking');
      // Only clear global speaking state if this button is still the active
      // speaker — a stale async callback must not clobber a newer speak request.
      if (speakingMsgEl !== btn) return;
      isSpeaking = false; speakingMsgEl = null; currentUtterance = null;
    };

    // Language for TTS follows the active pill (currentLang), not text-content detection.
    // Pill = 'te' → Telugu backend TTS (te-IN-ShrutiNeural) → Web Speech Telugu fallback.
    // Pill = 'en' → skip backend (it only has a Telugu voice) → Web Speech English directly.
    const lang         = currentLang === 'en' ? 'en' : 'te';
    const isTeluguText = lang === 'te'; // kept for voice-selection logic below

    // Prepare text for backend TTS.
    // Strategy: extract short lines (headlines, ≤120 chars) first — these are the
    // most important content and the backend can add proper gaps between them.
    // If the extracted headlines alone fit within 2000 chars, send only headlines
    // (gives cleaner audio). Otherwise fall back to the first 2000 chars of full text.
    const neuralFull = stripMarkdownForTTS(text);
    const TTS_LIMIT = 2000;
    let neuralText;
    if (neuralFull.length > TTS_LIMIT) {
      // Try extracting only short (headline) lines first.
      // Cap at 6 headlines: each headline = 1 edge-tts call (~1.5s each), so 6 ≈ 9s total — safe within timeout.
      const shortLines = neuralFull.split('\n').filter(l => l.trim().length > 0 && l.trim().length <= 120).slice(0, 6);
      const headlinesOnly = shortLines.join('\n');
      if (headlinesOnly.length >= 30) {
        // Enough headlines to read — limit to TTS_LIMIT chars
        neuralText = headlinesOnly.length > TTS_LIMIT
          ? headlinesOnly.slice(0, headlinesOnly.lastIndexOf('\n', TTS_LIMIT) || TTS_LIMIT)
          : headlinesOnly;
      } else {
        // Fallback: slice full text
        neuralText = neuralFull.slice(0, neuralFull.lastIndexOf(' ', TTS_LIMIT) || TTS_LIMIT);
      }
    } else {
      neuralText = neuralFull;
    }

    // Guard: if stripping markdown left us with nothing, bail — don't send a 400.
    if (!neuralText || !neuralText.trim()) { resetBtn(); return; }

    // ── Tier 1: Backend /api/tts (Sarvam Bulbul v3, WAV output) ─────────────
    // AudioContext created synchronously inside the click handler (gesture context)
    // so Chrome's autoplay permission is granted before the async fetch.
    // Both Telugu and English use Sarvam bulbul:v3 with emotion-aware pace control.
    // AudioContext.decodeAudioData handles WAV natively — no MP3 decoder needed.
    if (backendTtsAvailable !== false) {
      let audioCtx;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
      } catch (_) { audioCtx = null; }

      if (audioCtx) {
        try {
          console.log(`[NewsAI TTS] Backend TTS request (${lang}, ${neuralText.length} chars)...`);
          const resp = await fetch(`${backendBaseUrl}/api/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: neuralText, lang }),
            signal: AbortSignal.timeout(25_000),
          });
          if (resp.ok) {
            backendTtsAvailable = true;
            const arrayBuffer = await resp.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            // Superseded: user started speaking another message while this fetch
            // was in flight — don't start a second, overlapping audio stream.
            if (speakingMsgEl !== btn) { try { audioCtx.close(); } catch (_) {} return; }
            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);
            source.onended = () => { try { audioCtx.close(); } catch (_) {} resetBtn(); };
            source.start();
            currentUtterance = {
              _type: 'backend',
              stop: () => { try { source.stop(); audioCtx.close(); } catch (_) {} },
            };
            console.log(`[NewsAI TTS] ✅ Backend Edge TTS playing (${lang})`);
            return; // success — skip Web Speech fallback
          } else {
            throw new Error(`HTTP ${resp.status}`);
          }
        } catch (e) {
          console.warn('[NewsAI TTS] Backend unavailable, falling back to Web Speech:', e.message);
          try { audioCtx.close(); } catch (_) {}
          // Permanently disable ONLY on HTTP errors (server is up but request is broken).
          // "Failed to fetch" / "NetworkError" = server not running — keep retrying next click.
          // Timeouts = server overloaded — keep retrying too.
          // Check e.name for DOMException types (TimeoutError/AbortError live in .name, not .message)
          // All HTTP errors (4xx and 5xx) are treated as transient — the backend wraps
          // Sarvam API errors as HTTP 500, so a single Sarvam failure must not lock out
          // TTS for the entire session. Only hard auth failures (401/403) could be permanent,
          // but those also come as 500 from our backend, so we retry everything.
          // Network/timeout errors = server unreachable (also transient — keep retrying).
          const isTransient = !e.message
            || e.name === 'TimeoutError'
            || e.name === 'AbortError'
            || /failed to fetch|networkerror|fetch|timed out/i.test(e.message)
            || /HTTP [45]\d\d/.test(e.message);  // 4xx AND 5xx = retry next click
          if (!isTransient) {
            backendTtsAvailable = false;
            console.warn('[NewsAI TTS] Permanently disabling backend TTS (HTTP error)');
          } else {
            // Reset so next click retries the backend (server might start up)
            backendTtsAvailable = null;
          }
        }
      }
    }

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
      toast.textContent = 'Telugu voice not available on this device';
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
    utterance.rate     = 0.92;
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
    if (currentUtterance) {
      if (currentUtterance._type === 'backend') {
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
    // Strip internal content marker — AI sometimes echoes it despite prompt instructions
    text = text.replace(/\[HEADLINE ONLY[^\]]*\]/g, '').replace(/\[ *HEADLINE ONLY[^\]]*\]/gi, '');
    const urls = [];
    const placeholder = text.replace(/https?:\/\/[^\s<>"']+/g, function(url) {
      const clean = url.replace(/[.,;:!?)\]]+$/, '');
      urls.push(clean);
      return '\x01' + (urls.length - 1) + '\x01';
    });
    let html = escHtml(placeholder);
    // Render **bold** headlines — applied after escaping so < > are safe
    html = html.replace(/\*\*([^*\n<]{1,120}?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\x01(\d+)\x01/g, function(_, idx) {
      const url = urls[parseInt(idx, 10)];
      const safeHref = escAttr(url);
      const safeText = escHtml(url).replace(/<br>/g, '');
      return '<a href="' + safeHref + '" target="_blank" rel="noopener noreferrer" ' +
             'style="color:var(--newsai-primary,#C0392B);word-break:break-all;text-decoration:underline;">' +
             safeText + '</a>';
    });
    return html;
  }

  /**
   * Remove repeated sentences/fragments from article body text.
   * Handles RSS/CMS bugs where the same text is copy-pasted many times.
   */
  function dedupContent(text) {
    if (!text || text.length < 60) return text;

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
    try { sessionStorage.setItem('newsai_history', JSON.stringify(conversationHistory)); } catch (_) {}
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
    if (config.backendUrl) backendBaseUrl = config.backendUrl.replace(/\/$/, '');
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

    const el = buildWidget(config);

    // Fetch gemini cache status in background
    fetch(backendBaseUrl + '/api/gemini-cache', { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.active && data.cacheId) {
          geminiCacheId = data.cacheId;
          geminiCacheExpiry = data.expiresAt || 0;
          console.log('[NewsAI] Gemini context cache active:', geminiCacheId);
        }
      })
      .catch(() => {});

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
