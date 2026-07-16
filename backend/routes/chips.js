'use strict';

/**
 * Dynamic Quick Chips — GET /api/chips
 *
 * Instead of hardcoded suggestion buttons, we generate these from today's
 * actual ingested articles: which sections have the most content, and which
 * proper nouns appear most often in headlines.
 *
 * Called automatically after XML ingest. Widget fetches at open.
 */

// Telugu translations for common English section names
const SECTION_TE = {
  'National':           'జాతీయ వార్తలు',
  'Telangana':          'తెలంగాణ వార్తలు',
  'Andhra Pradesh':     'ఆంధ్రప్రదేశ్ వార్తలు',
  'International':      'అంతర్జాతీయ వార్తలు',
  'Sports':             'క్రీడా వార్తలు',
  'Business':           'వ్యాపార వార్తలు',
  'Cinema':             'సినిమా వార్తలు',
  'Crime & Police':     'నేర వార్తలు',
  'Education':          'విద్యా వార్తలు',
  'Public Health':      'ఆరోగ్య వార్తలు',
  'Agriculture':        'వ్యవసాయ వార్తలు',
  'Courts':             'న్యాయస్థాన వార్తలు',
  'Railways':           'రైల్వే వార్తలు',
  'Aviation':           'విమాన వార్తలు',
  'Women':              'మహిళా వార్తలు',
  'Irrigation':         'నీటిపారుదల వార్తలు',
  'Roads & Buildings':  'రహదారి వార్తలు',
  'Local Bodies':       'స్థానిక వార్తలు',
  'Lifestyle':          'జీవనశైలి వార్తలు',
  'Technology':         'సాంకేతిక వార్తలు',
  'Politics':           'రాజకీయ వార్తలు',
  'Family':             'కుటుంబ వార్తలు',
  'Public Administration': 'పరిపాలన వార్తలు',
  'General':            'ఇతర వార్తలు',
};

// ── Module state ─────────────────────────────────────────────────────────────
let cachedChips  = { te: [], en: [] };
let chipsBuiltAt = 0;

// ── Build chips from today's articles ────────────────────────────────────────
function buildChips(articles) {
  if (!articles || articles.length === 0) {
    cachedChips  = { te: [], en: [] };
    chipsBuiltAt = 0;
    return;
  }

  // Count by section
  const sectionCount = {};
  for (const a of articles) {
    const sec = a.section || 'General';
    sectionCount[sec] = (sectionCount[sec] || 0) + 1;
  }

  // Top 6 sections by article count
  const topSections = Object.entries(sectionCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([sec]) => sec);

  // Telugu chips: always include "ఈ రోజు ముఖ్య వార్తలు" first
  const te = ['ఈ రోజు ముఖ్య వార్తలు', 'ఈ రోజు పేపర్ సారాంశం'];
  for (const sec of topSections) {
    const teLabel = SECTION_TE[sec];
    if (teLabel && !te.includes(teLabel)) te.push(teLabel);
  }
  // Add common queries
  if (!te.includes('క్రికెట్ స్కోర్')) te.push('క్రికెట్ స్కోర్');
  if (!te.includes('బంగారం ధర')) te.push('బంగారం ధర');

  // English chips
  const en = ['Today\'s headlines', 'Full digest today'];
  for (const sec of topSections) {
    const enLabel = `Today's ${sec} news`;
    if (!en.includes(enLabel)) en.push(enLabel);
  }
  en.push('Cricket score', 'Gold price today');

  cachedChips  = { te: te.slice(0, 8), en: en.slice(0, 8) };
  chipsBuiltAt = Date.now();
  console.log(`[NewsAI Chips] Built ${te.length} Telugu + ${en.length} English chips from ${articles.length} articles`);
}

// ── Route: GET /api/chips ─────────────────────────────────────────────────────
function getChips(req, res) {
  res.json({ ...cachedChips, builtAt: chipsBuiltAt || null });
}

// ── Clear on midnight reset ───────────────────────────────────────────────────
function clearChips() {
  cachedChips  = { te: [], en: [] };
  chipsBuiltAt = 0;
}

module.exports = { buildChips, getChips, clearChips };
