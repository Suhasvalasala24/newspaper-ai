'use strict';

const https = require('https');
const store = require('../store/articleStore');

/**
 * HuggingFace semantic embedding for Telugu + multilingual article search.
 *
 * Model: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
 *   — 50+ languages including Telugu
 *   — 384-dim dense vectors, cosine similarity
 *   — Free on HF Inference API (no billing)
 *   — ~200-500ms when warm, ~20s cold start (first call after idle)
 *
 * Flow:
 *   1. POST /api/embed        — after articles are ingested, batch-embed titles (background)
 *   2. POST /api/query        — if keyword score is weak, embedText(query) → hybrid search
 *
 * Set HF_API_KEY environment variable for faster rate limits and warm model:
 *   export HF_API_KEY=hf_xxxxxxxxxxxxxxxxxxxx
 */

const HF_MODEL     = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
const BATCH_SIZE   = 32;    // HF accepts up to ~100 inputs; 32 is conservative for free tier
const BATCH_DELAY  = 500;   // ms between batches — respect free-tier rate limits

// ── Core HuggingFace API call ────────────────────────────────────────────────
/**
 * POST to HF Feature Extraction API with an array of texts.
 * Returns: [ [384 floats], [384 floats], ... ] — one vector per input text.
 */
function hfFeatureExtract(texts, hfApiKey, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      inputs:  texts,
      options: { wait_for_model: true },  // wait instead of error on cold start
    });

    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (hfApiKey) headers['Authorization'] = `Bearer ${hfApiKey}`;

    const req = https.request(
      {
        hostname: 'api-inference.huggingface.co',
        path:     `/models/${HF_MODEL}`,
        method:   'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(`HF API: ${parsed.error}`));
            resolve(parsed);
          } catch (e) {
            reject(new Error(`HF parse error: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`HF timeout after ${timeoutMs}ms`));
    });

    req.write(body);
    req.end();
  });
}

// ── Public helper: embed a single query text ────────────────────────────────
/**
 * Embed one query string. Used by query.js for semantic fallback.
 * Returns a 384-dim float array, or null if HF is unavailable/too slow.
 * Uses a shorter timeout (2s) so the widget's 3s API timeout isn't exceeded.
 */
async function embedText(text, hfApiKey, timeoutMs = 2000) {
  try {
    const result = await hfFeatureExtract([text], hfApiKey, timeoutMs);
    return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : null;
  } catch (e) {
    // HF cold start or rate limit — not an error from the user's perspective.
    // query.js falls back to keyword-only results when this returns null.
    console.warn(`[NewsAI Embed] Query embed skipped: ${e.message}`);
    return null;
  }
}

// ── Route: POST /api/embed ───────────────────────────────────────────────────
/**
 * Batch-embeds all articles that don't have embeddings yet.
 * Responds immediately (202 Accepted) and runs in background.
 * Called by newsai-content.js after articles are ingested.
 *
 * Body: { hfApiKey?: string }   — optional, falls back to HF_API_KEY env var
 */
async function embedArticles(req, res) {
  const hfApiKey = req.body?.hfApiKey || process.env.HF_API_KEY || null;
  const pending  = store.getArticlesForEmbedding();
  const stats    = store.getEmbeddingStats();

  if (!pending.length) {
    return res.json({
      message: 'All articles already embedded',
      ...stats,
    });
  }

  // Respond immediately — embedding is background work
  res.status(202).json({
    message: `Embedding ${pending.length} articles in background`,
    pending: pending.length,
    batches: Math.ceil(pending.length / BATCH_SIZE),
    already: stats.withEmbedding,
  });

  // ── Background: batch-embed ────────────────────────────────────────────────
  let embedded = 0;
  let failed   = 0;

  // Quick connectivity check — if HF is unreachable (DNS failure), skip all
  // batches immediately rather than logging one error per batch.
  try {
    await hfFeatureExtract(['test'], hfApiKey, 5000);
  } catch (e) {
    const isDnsOrNetwork = e.message.includes('ENOTFOUND') || e.message.includes('ECONNREFUSED')
      || e.message.includes('getaddrinfo') || e.message.includes('network');
    if (isDnsOrNetwork) {
      console.warn('[NewsAI Embed] HuggingFace unreachable (no internet?) — skipping embedding. Keyword search will still work.');
      return;
    }
    // Cold start / 503 — proceed with batch loop, it may recover
  }

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    try {
      const texts   = batch.map(a => a.text);
      const vectors = await hfFeatureExtract(texts, hfApiKey, 30000);

      if (Array.isArray(vectors)) {
        for (let j = 0; j < batch.length; j++) {
          if (Array.isArray(vectors[j])) {
            store.setEmbedding(batch[j].id, vectors[j]);
            embedded++;
          }
        }
      }

      // Delay between batches to stay within free-tier limits
      if (i + BATCH_SIZE < pending.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    } catch (e) {
      failed += batch.length;
      // Only log first failure — subsequent failures are almost certainly the same cause
      if (batchNum === 1) {
        console.warn(`[NewsAI Embed] Batch embedding failed: ${e.message}. Keyword search unaffected.`);
      }
      // If DNS/network error, abort remaining batches (pointless to keep trying)
      if (e.message.includes('ENOTFOUND') || e.message.includes('getaddrinfo')) {
        failed += pending.length - (i + BATCH_SIZE);
        break;
      }
    }
  }

  const finalStats = store.getEmbeddingStats();
  if (embedded > 0) {
    console.log(`[NewsAI Embed] ✅ Done: ${embedded} embedded, ${failed} failed | ${finalStats.withEmbedding}/${finalStats.total} articles have vectors`);
  }
}

// ── Route: GET /api/embed/status ─────────────────────────────────────────────
function embedStatus(req, res) {
  res.json(store.getEmbeddingStats());
}

module.exports = { embedArticles, embedStatus, embedText };
