'use strict';

/**
 * briefingStore.js — File-based daily article store.
 *
 * One JSON file per day: backend/data/briefing-YYYY-MM-DD.json
 * Survives server restarts. Auto-fresh each calendar day.
 *
 * Format:
 *   { date, savedAt, articles: [{ headline, section, body, url, publishedAt }] }
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists on first require
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function dataFile(dateISO) {
  return path.join(DATA_DIR, `briefing-${dateISO || todayISO()}.json`);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Save today's article array to disk.
 * Overwrites any existing file for today.
 */
function save(articles) {
  const date    = todayISO();
  const payload = { date, savedAt: new Date().toISOString(), articles };
  fs.writeFileSync(dataFile(date), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * Load today's articles from disk.
 * Returns [] if no file exists yet.
 */
function load(dateISO) {
  const file = dataFile(dateISO);
  if (!fs.existsSync(file)) return [];
  try {
    const raw  = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.articles) ? data.articles : [];
  } catch (err) {
    console.warn('[BriefingStore] Failed to parse briefing file:', err.message);
    return [];
  }
}

/**
 * Returns true if a complete briefing already exists for today.
 * "Complete" = at least 5 articles with body text.
 */
function hasToday() {
  const articles = load();
  const withBody = articles.filter(a => (a.body || '').length > 80);
  return withBody.length >= 5;
}

/**
 * Returns article count stats grouped by section.
 */
function getStats(articles) {
  const bySection = {};
  for (const a of articles) {
    const sec = a.section || 'General';
    bySection[sec] = (bySection[sec] || 0) + 1;
  }
  return {
    total:     articles.length,
    withBody:  articles.filter(a => (a.body || '').length > 80).length,
    bySection,
    date:      todayISO(),
  };
}

/**
 * List all briefing dates available on disk.
 */
function listDates() {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('briefing-') && f.endsWith('.json'))
      .map(f => f.replace('briefing-', '').replace('.json', ''))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
}

module.exports = { save, load, hasToday, getStats, listDates, todayISO };
