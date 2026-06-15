'use strict';

const express = require('express');
const cors    = require('cors');
const { ingestPdf } = require('./routes/ingest-pdf');
const { scrape }    = require('./routes/scrape');
const { tts }       = require('./routes/tts');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*', // Allow widget to call from any newspaper domain
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'NewsAI Backend', version: '1.0.0' });
});

// ── Routes ──────────────────────────────────────────────────────────────────
/**
 * POST /api/ingest-pdf
 * Body: { pdfUrl: "https://..." }
 * Returns structured articles extracted from the PDF.
 */
app.post('/api/ingest-pdf', ingestPdf);

/**
 * GET /api/scrape?url=https://newspaper.com
 * Returns headlines and summaries scraped from the newspaper homepage.
 */
app.get('/api/scrape', scrape);

/**
 * POST /api/tts
 * Body: { text: string, lang: "te" | "en", voice?: string }
 * Returns MP3 audio stream using Microsoft Edge TTS neural voices.
 * Requires: pip install edge-tts
 */
app.post('/api/tts', tts);

/**
 * GET /api/rss?url=https://newspaper.com/rss.xml
 * Server-side RSS proxy — avoids CORS issues on the browser side.
 */
app.get('/api/rss', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  try {
    const fetch = require('node-fetch');
    const resp  = await fetch(url, { timeout: 10000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
    res.set('Content-Type', 'application/xml').send(xml);
  } catch (err) {
    res.status(502).json({ error: `RSS fetch failed: ${err.message}` });
  }
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[NewsAI Backend Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NewsAI backend running on http://localhost:${PORT}`);
  console.log('Routes:');
  console.log('  POST /api/ingest-pdf  — PDF text extraction');
  console.log('  GET  /api/scrape      — Web scraping proxy');
  console.log('  GET  /api/rss         — RSS CORS proxy');
  console.log('  POST /api/tts         — Edge TTS neural voice (pip install edge-tts)');
});

module.exports = app;
