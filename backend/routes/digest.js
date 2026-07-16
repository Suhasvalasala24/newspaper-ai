'use strict';

/**
 * Pre-generated Daily Digest — GET /api/digest
 *
 * After XML ingest, we call Gemini Flash-Lite to produce a Telugu + English
 * summary of today's top stories. This is cached in memory so the first user
 * who opens the widget sees the digest instantly (no Gemini call at chat time).
 *
 * GET /api/digest → { te, en, generatedAt, ready }
 */

const GEMINI_MODEL   = 'gemini-2.5-flash-lite';
const DIGEST_TIMEOUT = 30000;   // 30s — digest can take a moment with 200 articles

// ── Module state ─────────────────────────────────────────────────────────────
let digestCache = { te: null, en: null, generatedAt: null };
let digestRunning = false;

// ── Call Gemini for one language ──────────────────────────────────────────────
async function callGeminiDigest(contextStr, lang) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const langName  = lang === 'te' ? 'Telugu' : 'English';
  const langInstr = lang === 'te'
    ? 'Write entirely in Telugu script (తెలుగు). Every word must be Telugu — only proper nouns (politician names, places, party names) may stay in their original script.'
    : 'Write entirely in English. Translate all Telugu article titles to English.';

  const prompt = `Summarise today's top 10 news stories from this newspaper in ${langName}. ${langInstr}

FORMAT: Use bullet points. For each story:
• **Bold headline** — one sentence description (what happened, who, where).

Rules:
- ONLY use facts from the articles provided below.
- NEVER invent statistics, scores, names, or events not in the articles.
- Be concise — one sentence per story.
- Do not include URLs.

${contextStr}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 2048, temperature: 0.1 },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIGEST_TIMEOUT);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Gemini ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from Gemini');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ── Build context from articles (top 20 by section variety) ──────────────────
function buildDigestContext(articles) {
  // Pick up to top 20 articles spread across sections
  const bySec = {};
  for (const a of articles) {
    if (!bySec[a.section]) bySec[a.section] = [];
    if (bySec[a.section].length < 3) bySec[a.section].push(a);
  }
  const selected = Object.values(bySec).flat().slice(0, 20);

  let ctx = '';
  for (const a of selected) {
    ctx += `[${a.section}] ${a.title}\n`;
    if (a.content && a.content.length > 30) {
      ctx += `${a.content.slice(0, 400)}\n`;
    }
    ctx += '\n';
  }
  return ctx;
}

// ── Public: generate digest (called in background after ingest) ───────────────
async function generateDigest(articles) {
  if (digestRunning) return;                          // already running
  if (digestCache.te && digestCache.en) return;       // already done today
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[NewsAI Digest] GEMINI_API_KEY not set — skipping digest');
    return;
  }
  if (!articles || articles.length === 0) {
    console.warn('[NewsAI Digest] No articles — skipping digest');
    return;
  }

  digestRunning = true;
  try {
    const ctx = buildDigestContext(articles);
    console.log(`[NewsAI Digest] Generating digest from ${articles.length} articles...`);

    const [te, en] = await Promise.all([
      callGeminiDigest(ctx, 'te').catch(e => { console.warn('[NewsAI Digest] Telugu failed:', e.message); return null; }),
      callGeminiDigest(ctx, 'en').catch(e => { console.warn('[NewsAI Digest] English failed:', e.message); return null; }),
    ]);

    digestCache = { te, en, generatedAt: new Date().toISOString() };
    console.log(`[NewsAI Digest] ✅ Done — te:${!!te} en:${!!en}`);
  } catch (err) {
    console.warn('[NewsAI Digest] Generation failed:', err.message);
    // Leave digestCache as-is (null values) — don't break anything
  } finally {
    digestRunning = false;
  }
}

// ── Route: GET /api/digest ───────────────────────────────────────────────────
function getDigest(req, res) {
  res.json({
    te:          digestCache.te,
    en:          digestCache.en,
    generatedAt: digestCache.generatedAt,
    ready:       !!(digestCache.te || digestCache.en),
  });
}

// ── Clear on midnight reset ───────────────────────────────────────────────────
function clearDigest() {
  digestCache  = { te: null, en: null, generatedAt: null };
  digestRunning = false;
}

module.exports = { generateDigest, getDigest, clearDigest };
