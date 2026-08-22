'use strict';

/**
 * Query / Response Logger
 *
 * Appends every user query + AI response pair to a rotating JSONL file.
 * This data is the raw material for:
 *   1. Identifying gaps in AI quality (bad responses, wrong language, hallucinations)
 *   2. Building a labelled training dataset for Sarvam / Gemini fine-tuning
 *   3. Understanding what Sakshi readers actually ask about
 *
 * File: backend/.cache/query-log.jsonl
 * Format: one JSON object per line — easy to import into Excel, Python, BigQuery.
 *
 * Each entry:
 *   { ts, date, query, response, lang, section, detailMode, articleCount, latencyMs }
 *
 * Rotation: when file exceeds LOG_MAX_BYTES (10 MB), it is renamed to
 * query-log.1.jsonl and a fresh file starts. Up to 3 rotated files are kept.
 *
 * Admin download: GET /api/admin/logs/download — serves the log as a UTF-8 CSV.
 */

const fs   = require('fs');
const path = require('path');

const LOG_DIR      = path.join(__dirname, '..', '.cache');
const LOG_PATH     = path.join(LOG_DIR, 'query-log.jsonl');
const LOG_MAX_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const LOG_MAX_FILES = 3;                   // keep up to 3 rotated files

// ── Ensure directory exists ────────────────────────────────────────────────────
function ensureDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); }
  catch (_) {}
}

// ── Rotate log file when it grows too large ───────────────────────────────────
function maybeRotate() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < LOG_MAX_BYTES) return;
    // Shift existing rotated files: .2 → .3, .1 → .2, current → .1
    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
      const from = LOG_PATH.replace('.jsonl', `.${i}.jsonl`);
      const to   = LOG_PATH.replace('.jsonl', `.${i + 1}.jsonl`);
      if (fs.existsSync(from)) {
        try { fs.renameSync(from, to); } catch (_) {}
      }
    }
    fs.renameSync(LOG_PATH, LOG_PATH.replace('.jsonl', '.1.jsonl'));
  } catch (_) {}
}

// ── Append one entry ──────────────────────────────────────────────────────────
function logQuery({ query, response, lang, section, detailMode, articleCount, latencyMs }) {
  try {
    ensureDir();
    maybeRotate();

    const entry = {
      ts:           Date.now(),
      date:         new Date().toISOString(),
      lang:         lang   || 'te',
      section:      section || null,
      detailMode:   !!detailMode,
      articleCount: articleCount || 0,
      latencyMs:    latencyMs || 0,
      query:        String(query  || '').slice(0, 2000),
      response:     String(response || '').slice(0, 8000),
    };

    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Never let logging crash the main request path
    console.warn('[NewsAI Logger] Failed to write query log:', err.message);
  }
}

// ── Read all log entries (for download) ───────────────────────────────────────
function readAllEntries() {
  const files = [LOG_PATH];
  for (let i = 1; i <= LOG_MAX_FILES; i++) {
    files.push(LOG_PATH.replace('.jsonl', `.${i}.jsonl`));
  }

  const entries = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try { entries.push(JSON.parse(line)); } catch (_) {}
      }
    } catch (_) {}
  }

  // Oldest first
  entries.sort((a, b) => a.ts - b.ts);
  return entries;
}

// ── Convert entries to CSV ────────────────────────────────────────────────────
function entriesToCsv(entries) {
  const headers = ['date', 'lang', 'section', 'detailMode', 'articleCount', 'latencyMs', 'query', 'response'];
  const escape  = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

  const rows = entries.map(e => [
    e.date, e.lang, e.section || '', e.detailMode ? 'yes' : 'no',
    e.articleCount, e.latencyMs, e.query, e.response,
  ].map(escape).join(','));

  return [headers.join(','), ...rows].join('\n');
}

// ── Route: GET /api/admin/logs/download ───────────────────────────────────────
function downloadLogs(req, res) {
  try {
    const entries = readAllEntries();
    if (entries.length === 0) {
      return res.status(404).json({ error: 'No log entries yet.' });
    }
    const csv      = entriesToCsv(entries);
    const filename = `newsai-query-log-${new Date().toISOString().slice(0,10)}.csv`;
    res.set({
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.send('﻿' + csv);   // BOM so Excel opens it correctly without re-encoding
  } catch (err) {
    console.error('[NewsAI Logger] Download error:', err.message);
    res.status(500).json({ error: 'Failed to generate log download.' });
  }
}

// ── Route: GET /api/admin/logs/stats ─────────────────────────────────────────
function logStats(req, res) {
  try {
    const entries = readAllEntries();
    const total   = entries.length;
    const byLang  = { te: 0, en: 0, other: 0 };
    const topQ    = {};

    for (const e of entries) {
      if (e.lang === 'te') byLang.te++;
      else if (e.lang === 'en') byLang.en++;
      else byLang.other++;

      const q = (e.query || '').slice(0, 60);
      if (q) topQ[q] = (topQ[q] || 0) + 1;
    }

    const topQueries = Object.entries(topQ)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([q, count]) => ({ query: q, count }));

    const avgLatency = total > 0
      ? Math.round(entries.reduce((s, e) => s + (e.latencyMs || 0), 0) / total)
      : 0;

    res.json({ total, byLang, avgLatencyMs: avgLatency, topQueries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { logQuery, downloadLogs, logStats };
