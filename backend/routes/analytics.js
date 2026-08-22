'use strict';

/**
 * Backend Analytics — lightweight in-memory event log.
 *
 * POST /api/analytics        — log an event (open to widget, no auth)
 * GET  /api/analytics/summary — aggregated stats (admin-protected)
 *
 * Events: open, query, tts, lang_switch, article_click
 *
 * Ring buffer of 10,000 events — oldest are dropped when full.
 * NOT cleared at midnight (analytics are valuable across days).
 */

const MAX_EVENTS = 10000;
const events     = [];   // { type, lang, data, ts }

// ── Core log function ─────────────────────────────────────────────────────────
function logEvent(type, lang, data) {
  events.push({ type: String(type), lang: lang || 'unknown', data: data || {}, ts: Date.now() });
  // Ring buffer: drop oldest when over cap
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
}

// ── Route: POST /api/analytics ────────────────────────────────────────────────
function trackEvent(req, res) {
  const { type, lang, data } = req.body || {};
  if (!type || typeof type !== 'string' || !type.trim()) {
    return res.status(400).json({ error: 'type required' });
  }
  logEvent(type.trim().slice(0, 50), lang, data);
  res.json({ ok: true });
}

// ── Route: GET /api/analytics/summary ────────────────────────────────────────
function getSummary(req, res) {
  // Use IST midnight (UTC+5:30) as the "today" boundary — consistent with the
  // midnight reset scheduler and the hourly breakdown below.
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  nowIst.setUTCHours(0, 0, 0, 0);             // set to IST midnight in UTC space
  const todayTs = nowIst.getTime() - IST_OFFSET_MS; // back to epoch ms

  const todayEvents = events.filter(e => e.ts >= todayTs);
  const queries     = todayEvents.filter(e => e.type === 'query');

  // Top queries
  const queryFreq = {};
  for (const e of queries) {
    const q = String(e.data.query || '').slice(0, 60).trim();
    if (q) queryFreq[q] = (queryFreq[q] || 0) + 1;
  }
  const topQueries = Object.entries(queryFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Language breakdown
  const langBreakdown = { te: 0, en: 0 };
  for (const e of queries) {
    if (e.lang === 'te') langBreakdown.te++;
    else if (e.lang === 'en') langBreakdown.en++;
  }

  // Hourly breakdown (IST = UTC+5:30) — reuses IST_OFFSET_MS declared above
  const hourCounts = new Array(24).fill(0);
  for (const e of queries) {
    const istHour = new Date(e.ts + IST_OFFSET_MS).getUTCHours();
    hourCounts[istHour]++;
  }
  // Return null when there are no queries — indexOf(0) on an all-zero array
  // would falsely report midnight (index 0) as the peak hour.
  const maxCount = Math.max(...hourCounts);
  const peakHour = maxCount > 0 ? hourCounts.indexOf(maxCount) : null;

  res.json({
    today: {
      totalEvents:     todayEvents.length,
      queries:         queries.length,
      articleClicks:   todayEvents.filter(e => e.type === 'article_click').length,
      ttsPlays:        todayEvents.filter(e => e.type === 'tts').length,
      widgetOpens:     todayEvents.filter(e => e.type === 'open').length,
      langSwitches:    todayEvents.filter(e => e.type === 'lang_switch').length,
      langBreakdown,
      topQueries,
      peakHour,
      hourlyBreakdown: hourCounts,
    },
    allTime: {
      totalEvents: events.length,
      bufferCapacity: MAX_EVENTS,
    },
  });
}

// ── Note midnight passes in the log (does NOT clear analytics) ───────────────
function clearAnalytics() {
  logEvent('midnight_reset', 'system', {});
}

module.exports = { trackEvent, getSummary, logEvent, clearAnalytics };
