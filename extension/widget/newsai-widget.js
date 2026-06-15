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

  // ─── Client-side rate limiter ────────────────────────────────────────────
  // Gemini free tier = 15 RPM → 1 request per 4 seconds.
  // Persisted in sessionStorage so page refreshes don't reset the counter —
  // otherwise the very first call after any reload bypasses the throttle.
  const GEMINI_MIN_INTERVAL_MS = 4200; // 4.2 s = safe buffer under 15 RPM
  function getLastApiCallTime() {
    try { return parseInt(sessionStorage.getItem('newsai_last_call') || '0', 10); } catch (_) { return 0; }
  }
  function setLastApiCallTime(ts) {
    try { sessionStorage.setItem('newsai_last_call', String(ts)); } catch (_) {}
  }

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
  };

  // ─── Build DOM ─────────────────────────────────────────────────────────────
  function buildWidget(config) {
    const { brand, position, defaultLanguage } = config;
    currentLang = defaultLanguage || 'te';

    // Restore session history + language preference
    try {
      const saved = sessionStorage.getItem('newsai_history');
      if (saved) conversationHistory = JSON.parse(saved);
      const savedLang = sessionStorage.getItem('newsai_lang');
      if (savedLang && (savedLang === 'te' || savedLang === 'en')) currentLang = savedLang;
    } catch (_) {}

    const wrapper = document.createElement('div');
    wrapper.className = 'newsai-wrapper' + (position === 'bottom-left' ? ' newsai-pos-left' : '');
    wrapper.setAttribute('aria-label', 'News AI Chatbot');

    wrapper.innerHTML = `
      <!-- FAB -->
      <button class="newsai-fab" id="newsai-fab" aria-label="Open News AI assistant" title="${brand.name}">
        <span class="newsai-fab-icon">${ICONS.robot}</span>
        <div class="newsai-fab-spinner"></div>
        <span class="newsai-badge" id="newsai-badge">1</span>
      </button>

      <!-- Chat Panel -->
      <div class="newsai-panel" id="newsai-panel" role="dialog" aria-label="${brand.name} chat">
        <!-- Header -->
        <div class="newsai-header">
          <div class="newsai-avatar" id="newsai-avatar">
            ${brand.logoUrl
              ? `<img src="${brand.logoUrl}" alt="${brand.name} logo"/>`
              : `<span>${brand.shortName || brand.name.charAt(0)}</span>`}
          </div>
          <div class="newsai-header-info">
            <div class="newsai-header-name">${brand.name}</div>
            <div class="newsai-header-status">
              <span class="newsai-status-dot"></span>
              <span class="newsai-status-text-online">${t('online')}</span>
              <span class="newsai-status-text-loading">${t('loading')}</span>
            </div>
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
      offline:  $('newsai-offline-banner'),
      notice:   $('newsai-voice-notice'),
    };

    // ── Wire events ──────────────────────────────────────────────────────────
    el.fab.addEventListener('click', () => isOpen ? closePanel(el) : openPanel(el, config));
    el.close.addEventListener('click', () => closePanel(el));
    el.send.addEventListener('click', () => submitMessage(el, config));
    el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitMessage(el, config); } });
    el.input.addEventListener('input', () => { el.send.disabled = !el.input.value.trim(); });

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

    // Render welcome or restore session
    if (conversationHistory.length === 0) {
      renderWelcome(el, config);
    } else {
      restoreMessages(el, conversationHistory);
    }
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
    const chips = currentLang === 'te'
      ? ['ఈ రోజు వార్తలు', 'క్రీడలు', 'సినిమా', 'తెలంగాణ వార్తలు']
      : ['Today\'s digest', 'Sports', 'Cinema', 'Telangana news'];

    const sampleCards = [
      { section: 'National', headline: 'Today\'s top stories loading...' },
      { section: 'Sports', headline: 'Latest sports updates loading...' },
      { section: 'Business', headline: 'Business news loading...' },
    ];

    const msgEl = document.createElement('div');
    msgEl.className = 'newsai-msg newsai-msg-bot';
    msgEl.innerHTML = `
      <div class="newsai-bubble">
        ${escHtml(welcome)}
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
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        ${makeSpeakBtn(welcome)}
        <span class="newsai-msg-time">${timeStr()}</span>
      </div>
    `;
    el.messages.appendChild(msgEl);

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
      msgEl.innerHTML = `
        <div class="newsai-bubble">${escHtml(text)}</div>
        <div style="display:flex;align-items:center;gap:4px">
          ${makeSpeakBtn(text)}
          <span class="newsai-msg-time">${timeStr()}</span>
        </div>
      `;
      wireSpeak(msgEl);
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

    el.input.value = '';
    el.send.disabled = true;
    appendMessage(el.messages, 'user', text);
    conversationHistory.push({ role: 'user', content: text });
    trimHistory();
    saveSession();

    isTyping = true;
    const typingEl = showTyping(el.messages);

    try {
      const reply = await callClaude(config);
      hideTyping();
      const botMsgEl = appendMessage(el.messages, 'bot', reply);
      conversationHistory.push({ role: 'assistant', content: reply });
      trimHistory();
      saveSession();
      // Auto-speak reply when message came from voice input
      if (voiceInputActive) {
        voiceInputActive = false;
        const speakBtn = botMsgEl.querySelector('.newsai-speak-btn');
        if (speakBtn) startSpeaking(speakBtn, reply);
      }
    } catch (err) {
      voiceInputActive = false;
      hideTyping();
      appendMessage(el.messages, 'bot', t('error'));
      console.error('[NewsAI] API error:', err);
    } finally {
      isTyping = false;
    }
  }

  // ─── Provider auto-detect from API key prefix ────────────────────────────
  // Returns 'gemini' | 'groq' | 'anthropic' | 'unknown'.
  // NEVER falls back to 'groq' for unrecognised prefixes — that would silently
  // route an invalid key (e.g. a Google OAuth token starting with "AQ.") to Groq,
  // causing confusing "invalid auth" errors from the wrong API.
  function detectProvider(key) {
    if (!key) return 'unknown';
    if (key.startsWith('AIza'))   return 'gemini';
    if (key.startsWith('gsk_'))   return 'groq';
    if (key.startsWith('sk-ant-')) return 'anthropic';
    return 'unknown';
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
        ? `API కీ గుర్తించలేకపోయాం. Gemini కీ "AIza" తో మొదలవుతుంది, Groq కీ "gsk_" తో మొదలవుతుంది. Extension popup తెరిచి సరైన కీ పేస్ట్ చేయండి.`
        : `API key not recognised (starts with "${apiKey.slice(0, 6)}..."). Gemini keys start with "AIza", Groq keys start with "gsk_". Open the extension popup and paste the correct key.`;
    }

    console.log(`[NewsAI] Calling ${provider} | key prefix: ${apiKey.slice(0, 8)}... | history: ${conversationHistory.length} msgs`);

    if (window.NewsAI) {
      window.NewsAI.contentBudget = (provider === 'gemini') ? 6000 : 2200;
    }

    // ── Client-side throttle for Gemini free tier (15 RPM = 4 s/request) ──
    // Persisted in sessionStorage so page refreshes don't reset the counter.
    if (provider === 'gemini') {
      const last = getLastApiCallTime();
      const elapsed = Date.now() - last;
      if (last > 0 && elapsed < GEMINI_MIN_INTERVAL_MS) {
        const wait = GEMINI_MIN_INTERVAL_MS - elapsed;
        console.log(`[NewsAI] Throttle: waiting ${(wait / 1000).toFixed(1)}s to stay under Gemini 15 RPM...`);
        await countdownWait(Math.ceil(wait / 1000));
      }
      setLastApiCallTime(Date.now());
    }

    const systemPrompt = buildSystemPrompt(config);
    const messages = conversationHistory.slice(-MAX_HISTORY);

    if (provider === 'gemini')    return callGemini(apiKey, systemPrompt, messages);
    if (provider === 'anthropic') return callAnthropic(apiKey, systemPrompt, messages);
    return callGroq(apiKey, systemPrompt, messages, config.llmModel);
  }

  async function callGroq(apiKey, systemPrompt, messages, model, _retries = 0) {
    // Always use llama-3.1-8b-instant (20k TPM free). Reject the 70b model
    // even if it appears in config — it has only 6k TPM and hits limits fast.
    const chosenModel = (model === 'llama-3.3-70b-versatile' || !model)
      ? 'llama-3.1-8b-instant'
      : model;

    const body = JSON.stringify({
      model: chosenModel,
      max_tokens: 700,  // 700 tokens — enough for DIGEST mode without wasting TPM budget
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    });

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body,
    });

    if (resp.status === 429 && _retries < 1) {
      // Rate limited — parse retry-after, wait with visible countdown, then try ONCE more
      const err = await resp.json().catch(() => ({}));
      const msg = err.error?.message || '';
      const waitMatch = msg.match(/try again in ([\d.]+)s/i);
      const waitSec = waitMatch ? Math.max(5, Math.ceil(parseFloat(waitMatch[1])) + 1) : 8;
      console.warn(`[NewsAI] Groq rate limited — retrying in ${waitSec}s...`);
      await countdownWait(waitSec); // shows tick-by-tick countdown in typing bubble
      return callGroq(apiKey, systemPrompt, messages, chosenModel, _retries + 1);
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
    const data = await resp.json();
    return data.choices[0].message.content;
  }

  async function callAnthropic(apiKey, systemPrompt, messages) {
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
        max_tokens: 400,
        system: systemPrompt,
        messages,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return data.content[0].text;
  }

  // ─── Gemini 2.0 Flash ─────────────────────────────────────────────────────
  async function callGemini(apiKey, systemPrompt, messages, _retries = 0) {
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    // Deduplicate consecutive same-role messages (Gemini rejects them)
    const deduped = contents.filter((m, i) => i === 0 || m.role !== contents[i - 1].role);
    // Gemini requires first message to be 'user' — drop any leading 'model' turns
    while (deduped.length > 0 && deduped[0].role !== 'user') deduped.shift();
    if (!deduped.length) throw new Error('No user messages to send to Gemini');

    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: deduped,
      generationConfig: { maxOutputTokens: 600, temperature: 0.4, topP: 0.9 },
    };

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );

    if (resp.status === 429) {
      const errBody = await resp.json().catch(() => ({}));
      // Parse retryDelay from Gemini's RetryInfo detail if present
      const retryDetail = errBody.error?.details?.find(d => d.retryDelay);
      // Gemini returns retryDelay as "Xs" string; parseInt handles "60s" → 60.
      // Enforce minimum 10s so a "1s" hint doesn't immediately re-fire into the limit.
      const retrySeconds = Math.max(10, retryDetail
        ? parseInt(retryDetail.retryDelay, 10) || 15
        : 15);
      if (_retries < 2) {
        console.warn(`[NewsAI] Gemini rate limited — retrying in ${retrySeconds}s (attempt ${_retries + 1}/2)...`);
        // Countdown in the typing bubble so the user knows what's happening
        await countdownWait(retrySeconds);
        return callGemini(apiKey, systemPrompt, messages, _retries + 1);
      }
      throw new Error(currentLang === 'te'
        ? `చాలా ప్రశ్నలు వేశారు. ఒక నిమిషం తర్వాత మళ్ళీ ప్రయత్నించండి.`
        : `Rate limited — Gemini's free tier allows 15 requests/min. Wait ${retrySeconds}s and try again.`);
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
  function buildSystemPrompt(config) {
    const { brand, sections } = config;
    const todayContent = (window.NewsAI && window.NewsAI.todayContent) || 'Today\'s content is still loading.';
    const langRule = currentLang === 'te'
      ? 'OUTPUT LANGUAGE: TELUGU ONLY. Every single word must be in Telugu script. No English words at all.'
      : 'OUTPUT LANGUAGE: ENGLISH ONLY. Every word in English. No Telugu script at all.';

    return `You are ${brand.name}, an AI news assistant. ${langRule}

RESPONSE MODES — choose automatically based on the user's request:

MODE 1 — DIGEST
Trigger: user asks for "today's news", "daily feed", "headlines", "updates", "what happened today", "news digest", or similar.
Format: List EVERY article grouped by section. For each article write exactly:
• [Headline] — [one sentence explaining what the news is about]
Cover ALL sections and ALL articles without skipping any. Keep each subline to one sentence. End with: "Say any headline for the full story."

MODE 2 — SECTION
Trigger: user names a section (sports, cricket, cinema, movies, politics, national, telangana, business, etc.)
Format: List EVERY article in that section:
• [Headline] — [one sentence]
End with: "Say any headline for full details."

MODE 3 — DETAIL
Trigger: user asks about a specific article, topic, or says "tell me more about [X]".
Format: 4 to 6 clear sentences explaining: what happened, who was involved, where, and why it matters.
If the article has no body text (only a headline), say so clearly and share the URL so the user can read it.

RULES:
- Answer ONLY from the articles below. Never invent facts or use general knowledge.
- No markdown. No asterisks. No # headers. Plain text only.
- Be concise — the user may be listening while driving.
- If a topic is not in today's paper, say so in one sentence.

TODAY'S NEWS (${(sections || []).join(', ')}):
${todayContent}

---
${langRule}`;
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
          background:#C0392B; color:#fff; padding:6px 16px; border-radius:20px;
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
    el.input.style.borderColor = '#C0392B';
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

  // Strip markdown symbols so TTS reads clean prose, not "asterisk" or "bullet"
  function cleanForSpeech(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
      .replace(/\*(.+?)\*/g, '$1')        // *italic* → italic
      .replace(/^[\*\-•]\s*/gm, '')       // bullet points at line start
      .replace(/`([^`]+)`/g, '$1')        // `code` → code
      .replace(/#{1,6}\s/g, '')           // ## headers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link](url) → link
      .replace(/\n{3,}/g, '\n\n')         // collapse excess blank lines
      .replace(/;/g, ',')                 // semicolons → pause-friendly commas
      .trim();
  }

  // ─── Voice Output ─────────────────────────────────────────────────────────
  // Two-tier TTS:
  //   Tier 1: Backend /api/tts → Microsoft Edge neural voices (te-IN-MohanNeural etc.)
  //           Much higher quality, especially for Telugu. Requires the backend running.
  //   Tier 2: Web Speech API fallback — works without backend but Telugu quality is poor.
  //
  // AudioContext trick: create AudioContext synchronously inside the click handler so
  // Chrome's autoplay permission is granted, then do the async backend fetch & decode.
  // The already-unlocked AudioContext plays audio even after the async gap.
  //
  // backendTtsAvailable: null = not checked yet, true = working, false = unavailable.

  const BACKEND_TTS_URL = 'http://localhost:3001';
  let backendTtsAvailable = null;

  async function startSpeaking(btn, text) {
    if (window.speechSynthesis) speechSynthesis.cancel();

    isSpeaking = true;
    speakingMsgEl = btn;
    currentUtterance = null;
    btn.innerHTML = ICONS.speakerOff + ' <span style="font-size:10px">' + t('speakStop') + '</span>';
    btn.classList.add('newsai-speaking');

    const resetBtn = () => {
      isSpeaking = false; speakingMsgEl = null; currentUtterance = null;
      btn.innerHTML = ICONS.speaker; btn.classList.remove('newsai-speaking');
    };

    const cleanText     = cleanForSpeech(text);
    const isTeluguText  = (text.match(/[ఀ-౿]/g) || []).length > 2;
    const lang          = isTeluguText ? 'te' : 'en';

    // ── Tier 1: Backend Edge TTS ────────────────────────────────────────────
    if (backendTtsAvailable !== false) {
      // Create AudioContext NOW (synchronous, inside user-gesture call stack).
      // Chrome grants autoplay permission at this point. After the async fetch,
      // the context is already unlocked so source.start() will work.
      let audioCtx;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
      } catch (_) {
        audioCtx = null;
      }

      if (audioCtx) {
        try {
          const resp = await fetch(`${BACKEND_TTS_URL}/api/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanText, lang }),
            signal: AbortSignal.timeout(20_000),
          });

          if (resp.ok) {
            backendTtsAvailable = true;
            const arrayBuffer = await resp.arrayBuffer();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

            const source = audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioCtx.destination);
            source.onended = () => { try { audioCtx.close(); } catch (_) {} resetBtn(); };
            source.start();

            // Store stop handle for stopSpeaking()
            currentUtterance = {
              _type: 'backend',
              stop: () => { try { source.stop(); audioCtx.close(); } catch (_) {} },
            };
            console.log(`[NewsAI TTS] Backend Edge TTS playing (${lang})`);
            return; // ✅ success — skip Web Speech fallback
          } else {
            throw new Error(`HTTP ${resp.status}`);
          }
        } catch (e) {
          console.log('[NewsAI TTS] Backend unavailable, falling back to Web Speech API:', e.message);
          try { audioCtx.close(); } catch (_) {}
          backendTtsAvailable = false;
        }
      }
    }

    // ── Tier 2: Web Speech API fallback ────────────────────────────────────
    if (!window.speechSynthesis) { resetBtn(); return; }

    const voices = cachedVoices.length ? cachedVoices : speechSynthesis.getVoices();
    let voice;
    if (isTeluguText) {
      voice = voices.find(v => v.lang === 'te-IN')
        || voices.find(v => v.lang.startsWith('te'))
        || voices.find(v => v.lang === 'hi-IN')
        || voices.find(v => v.lang.startsWith('hi'))
        || voices.find(v => v.lang === 'en-IN')
        || voices.find(v => v.lang.startsWith('en'))
        || voices[0] || null;
    } else {
      voice = voices.find(v => v.lang === 'en-IN')
        || voices.find(v => v.lang === 'en-US')
        || voices.find(v => v.lang.startsWith('en'))
        || voices[0] || null;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang  = isTeluguText ? 'te-IN' : 'en-IN';
    if (voice) utterance.voice = voice;
    utterance.rate  = 0.92;
    utterance.onend = resetBtn;
    utterance.onerror = (e) => { console.warn('[NewsAI TTS]', e.error); resetBtn(); };

    currentUtterance = { _type: 'webspeech', utterance };
    speechSynthesis.speak(utterance);
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
