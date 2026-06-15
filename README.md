# NewsAI — Newspaper AI Chatbot

A white-label, embeddable AI chatbot widget for newspaper websites. Powered by [Claude](https://www.anthropic.com).

---

## Quick Start (Widget, no backend needed)

1. Open `test.html` in Chrome (drag it into a Chrome tab)
2. Put your Anthropic API key inside `test.html` at the `anthropicApiKey` line
3. The widget appears in the bottom-right corner — click the red FAB to open it

---

## File Structure

```
newsai/
├── widget/
│   ├── newsai-widget.js        ← Main widget (embed this)
│   ├── newsai-widget.css       ← All styles (auto-loaded by widget)
│   ├── newsai-config-loader.js ← Loads JSON config, sets CSS vars
│   └── newsai-content.js       ← RSS / API / PDF / scrape ingestion
├── extension/
│   ├── manifest.json           ← Chrome Extension Manifest V3
│   ├── content.js              ← Injects widget into newspaper tabs
│   ├── background.js           ← Service worker (minimal)
│   ├── popup.html              ← Extension toolbar popup
│   ├── generate-icons.html     ← Open in Chrome to generate icon PNGs
│   └── icons/                  ← Place icon16.png, icon48.png, icon128.png here
├── backend/
│   ├── server.js               ← Express server (PDF + scrape modes)
│   ├── routes/ingest-pdf.js
│   ├── routes/scrape.js
│   └── package.json
├── configs/
│   ├── eenadu.json             ← Eenadu config (edit this)
│   └── sample-client.json      ← Template for new newspapers
└── test.html                   ← Local test page
```

---

## Setting Your API Key

Edit `configs/eenadu.json`:
```json
{
  "anthropicApiKey": "sk-ant-xxxxxxxxxxxxxxxx"
}
```

Or set it directly in `test.html` for quick local testing.

---

## Running the Backend (PDF / scrape modes only)

```bash
cd backend
npm install
node server.js
# → NewsAI backend running on http://localhost:3000
```

Endpoints:
- `POST /api/ingest-pdf` — body `{ pdfUrl: "..." }`
- `GET  /api/scrape?url=https://newspaper.com`
- `GET  /api/rss?url=https://newspaper.com/feed.xml` (CORS proxy)

---

## Installing the Chrome Extension

1. Open `extension/generate-icons.html` in Chrome → it downloads icon16.png, icon48.png, icon128.png → move them to `extension/icons/`
2. Go to `chrome://extensions`
3. Enable **Developer Mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `extension/` folder
6. Visit `https://www.eenadu.net` — the widget appears automatically

---

## Embedding on a Newspaper Website

Paste two lines just before `</body>`:

```html
<script>
  window.NewsAIConfig = {
    configUrl: 'https://your-cdn.com/configs/eenadu.json'
  };
</script>
<script src="https://your-cdn.com/widget/newsai-widget.js" async></script>
```

The widget self-initialises, loads today's content, and renders the FAB.

---

## Onboarding a New Newspaper (3 Steps)

1. Copy `configs/sample-client.json` → rename to `configs/newpaper-name.json`
2. Fill in `brand`, `primaryColor`, `welcomeMessage`, and `contentSource`
3. Add their domain to `extension/manifest.json` under `host_permissions` and `content_scripts.matches`

No code changes needed.

---

## Deploying to a CDN (Cloudflare Pages — free)

1. Push the project to a GitHub repo
2. Go to [pages.cloudflare.com](https://pages.cloudflare.com) → connect repo
3. Build command: *(none — static files)*  Output directory: `/` (root)
4. Your widget URL becomes: `https://newsai.pages.dev/widget/newsai-widget.js`

---

## Features

| Feature | Status |
|---|---|
| Floating chat widget | ✅ |
| Claude AI responses | ✅ |
| RSS news ingestion | ✅ |
| API / JSON ingestion | ✅ (stub) |
| PDF ingestion | ✅ (requires backend) |
| Web scraping | ✅ (requires backend) |
| Voice input (Speech-to-Text) | ✅ Chrome only |
| Voice read-aloud (TTS) | ✅ |
| Telugu + English support | ✅ |
| White-label config | ✅ |
| Chrome Extension | ✅ |
| Session memory | ✅ (sessionStorage) |
| Offline detection | ✅ |
| Mobile responsive | ✅ |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Widget not visible | Check browser console (F12) for errors |
| `401` from Claude API | Wrong or missing API key in config |
| Voice not working | Chrome only; allow microphone permission |
| Telugu shows boxes | Use Chrome on Windows 10/11, macOS, Android — all include Telugu fonts |
| RSS CORS error | Use the backend `/api/rss` proxy or `allorigins.win` (auto-fallback built in) |
| Extension not injecting | URL in `manifest.json` must exactly match the site domain |
| Backend crash on start | Run `npm install` inside the `backend/` folder first |

---

## Architecture: Alternative Backend-Only LLM Mode

See **ARCHITECTURE-ALTERNATIVES.md** for a design where a fixed backend model
(Llama, Mistral, Gemma) replaces the Claude API — useful for on-premises
deployments, cost control, or air-gapped environments.
