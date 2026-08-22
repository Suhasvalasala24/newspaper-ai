'use strict';

// Per-session interest tracker.
// Key: sessionId (UUID from client), Value: SessionContext object
const sessions = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const MAX_TOPICS = 20;   // cap topics per session
const MAX_QUERIES = 30;  // cap raw query history per session

function getSession(sessionId) {
  if (!sessionId) return null;
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      id: sessionId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      queries: [],           // raw question strings (last MAX_QUERIES)
      topicScores: {},       // topic → score (higher = more interest)
      currentSection: null,  // last section the user was reading
    };
    sessions.set(sessionId, s);
  }
  s.lastActiveAt = Date.now();
  return s;
}

// Telugu topic detection map — matches questions to interest categories
const TOPIC_MAP = [
  { topic: 'sports',   te: ['క్రికెట్','స్కోర్','పోటీ','ఆట','జట్టు','ఆటగాడు','పతకం','IPL','టోర్నమెంట్','మ్యాచ్'], en: ['cricket','match','score','team','player','ipl','tournament','sports','medal','win','league'] },
  { topic: 'politics', te: ['ప్రభుత్వం','మంత్రి','ముఖ్యమంత్రి','ఎన్నికలు','పార్టీ','నేత','రాజకీయ','ఓటు','సభ','శాసన'], en: ['government','minister','cm','election','party','political','vote','parliament','assembly','bjp','congress','tdp'] },
  { topic: 'business', te: ['వ్యాపారం','మార్కెట్','స్టాక్','ధర','ఆర్థిక','బడ్జెట్','పన్ను','ఉద్యోగం','కంపెనీ','పెట్టుబడి'], en: ['stock','market','economy','budget','tax','job','company','investment','gdp','inflation','business','profit'] },
  { topic: 'cinema',   te: ['సినిమా','సినిమాలు','నటుడు','నటి','పాట','విడుదల','సీరీస్','ఓటీటీ','సంగీతం','బాక్సాఫీస్'], en: ['movie','film','actor','actress','song','release','ott','cinema','box office','director'] },
  { topic: 'crime',    te: ['అరెస్టు','కేసు','దర్యాప్తు','నిందితుడు','మోసం','నేరం','పోలీసు','హత్య','దొంగతనం'], en: ['arrest','case','crime','accused','murder','theft','police','investigation','fraud'] },
  { topic: 'health',   te: ['ఆరోగ్యం','వైద్యం','వ్యాధి','చికిత్స','ఆసుపత్రి','టీకా','మందు','డాక్టర్','కోవిడ్'], en: ['health','disease','treatment','hospital','vaccine','medicine','doctor','covid','virus'] },
  { topic: 'weather',  te: ['వాతావరణం','వర్షం','తుఫాను','ఉష్ణోగ్రత','వేడి','చలి','వాన','హెచ్చరిక'], en: ['weather','rain','cyclone','temperature','heat','cold','flood','forecast','warning'] },
  { topic: 'education',te: ['విద్య','పాఠశాల','కళాశాల','పరీక్ష','ఫలితాలు','విద్యార్థి','యూనివర్సిటీ','చదువు'], en: ['education','school','college','exam','results','student','university','study'] },
];

function detectTopics(query) {
  const q = (query || '').toLowerCase();
  const detected = [];
  for (const { topic, te, en } of TOPIC_MAP) {
    const teHit = te.some(w => q.includes(w));
    const enHit = en.some(w => q.includes(w));
    if (teHit || enHit) detected.push(topic);
  }
  return detected;
}

/**
 * Record a user query and update their interest profile.
 * @param {string} sessionId
 * @param {string} query       — the raw user question
 * @param {string} [section]  — article section context if known
 */
function recordQuery(sessionId, query, section) {
  const s = getSession(sessionId);
  if (!s) return;

  // Store raw query (capped)
  s.queries.push(query);
  if (s.queries.length > MAX_QUERIES) s.queries.shift();

  // Update section
  if (section) s.currentSection = section;

  // Detect topics and score them
  const topics = detectTopics(query);
  for (const t of topics) {
    s.topicScores[t] = (s.topicScores[t] || 0) + 1;
  }

  // Prune old topics if over limit (keep highest-scored)
  const entries = Object.entries(s.topicScores);
  if (entries.length > MAX_TOPICS) {
    entries.sort((a, b) => b[1] - a[1]);
    s.topicScores = Object.fromEntries(entries.slice(0, MAX_TOPICS));
  }
}

/**
 * Generate a context hint string for injection into the system prompt.
 * Returns empty string if no useful context exists.
 */
function getContextHint(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return '';

  const entries = Object.entries(s.topicScores).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';

  const topTopics = entries.slice(0, 3).map(([t]) => t);
  const recentQ   = s.queries.slice(-3);

  let hint = `USER CONTEXT: This user's main interests are [${topTopics.join(', ')}].`;
  if (recentQ.length > 0) {
    hint += ` Recent questions: ${recentQ.map(q => `"${q.slice(0,80)}"`).join('; ')}.`;
  }
  hint += ' Prioritise answering from their preferred topics when relevant.';
  return hint;
}

/** Periodic cleanup — prune sessions older than TTL */
function pruneOldSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActiveAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
setInterval(pruneOldSessions, 30 * 60 * 1000).unref(); // every 30 min

module.exports = { recordQuery, getContextHint, getSession };
