'use strict';

const fetch  = require('node-fetch');
const pdf    = require('pdf-parse');

/**
 * POST /api/ingest-pdf
 * Body: { pdfUrl: string }
 *
 * Fetches the PDF, extracts text with pdf-parse, then attempts to split
 * it into article-like chunks by detecting headline patterns.
 *
 * Returns: { articles: [{ headline, section, summary, body }] }
 */
async function ingestPdf(req, res) {
  const { pdfUrl } = req.body || {};

  if (!pdfUrl) {
    return res.status(400).json({ error: 'pdfUrl is required' });
  }

  let pdfBuffer;
  try {
    const response = await fetch(pdfUrl, { timeout: 30000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    pdfBuffer = await response.buffer();
  } catch (err) {
    return res.status(400).json({ error: `Could not fetch PDF: ${err.message}` });
  }

  let data;
  try {
    data = await pdf(pdfBuffer);
  } catch (err) {
    return res.status(500).json({ error: `PDF parse failed: ${err.message}` });
  }

  const articles = splitTextIntoArticles(data.text);
  res.json({ articles, pageCount: data.numpages });
}

/**
 * Splits raw PDF text into article objects by detecting headline patterns.
 * Heuristic: lines in ALL CAPS or title case followed by body text are headlines.
 */
function splitTextIntoArticles(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const articles = [];
  let current = null;

  // Common section keywords
  const SECTION_PATTERNS = [
    { re: /national|india|parliament|government/i, section: 'National' },
    { re: /telangana|hyderabad|ts\b/i,             section: 'Telangana' },
    { re: /andhra|ap\b|amaravati/i,                section: 'Andhra Pradesh' },
    { re: /world|international|global|us\b|uk\b/i, section: 'International' },
    { re: /sport|cricket|football|ipl|match/i,     section: 'Sports' },
    { re: /business|market|sensex|economy|finance/i, section: 'Business' },
    { re: /cinema|film|movie|tollywood|bollywood/i, section: 'Cinema' },
  ];

  function detectSection(text) {
    for (const { re, section } of SECTION_PATTERNS) {
      if (re.test(text)) return section;
    }
    return 'General';
  }

  // Lines that look like headlines: short (< 120 chars), end without period,
  // start with a capital letter
  function isHeadline(line) {
    return (
      line.length > 8 &&
      line.length < 120 &&
      /^[A-ZÀ-Öఀ-౿]/.test(line) &&
      !line.endsWith('.') &&
      !/^\d/.test(line)
    );
  }

  for (const line of lines) {
    if (isHeadline(line) && (current === null || current.body.split(' ').length > 10)) {
      if (current) articles.push(finalise(current));
      current = { headline: line, section: detectSection(line), body: '' };
    } else if (current) {
      current.body += (current.body ? ' ' : '') + line;
    }
  }
  if (current) articles.push(finalise(current));

  return articles.slice(0, 60); // cap at 60 articles
}

function finalise(article) {
  const words = article.body.split(/\s+/);
  return {
    headline:    article.headline,
    section:     article.section,
    summary:     words.slice(0, 40).join(' ') + (words.length > 40 ? '…' : ''),
    body:        article.body,
    publishedAt: new Date().toISOString().slice(0, 10),
  };
}

module.exports = { ingestPdf };
