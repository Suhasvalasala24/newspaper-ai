# NewsAI — Newspaper AI Chatbot

## What This Project Is
A white-label floating AI chatbot widget for newspaper websites. Also deployable as a Chrome extension. Powered by the Anthropic Claude API.

## Tech Stack
- Frontend: Vanilla JavaScript, HTML, CSS (no frameworks)
- Backend: Node.js + Express (minimal, only for pdf/scrape content modes)
- AI: Anthropic Claude API (claude-sonnet-4-20250514)
- Voice: Web Speech API (browser-native, no external service)
- Chrome Extension: Manifest V3

## Critical Rules
- All widget CSS classes must be prefixed with `.newsai-` to avoid conflicts with host websites
- No React, Vue, or any frontend framework — vanilla JS only
- The widget must work as a single self-contained JS file injection
- Never hardcode API keys — always read from config
- All user-facing text must support both English (en) and Telugu (te)
- The product must be newspaper-agnostic — branding comes from newsai-config.json only

## File Structure
```
newsai/
├── widget/
│   ├── newsai-widget.js
│   ├── newsai-widget.css
│   └── newsai-config-loader.js
├── extension/
│   ├── manifest.json
│   ├── content.js
│   ├── background.js
│   ├── popup.html
│   └── icons/
├── backend/
│   ├── server.js
│   ├── routes/ingest-pdf.js
│   ├── routes/scrape.js
│   └── package.json
├── configs/
│   ├── eenadu.json
│   └── sample-client.json
├── test.html
└── CLAUDE.md
```

## Build Order
1. Widget UI with dummy content
2. Config loader system
3. Claude API integration
4. RSS content ingestion
5. Voice input and output
6. Language toggle (Telugu/English)
7. Chrome extension
8. Backend server (pdf/scrape modes)

## Extension Widget Sync — IMPORTANT
`extension/widget/newsai-widget.js` is a SEPARATE BUNDLED COPY of `widget/newsai-widget.js`.
After ANY edit to the main widget or its CSS, run:
```bash
./sync-extension.sh
# or from backend/:
npm run sync:ext
```
Then reload the extension in chrome://extensions (click the ↺ refresh button).

The backend also serves the widget live at `http://localhost:3001/widget/newsai-widget.js` —
this is always the latest version as long as the backend is running.

## Active AI Model
Gemini 2.5 Flash Lite via `/api/ai` SSE streaming proxy in backend/routes/ai.js.
Claude API key in config is NOT used for AI responses — only Gemini key (in backend/.env) matters.

## TTS
Sarvam Bulbul v3 via `/api/tts/stream` — voices: kavya (te), neha (en).
Browser Web Speech API is the fallback (and is used for live streaming TTS during voice mode).

## Security — Never Violate
- GEMINI_API_KEY and SARVAM_API_KEY must never leave the backend
- All URL-fetching routes must use isSafeUrl() to prevent SSRF
- Rate limiting stays active on all /api routes
