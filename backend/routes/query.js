'use strict';

const store         = require('../store/articleStore');
const { embedText } = require('./embed');

/**
 * Remove repeated sentences/fragments from article body text.
 * Handles RSS/CMS bugs where the same sentence is repeated many times.
 */
function dedupContent(text) {
  if (!text || text.length < 60) return text;

  // Pass 1: deduplicate at sentence boundaries
  const tokens = text.split(/([.?!।])/);
  const seenSent = new Set();
  const outTokens = [];
  for (let si = 0; si < tokens.length; si += 2) {
    const sent  = (tokens[si]  || '').trim();
    const delim = tokens[si + 1] || '';
    const norm  = sent.toLowerCase().replace(/\s+/g, ' ');
    if (norm.length >= 15) {
      if (seenSent.has(norm)) continue;
      seenSent.add(norm);
    }
    if (sent || delim) outTokens.push(sent + delim);
  }
  let result = outTokens.join(' ');

  // Pass 2: collapse consecutive repeated word-windows (fragments without punctuation)
  const words = result.split(/\s+/);
  if (words.length < 15) return result.trim();
  const WIN = 5;
  const outWords = [];
  let wi = 0;
  while (wi < words.length) {
    if (wi + WIN * 3 <= words.length) {
      const win  = words.slice(wi, wi + WIN).join(' ');
      const nxt1 = words.slice(wi + WIN, wi + WIN * 2).join(' ');
      const nxt2 = words.slice(wi + WIN * 2, wi + WIN * 3).join(' ');
      if (win === nxt1 && win === nxt2) {
        outWords.push(...words.slice(wi, wi + WIN));
        let wj = wi + WIN;
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

/**
 * Extract the first meaningful sentence from article body text.
 * Done here (not by the LLM) so hallucination is impossible —
 * the LLM copies the Summary field, it doesn't generate it.
 */
function extractFirstSentence(text) {
  if (!text || text.length < 30) return '';
  // Match first sentence ending with ., ?, !, ।, or newline (min 20 chars to skip short stubs)
  const m = text.match(/^.{20,150}?[.?!।\n]/);
  if (m) return m[0].trim();
  // Fallback: cut at last space within 120 chars
  const cut = text.slice(0, 120);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * POST /api/query
 * Body: { question: string, topN?: number, hfApiKey?: string }
 * Returns: { articles: [...], context: string, stats: {...}, method: string }
 *
 * Two-phase retrieval:
 *   Phase 1 — Fast keyword search with Telugu→English expansion (instant).
 *   Phase 2 — HuggingFace semantic fallback when keyword score < 5.
 *             Model: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
 *             Supports Telugu natively — finds "India vs England ఫలితం?"
 *             even when no tags match. 2s timeout protects the widget's 3s limit.
 *
 * Body threshold ≥ 150 chars:
 *   Below this the LLM gets [HEADLINE ONLY] — no inventions from partial sentences.
 *   Above this the LLM may quote 1 sentence from Body (system prompt enforces this).
 */
async function queryArticles(req, res) {
  const { topN = 30, hfApiKey } = req.body;
  // Clamp question length — prevent very long queries from hogging keyword search
  const rawQ = req.body.question;
  if (!rawQ || !String(rawQ).trim()) {
    return res.status(400).json({ error: 'question is required' });
  }
  const question = String(rawQ).trim().slice(0, 500);

  const allStats = store.getStats();

  if (allStats.total === 0) {
    return res.json({
      articles: [],
      context:  null,
      stats:    allStats,
      message:  'No articles ingested today. Widget will use DOM-scraped content.',
    });
  }

  // ── Phase 1: Keyword search ────────────────────────────────────────────────
  let results  = store.queryArticles(question, topN);
  let method   = 'keyword';
  const topScore = results[0]?._score || 0;

  // ── Phase 2: Semantic fallback ─────────────────────────────────────────────
  // Only triggered when keyword search is weak AND embeddings exist.
  const embStats       = store.getEmbeddingStats();
  const shouldSemantic = (results.length === 0 || topScore < 5) && embStats.withEmbedding > 0;

  if (shouldSemantic) {
    const apiKey   = hfApiKey || process.env.HF_API_KEY || null;
    // 2s timeout — if HF is cold/slow, fall through to keyword results gracefully
    const queryVec = await embedText(question, apiKey, 2000);

    if (queryVec) {
      const hybridResults = store.queryHybrid(question, queryVec, topN);
      if (hybridResults.length > 0) {
        results = hybridResults;
        method  = 'hybrid-semantic';
      }
    }
  }

  console.log(
    `[NewsAI Query] "${question.slice(0, 50)}" → ${results.length}/${allStats.total} articles` +
    ` | top: ${topScore} | method: ${method}` +
    ` | embeds: ${embStats.withEmbedding}/${embStats.total}`
  );

  if (results.length === 0) {
    return res.json({
      articles: [],
      context:  null,
      stats:    allStats,
      message:  'No match found — widget will use full DOM-scraped content.',
    });
  }

  // ── Build focused context string ───────────────────────────────────────────
  // Body threshold: 150 chars. Below this → [HEADLINE ONLY] marker.
  // The system prompt rule: "if [HEADLINE ONLY]: print headline only, zero extra words."
  // For articles with ≥ 150 chars real content: LLM may copy 1 sentence from Body.
  const date  = new Date().toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric' });
  let context = `Today's articles | ${date} | ${results.length} relevant articles\n\n`;

  for (const a of results) {
    context += `Headline: ${a.title}\n`;
    const body = dedupContent(a.content || '');  // collapse CMS-introduced repetitions
    if (body && body.length >= 150) {
      // Pre-extract first sentence in code — LLM copies it, never generates it.
      const summary = extractFirstSentence(body);
      if (summary) context += `Summary: ${summary}\n`;
      context += `Body: ${body}\n`;
    } else {
      context += `Body: [HEADLINE ONLY — DO NOT ADD ANY DESCRIPTION]\n`;
    }
    if (a.url) context += `URL: ${a.url}\n`;
    context += '\n';
  }

  res.json({ articles: results, context, stats: allStats, method });
}

module.exports = { queryArticles };
