#!/usr/bin/env bash
# health-monitor.sh — poll /api/healthz and send a Telegram alert when the
# backend fails 2 consecutive checks.
#
# ── Setup ────────────────────────────────────────────────────────────────────
# 1. Set the three env vars below (or export them before running):
#      NEWSAI_URL          https://your-backend.example.com
#      TELEGRAM_BOT_TOKEN  123456:ABCDEF...   (from @BotFather)
#      TELEGRAM_CHAT_ID    -1001234567890     (channel/group ID)
#
# 2. Add to crontab (every 5 minutes):
#      */5 * * * * /path/to/health-monitor.sh >> /var/log/newsai-health.log 2>&1
#
# 3. State file keeps the consecutive-failure count across cron runs:
#      /tmp/newsai_health_fails
# ─────────────────────────────────────────────────────────────────────────────

NEWSAI_URL="${NEWSAI_URL:-http://localhost:3001}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
STATE_FILE="/tmp/newsai_health_fails"
FAIL_THRESHOLD=2        # alert after this many consecutive failures
TIMEOUT_SEC=10          # curl timeout per check

# ── Check /api/healthz ───────────────────────────────────────────────────────
HTTP_CODE=$(curl -s -o /tmp/newsai_health_body.json \
  -w "%{http_code}" \
  --max-time "${TIMEOUT_SEC}" \
  "${NEWSAI_URL}/api/healthz" 2>/dev/null)

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ "${HTTP_CODE}" = "200" ]; then
  echo "[${TIMESTAMP}] ✅ healthy (HTTP 200)"
  # Reset consecutive-failure counter on success
  echo "0" > "${STATE_FILE}"
  exit 0
fi

# ── Failure path ─────────────────────────────────────────────────────────────
REASON=$(python3 -c "import json,sys; d=json.load(open('/tmp/newsai_health_body.json')); print(d.get('reason','unknown'))" 2>/dev/null || echo "unknown")
ARTICLE_COUNT=$(python3 -c "import json,sys; d=json.load(open('/tmp/newsai_health_body.json')); print(d.get('articleCount','?'))" 2>/dev/null || echo "?")
SCRAPE_AGE=$(python3 -c "import json,sys; d=json.load(open('/tmp/newsai_health_body.json')); print(d.get('scrapeAgeMin','?'))" 2>/dev/null || echo "?")

# Increment consecutive-failure counter
PREV_FAILS=$(cat "${STATE_FILE}" 2>/dev/null || echo "0")
FAILS=$(( PREV_FAILS + 1 ))
echo "${FAILS}" > "${STATE_FILE}"

echo "[${TIMESTAMP}] ❌ unhealthy (HTTP ${HTTP_CODE}) — reason=${REASON} articles=${ARTICLE_COUNT} scrapeAge=${SCRAPE_AGE}min consecutive=${FAILS}"

# ── Alert on threshold ────────────────────────────────────────────────────────
if [ "${FAILS}" -ge "${FAIL_THRESHOLD}" ]; then
  MESSAGE="🚨 *NewsAI Backend Unhealthy*
Host: \`${NEWSAI_URL}\`
Time: ${TIMESTAMP}
HTTP: ${HTTP_CODE}
Reason: \`${REASON}\`
Articles: ${ARTICLE_COUNT}
Scrape age: ${SCRAPE_AGE} min
Consecutive failures: ${FAILS}"

  if [ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_CHAT_ID}" ]; then
    curl -s -X POST \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d parse_mode="Markdown" \
      -d text="${MESSAGE}" > /dev/null
    echo "[${TIMESTAMP}] 📢 Telegram alert sent (failures=${FAILS})"
  else
    echo "[${TIMESTAMP}] ⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping alert"
  fi
fi
