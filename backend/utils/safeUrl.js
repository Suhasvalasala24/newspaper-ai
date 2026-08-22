'use strict';

/**
 * safeUrl.js — shared SSRF guard.
 *
 * isSafeUrl() rejects URLs that could make the backend fetch internal/private
 * resources on behalf of an attacker (Server-Side Request Forgery). Used by:
 *   - server.js         (/api/rss proxy)
 *   - scrape-sakshi.js  (article-body fetches from scraped links)
 *
 * Rejects:
 *   - non-http(s) schemes (file:, ftp:, gopher:, etc.)
 *   - localhost / loopback (localhost, 127.0.0.1, ::1)
 *   - cloud metadata endpoints (169.254.169.254, metadata.google.internal)
 *   - private IPv4 ranges (10.x, 172.16–31.x, 192.168.x)
 *   - internal TLDs (.internal, .local)
 */
function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
    if (h === '169.254.169.254' || h === 'metadata.google.internal') return false;
    if (/^10\./.test(h) || /^192\.168\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    if (h.endsWith('.internal') || h.endsWith('.local')) return false;
    return true;
  } catch (_) { return false; }
}

module.exports = { isSafeUrl };
