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
