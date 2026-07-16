'use strict';

/**
 * /api/translate  — English → Telugu translation using Gemini Flash-Lite
 *
 * Primary: Google Gemini (gemini-2.5-flash-lite) via the generateContent API.
 *   - Set GEMINI_API_KEY env var (same key used by the rest of the project).
 *   - Fast, no cold-starts, strong Telugu/Hindi quality for news content.
 *
 * Fallback: Meta NLLB-200 on the HuggingFace free Inference API.
 *   - Used automatically when GEMINI_API_KEY is not set.
 *   - Model: facebook/nllb-200-distilled-600M (free tier, may cold-start).
 *   - Optional HF_API_KEY env var for faster warm inference.
 *
 * Usage: POST /api/translate
 * Body: { text: "English text here", targetLang?: "te" | "hi" }
 * Response: { translated: "తెలుగు టెక్స్ట్ ఇక్కడ" }
 */

// ── Gemini (primary) ────────────────────────────────────────────────────────────
const GEMINI_MODEL      = 'gemini-2.5-flash-lite';
const GEMINI_TIMEOUT_MS = 10000; // 10 s hard cap — degrade gracefully past that

const GEMINI_SYSTEM_INSTRUCTION =
  'You are a professional Telugu-English translator specializing in Indian news content. ' +
  'Translate accurately. Preserve proper nouns — Indian names, places, political party names — ' +
  'exactly as they are. Do not add explanations or notes. Return ONLY the translated text.';

// Human-readable target language names for the Gemini prompt
const LANG_NAMES = {
  te: 'Telugu',
  hi: 'Hindi',
  ta: 'Tamil',
  en: 'English',
};

// ── HuggingFace NLLB-200 (fallback) ────────────────────────────────────────────
const HF_MODEL  = 'facebook/nllb-200-distilled-600M';
const HF_URL    = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

// NLLB language codes
const LANG_CODES = {
  te: 'tel_Telu',   // Telugu
  hi: 'hin_Deva',   // Hindi
  ta: 'tam_Taml',   // Tamil
  en: 'eng_Latn',   // English
};

let warnedNoGeminiKey = false;

// Simple heuristic: text is "English-heavy" if <20% of characters are Telugu script
function isEnglishHeavy(text) {
  if (!text) return false;
  const teluguChars = (text.match(/[ఀ-౿]/g) || []).length;
  return teluguChars / text.length < 0.2;
}

// ── Gemini translation ─────────────────────────────────────────────────────────
async function translateWithGemini(text, targetLang = 'te') {
  const targetName = LANG_NAMES[targetLang] || 'Telugu';
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` +
    `?key=${process.env.GEMINI_API_KEY}`;

  const body = JSON.stringify({
    systemInstruction: {
      parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: `Translate the following to ${targetName}: ${text.slice(0, 2000)}` }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
    },
  });

  // 10-second timeout — Gemini is normally sub-second for article-length text
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal:  controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Gemini timeout after ${GEMINI_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!translated) throw new Error('No translation in Gemini response');
  return translated;
}

// ── NLLB-200 translation (fallback when GEMINI_API_KEY is missing) ─────────────
async function translateWithNLLB(text, targetLang = 'te') {
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
    throw new Error(`HF API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  // Response shape: [{ translation_text: "..." }]
  const translated = data?.[0]?.translation_text || data?.translation_text;
  if (!translated) throw new Error('No translation in response');
  return translated;
}

// ── Dispatcher: Gemini if key present, otherwise NLLB-200 ──────────────────────
async function translateText(text, targetLang = 'te') {
  if (process.env.GEMINI_API_KEY) {
    return translateWithGemini(text, targetLang);
  }
  if (!warnedNoGeminiKey) {
    console.warn('[NewsAI Translate] GEMINI_API_KEY not set — falling back to HuggingFace NLLB-200');
    warnedNoGeminiKey = true;
  }
  return translateWithNLLB(text, targetLang);
}

// ── Route handler ──────────────────────────────────────────────────────────────
async function translate(req, res) {
  const { text, targetLang = 'te', force = false } = req.body;

  // typeof check: non-string text would make .trim() throw inside this async
  // handler — unhandled rejection crashes the process under Express 4 / Node 18.
  if (!text || typeof text !== 'string' || !text.trim()) {
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
    // Non-string content would throw inside isEnglishHeavy (.match on a number)
    // and crash the process via unhandled rejection — treat it as untranslatable.
    if (!article || typeof article !== 'object') { results.push(article); continue; }
    if (!article.content || typeof article.content !== 'string' || !isEnglishHeavy(article.content)) {
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
