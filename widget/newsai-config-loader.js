/**
 * NewsAI Config Loader
 * Loads branding/config from a JSON URL or inline object,
 * exposes window.NewsAI.config, and applies CSS variables.
 *
 * When running as a Chrome extension, config is passed via
 * data-newsai-config DOM attribute (isolated world bridge).
 */
(function () {
  'use strict';

  // ── Chrome Extension bridge ─────────────────────────────────────────────
  // Content scripts run in an isolated JS world; injected scripts run in the
  // main world. sessionStorage is shared between both worlds, making it the
  // most reliable way to pass config. DOM attribute is tried as a fallback.
  (function readExtensionBridge() {
    try {
      // Primary: sessionStorage (most reliable cross-world bridge)
      let raw = null;
      try {
        raw = sessionStorage.getItem('newsai_bridge_config');
        if (raw) sessionStorage.removeItem('newsai_bridge_config');
      } catch (_) {}

      // Fallback: DOM data attribute
      if (!raw) {
        raw = document.documentElement.getAttribute('data-newsai-config');
        if (raw) document.documentElement.removeAttribute('data-newsai-config');
      }

      if (!raw) {
        console.log('[NewsAI] No extension bridge data found (normal for non-extension use).');
        return;
      }

      const data = JSON.parse(raw);
      window.NewsAIConfig = window.NewsAIConfig || {};
      if (data.config)             window.NewsAIConfig.config             = data.config;
      if (data.preloadedContent)   window.NewsAIConfig.preloadedContent   = data.preloadedContent;
      if (data.preloadedArticles)  window.NewsAIConfig.preloadedArticles  = data.preloadedArticles;
      console.log('[NewsAI] ✅ Extension config bridge loaded successfully.',
        window.NewsAIConfig.preloadedArticles?.length || 0, 'articles.');
    } catch (e) {
      console.warn('[NewsAI] Extension bridge read failed:', e.message);
    }
  })();

  const DEFAULT_CONFIG = {
    brand: {
      name: 'News AI',
      shortName: 'N',
      primaryColor: '#C0392B',
      logoUrl: '',
      welcomeMessage: 'నమస్కారం! నేను News AI. ఈ రోజు పేపర్ గురించి ఏదైనా అడగండి!',
      welcomeMessageEn: "Hello! I'm News AI. Ask me anything about today's paper!",
    },
    languages: ['te', 'en'],
    defaultLanguage: 'te',
    sections: ['National', 'State', 'International', 'Sports', 'Business', 'Entertainment'],
    contentSource: { type: 'rss', url: '' },
    anthropicApiKey: '',
    position: 'bottom-right',
  };

  window.NewsAI = window.NewsAI || {};

  /**
   * Apply CSS custom properties from config to document root.
   */
  function applyBrandColors(config) {
    const primary = config.brand.primaryColor || DEFAULT_CONFIG.brand.primaryColor;
    document.documentElement.style.setProperty('--newsai-primary', primary);

    // Derive a darker shade for hover states
    const darker = darkenHex(primary, 15);
    document.documentElement.style.setProperty('--newsai-primary-dark', darker);
  }

  /** Simple hex darkener — reduces each RGB channel by `amount` */
  function darkenHex(hex, amount) {
    const h = hex.replace('#', '');
    const r = Math.max(0, parseInt(h.slice(0, 2), 16) - amount);
    const g = Math.max(0, parseInt(h.slice(2, 4), 16) - amount);
    const b = Math.max(0, parseInt(h.slice(4, 6), 16) - amount);
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Deep-merge two objects (shallow enough for our config shape).
   */
  function mergeConfig(defaults, overrides) {
    const result = Object.assign({}, defaults);
    for (const key of Object.keys(overrides)) {
      if (overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])) {
        result[key] = Object.assign({}, defaults[key] || {}, overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
    return result;
  }

  /**
   * Main loader — accepts a URL string or a config object.
   * Returns a Promise that resolves with the final merged config.
   */
  async function loadConfig(source) {
    let raw = {};

    if (typeof source === 'string') {
      try {
        const resp = await fetch(source);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        raw = await resp.json();
      } catch (err) {
        console.warn('[NewsAI] Could not load config from URL:', source, err.message);
      }
    } else if (source && typeof source === 'object') {
      raw = source;
    }

    const config = mergeConfig(DEFAULT_CONFIG, raw);
    window.NewsAI.config = config;
    applyBrandColors(config);
    return config;
  }

  window.NewsAI.loadConfig = loadConfig;

  // Auto-init if window.NewsAIConfig is present
  const initCfg = window.NewsAIConfig || {};
  const configSource = initCfg.configUrl || initCfg.config || DEFAULT_CONFIG;

  window.NewsAI._configReady = loadConfig(configSource);
})();
