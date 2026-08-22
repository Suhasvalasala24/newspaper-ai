'use strict';

const path  = require('path');
const store = require('../store/articleStore');

/**
 * LOCAL semantic embedding for Telugu + multilingual article search.
 *
 * Model: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (ONNX / transformers.js)
 *   — 50+ languages including Telugu
 *   — 384-dim dense vectors, cosine similarity
 *   — Runs entirely in-process via @huggingface/transformers (v3) — NO API key,
 *     NO network calls after the one-time model download (~50 MB, cached on disk)
 *
 * NOTE (Bug 2 fix): switched from @xenova/transformers v2 to @huggingface/transformers
 *   v3. The v2 WASM backend failed on macOS ARM64 with "protobuf parsing failed /
 *   Can't create a session" (its bundled onnxruntime-web WASM couldn't parse the
 *   model). v3 ships a modern onnxruntime with proper Node.js (onnxruntime-node)
 *   support and no blob-worker issues. The `pipeline` API is identical.
 *
 * WHY LOCAL (was: HuggingFace Inference API):
 *   The old implementation POSTed to api-inference.huggingface.co, which HuggingFace
 *   has deprecated in favour of the router-based Inference Providers API. Feature
 *   extraction for sentence-transformers models now frequently returns errors that
 *   the old code misclassified as "unreachable / no internet", leaving embeds 0/N
 *   and semantic search dead. Local inference removes the external dependency
 *   entirely: no HF_API_KEY needed, no rate limits, no cold starts after warm-up.
 *
 * SETUP after this change: run `npm install` (pulls @huggingface/transformers v3)
 *   and delete the stale cache once — `rm -rf backend/.models/` — so the model
 *   re-downloads clean (the old files triggered the "protobuf parsing failed" error).
 *
 * Flow:
 *   1. POST /api/embed        — after articles are ingested, batch-embed titles (background)
 *   2. embedText(query)       — query.js embeds the query for hybrid semantic search
 *
 * First run downloads the model to backend/.models/ then works fully offline.
 * If the model fails to load (e.g. no internet on first run), embedding is skipped
 * gracefully and keyword search continues to work — same fallback contract as before.
 */

const EMBED_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const MODEL_DIR    = path.join(__dirname, '..', '.models');  // on-disk model cache
const BATCH_SIZE   = 32;    // articles per inference call

// ── Lazy singleton for the local feature-extraction pipeline ─────────────────
// @huggingface/transformers is ESM-only, so it is loaded via dynamic import()
// from this CommonJS module. The pipeline is built once and reused for all calls.
let extractorPromise = null;
let modelState = 'idle';   // idle | loading | ready | error
let modelError = null;

function getExtractor() {
  if (!extractorPromise) {
    modelState = 'loading';
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');

      // ── WASM safety belt (kept from the v2 fix) ─────────────────────────────
      // @huggingface/transformers v3 uses onnxruntime-node's native backend on
      // Node by default (proper macOS ARM64 support — this is why we switched off
      // @xenova v2, whose bundled WASM hit "protobuf parsing failed / Can't create
      // a session"). If v3 ever falls back to WASM, force single-threaded, non-
      // proxied execution so it still runs in the main thread with NO worker —
      // sidestepping the old `blob:nodedata:…` worker crash. Harmless when native.
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;      // no multi-threaded worker pool
        env.backends.onnx.wasm.proxy      = false;  // run in main thread, not a worker proxy
      }

      // Cache/serve the model from backend/.models (absolute path). The model is
      // already present on disk here, so no network is used; allowRemoteModels is
      // kept true only for the one-time first download on a fresh machine.
      env.cacheDir          = MODEL_DIR;
      env.localModelPath    = MODEL_DIR;
      env.allowRemoteModels = true;

      const extractor = await pipeline('feature-extraction', EMBED_MODEL);
      modelState = 'ready';
      console.log(`[NewsAI Embed] ✅ Local embedding model ready: ${EMBED_MODEL} (WASM, single-threaded)`);
      return extractor;
    })().catch((err) => {
      // Reset so a later call can retry (e.g. once connectivity returns).
      extractorPromise = null;
      modelState = 'error';
      modelError = err.message;
      throw err;
    });
  }
  return extractorPromise;
}

/**
 * Embed an array of texts locally. Returns [ [384 floats], ... ] — one vector
 * per input, mean-pooled and L2-normalised (cosine-ready).
 */
async function embedLocal(texts) {
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  // output is a Tensor: dims = [batch, dim], data = flat Float32Array
  const [n, dim] = output.dims;
  const vectors = [];
  for (let i = 0; i < n; i++) {
    vectors.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

// ── Public helper: embed a single query text ────────────────────────────────
/**
 * Embed one query string. Used by query.js for the semantic fallback.
 * Returns a 384-dim float array, or null if the local model is unavailable.
 *
 * Signature kept backward-compatible: the 2nd/3rd args (formerly hfApiKey,
 * timeoutMs) are accepted and ignored so existing callers don't break.
 */
async function embedText(text, _hfApiKey, _timeoutMs) {
  try {
    const [vec] = await embedLocal([text]);
    return Array.isArray(vec) ? vec : null;
  } catch (e) {
    // Model not loaded yet / load failed — query.js falls back to keyword-only.
    console.warn(`[NewsAI Embed] Query embed skipped: ${e.message}`);
    return null;
  }
}

// ── Internal: batch-embed all unembedded articles ────────────────────────────
let embeddingRunning = false;  // guard against concurrent scrape-triggered runs

/**
 * Does the actual background embedding work — no req/res needed.
 * Can be called directly by server.js after a scrape, or by embedArticles().
 * Uses embeddingRunning guard so concurrent calls are no-ops (not queued).
 *
 * Signature kept backward-compatible: the hfApiKey arg is accepted and ignored.
 */
async function runEmbeddingBackground(_hfApiKey) {
  if (embeddingRunning) {
    console.log('[NewsAI Embed] Already running — skipping duplicate trigger');
    return;
  }
  const pending = store.getArticlesForEmbedding();
  if (!pending.length) return;
  embeddingRunning = true;  // set synchronously before first await

  let embedded = 0;
  let failed   = 0;

  try {
    // Warm the model once up-front. If it can't load (e.g. no internet on the
    // very first run before the model is cached), skip all batches cleanly —
    // keyword search continues to work, exactly as before.
    try {
      await getExtractor();
    } catch (e) {
      console.warn(`[NewsAI Embed] Local embedding model unavailable — skipping embedding. Keyword search will still work. (${e.message})`);
      console.warn(`[NewsAI Embed] First run needs internet to download ${EMBED_MODEL} (~50 MB) into backend/.models/. After that it runs fully offline.`);
      return;  // finally block releases the guard
    }

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      try {
        const texts   = batch.map(a => a.text);
        const vectors = await embedLocal(texts);

        for (let j = 0; j < batch.length; j++) {
          if (Array.isArray(vectors[j])) {
            store.setEmbedding(batch[j].id, vectors[j]);
            embedded++;
          }
        }
      } catch (e) {
        failed += batch.length;
        // Only log the first failure — later ones are almost certainly the same cause.
        if (batchNum === 1) {
          console.warn(`[NewsAI Embed] Batch embedding failed: ${e.message}. Keyword search unaffected.`);
        }
      }
    }

    const finalStats = store.getEmbeddingStats();
    if (embedded > 0) {
      console.log(`[NewsAI Embed] ✅ Done: ${embedded} embedded, ${failed} failed | ${finalStats.withEmbedding}/${finalStats.total} articles have vectors`);
    }
  } finally {
    embeddingRunning = false;  // always release, even on unexpected throws or early returns
  }
}

// ── Route: POST /api/embed ───────────────────────────────────────────────────
/**
 * Batch-embeds all articles that don't have embeddings yet.
 * Responds immediately (202 Accepted) and runs in background.
 * Called by newsai-content.js after articles are ingested.
 *
 * Body: { hfApiKey?: string }   — accepted for backward compatibility, ignored
 * (embeddings are now local and need no key).
 */
async function embedArticles(req, res) {
  const pending = store.getArticlesForEmbedding();
  const stats   = store.getEmbeddingStats();

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

  runEmbeddingBackground().catch(err =>
    console.warn('[NewsAI Embed] Background error:', err.message));
}

// ── Route: GET /api/embed/status ─────────────────────────────────────────────
function embedStatus(req, res) {
  res.json({
    ...store.getEmbeddingStats(),
    model:      EMBED_MODEL,
    modelState,                          // idle | loading | ready | error
    modelError: modelState === 'error' ? modelError : null,
    running:    embeddingRunning,
  });
}

module.exports = { embedArticles, embedStatus, embedText, runEmbeddingBackground };
