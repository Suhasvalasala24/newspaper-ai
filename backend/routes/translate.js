'use strict';

/**
 * /api/translate  — English → Telugu translation using Meta NLLB-200
 *
 * Uses the HuggingFace free Inference API (no billing required).
 * Model: facebook/nllb-200-distilled-600M
 *   - Trained on 200 languages including Telugu (tel_Telu)
 *   - 600M parameter distilled model — fast enough for article-length text
 *   - Free tier: ~30k requests/month, ~5–15 s latency (model cold-starts)
 *
 * Set HF_API_KEY env var for faster warm inference (free HF account token).
 * Without the key it still works but may have cold-start delays.
 *
 * Usage: POST /api/translate
 * Body: { text: "English text here", targetLang?: "te" | "hi" }
 * Response: { translated: "తెలుగు టెక్స్ట్ ఇక్కడ" }
 */

const HF_MODEL  = 'facebook/nllb-200-distilled-600M';
const HF_URL    = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

// NLLB language codes
const LANG_CODES = {
  te: 'tel_Telu',   // Telugu
  hi: 'hin_Deva',   // Hindi
  ta: 'tam_Taml',   // Tamil
  en: 'eng_Latn',   // English
};

// Simple heuristic: text is "English-heavy" if <20% of characters are Telugu script
function isEnglishHeavy(text) {
  if (!text) return false;
  const teluguChars = (text.match(/[ఀ-౿]/g) || []).length;
  return teluguChars / text.length < 0.2;
}

async function translateText(text, targetLang = 'te') {
  const tgtCode = LANG_CODES[targetLang] || 'tel_Telu';
  const srcCode = 'eng_Latn';

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.HF_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.HF_API_KEY}`;
  }

  // NLLB expects: inputs = source text, parameters.src_lang, parameters.tgt_lang
  const body = JSON.stringify({
    inputs: text.slice(0, 2000), // NLLB handles ~512 tokens; truncate long inputs
    parameters: {
      src_lang:       srcCode,
      tgt_lang:       tgtCode,
      max_new_tokens: 400,
    },
  });

  const resp = await fetch(HF_URL, { method: 'POST', headers, body });

  if (!resp.ok) {
    const err = await resp.text();
    // Model loading (503) is normal for cold starts — tell caller to retry
    if (resp.status === 503) throw new Error('MODEL_LOADING');
    throw new Error(`HF API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  // Response shape: [{ translation_text: "..." }]
  const translated = data?.[0]?.translation_text || data?.translation_text;
  if (!translated) throw new Error('No translation in response');
  return translated;
}

// ── Route handler ──────────────────────────────────────────────────────────────
async function translate(req, res) {
  const { text, targetLang = 'te', force = false } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  // Skip translation if already Telugu (unless forced)
  if (!force && !isEnglishHeavy(text)) {
    return res.json({ translated: text, skipped: true, reason: 'already Telugu' });
  }

  try {
    console.log(`[NewsAI Translate] Translating ${text.length} chars → ${targetLang}`);
    const translated = await translateText(text.trim(), targetLang);
    console.log(`[NewsAI Translate] Done: "${translated.slice(0, 80)}..."`);
    res.json({ translated });
  } catch (err) {
    if (err.message === 'MODEL_LOADING') {
      // HuggingFace cold start — model loading, retry in 20s
      return res.status(503).json({
        error:   'Translation model is warming up. Retry in 20 seconds.',
        retryMs: 20000,
      });
    }
    console.error('[NewsAI Translate]', err.message);
    // Graceful degradation: return original text so widget still works
    res.json({ translated: text, error: err.message, fallback: true });
  }
}

// ── Batch route: translate multiple article content fields at once ─────────────
async function translateBatch(req, res) {
  const { articles, targetLang = 'te' } = req.body;
  if (!Array.isArray(articles)) {
    return res.status(400).json({ error: 'articles array is required' });
  }

  const results = [];
  for (const article of articles.slice(0, 10)) { // max 10 per batch
    if (!article.content || !isEnglishHeavy(article.content)) {
      results.push({ ...article, contentTe: article.content });
      continue;
    }
    try {
      const contentTe = await translateText(article.content, targetLang);
      results.push({ ...article, contentTe });
    } catch (_) {
      results.push({ ...article, contentTe: article.content, translateError: true });
    }
  }
  res.json({ articles: results });
}

module.exports = { translate, translateBatch, isEnglishHeavy, translateText };
