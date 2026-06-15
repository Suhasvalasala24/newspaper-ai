# Alternative Architecture: Fixed Backend LLM (No Claude / No On-Prem)

This document describes a second variant of the NewsAI product where **all AI inference runs on a fixed, shared backend server** rather than having each newspaper client bring their own Claude API key — and without requiring any on-premises GPU hardware.

---

## Why This Variant?

The primary architecture (Claude API key per client) is simple to set up but has two friction points:

1. **Each newspaper must manage their own Anthropic account and billing.** For small regional papers, this is a barrier.
2. **API keys live in browser-accessible config files.** Even with care, this creates key-exposure risk.

The backend-LLM variant solves both: the newspaper embed widget calls **your** backend, which calls the model. Newspapers pay you a SaaS fee; you pay for inference. The model can be Claude, an open-weight model, or a mix.

---

## Architecture Overview

```
Newspaper Website
  └─ newsai-widget.js  ─── POST /api/chat ──►  NewsAI Backend Server
                                                   │
                                        ┌──────────┴──────────┐
                                        │  LLM Router Layer   │
                                        └──────────┬──────────┘
                                                   │
                        ┌──────────────────────────┼──────────────────────────┐
                        ▼                          ▼                          ▼
               Claude API (Anthropic)    Ollama / vLLM (self-hosted)   Groq / Together AI
               claude-sonnet-4           llama3 / mistral / gemma      (fast inference APIs)
```

The widget no longer holds an API key. It sends messages to your `/api/chat` endpoint along with a **newspaper ID** (`client_id`). Your backend:

1. Looks up that client's config (branding, content source, sections)
2. Fetches today's content (RSS/API/PDF/scrape) — **cached server-side** so the browser never fetches it
3. Builds the system prompt
4. Routes to the configured model
5. Streams the response back to the widget

---

## Backend-LLM Technology Options

### Option A — Claude API (centralized, no client keys)
Same model, but one key on your server. You absorb the cost and charge newspapers a SaaS fee.

```
Model:    claude-sonnet-4-20250514
Cost:     ~$3 / 1M input tokens, ~$15 / 1M output tokens
Control:  Anthropic's safety filters, no GPU needed
Best for: Premium tier, accuracy-critical papers
```

### Option B — Groq (free/cheap fast inference, hosted)
Groq offers blazing-fast inference via their LPU hardware. Free tier available.

```
Models:   llama-3.3-70b-versatile, mixtral-8x7b-32768
API:      https://api.groq.com/openai/v1/chat/completions
Cost:     Free tier: 6000 req/day. Paid: ~$0.59/1M tokens (Llama 3 70B)
Best for: Cost-sensitive deployments, high-volume traffic
```

### Option C — Together AI / Fireworks AI (hosted open-weight)
Wide model selection, OpenAI-compatible API, pay-as-you-go.

```
Models:   Llama-3.1-70B, Mistral-7B, Gemma-2-27B, Qwen2-72B
Cost:     ~$0.90/1M tokens (Llama 70B)
Best for: Flexibility, multilingual models (Qwen2 excels at Telugu/Indian langs)
```

### Option D — Ollama on a VPS (self-hosted, no GPU needed for small models)
Run a 7B model on a CPU-only VPS (4–8 vCPU, 16GB RAM).

```
Model:    mistral:7b, llama3.2:3b, gemma2:9b
VPS cost: ~$20–40/month (DigitalOcean, Hetzner)
Throughput: ~2–5 tokens/second on CPU — slow but functional for a text chatbot
Best for: Complete data control, air-gapped environments, GDPR-strict clients
```

### Option E — vLLM on a GPU VPS (self-hosted, fast)
Rent a GPU VPS and run a 13B–70B model at full speed.

```
Hardware: RTX 4090 (24GB VRAM) — runs Llama-3 70B in 4-bit quantization
VPS cost: ~$100–200/month (RunPod, vast.ai, Lambda Labs)
Model:    Llama-3.3-70B-Instruct (Apache 2.0 license, free to use)
Throughput: ~40–80 tokens/second
Best for: High-volume newspapers, full data ownership, no API dependency
```

---

## File Changes Required

### 1. Remove client API key from config

```json
// configs/eenadu.json — REMOVE anthropicApiKey entirely
{
  "brand": { ... },
  "contentSource": { ... },
  "clientId": "eenadu",         // ← add this
  "position": "bottom-right"
  // no anthropicApiKey
}
```

### 2. Update widget to call your backend instead of Anthropic directly

In `widget/newsai-widget.js`, replace `callClaude()` with:

```javascript
async function callClaude(config) {
  const resp = await fetch('https://api.newsai.yourdomain.com/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId:  config.clientId,
      language:  currentLang,
      messages:  conversationHistory.slice(-MAX_HISTORY),
    }),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.reply;
}
```

No API key in the browser. No content in the request (server fetches it).

### 3. New backend route: `/api/chat`

```javascript
// backend/routes/chat.js
const clients = require('../clients');  // newspaper config registry
const content = require('./content-cache');

app.post('/api/chat', async (req, res) => {
  const { clientId, language, messages } = req.body;
  const config = clients.get(clientId);
  if (!config) return res.status(404).json({ error: 'Unknown client' });

  // Content is cached server-side — much more efficient
  const todayContent = await content.get(config);

  const systemPrompt = buildSystemPrompt(config, language, todayContent);

  // Route to configured model
  const reply = await llmRouter.chat(config.llmProvider, systemPrompt, messages);
  res.json({ reply });
});
```

### 4. LLM Router (provider-agnostic)

```javascript
// backend/llm-router.js
const Anthropic = require('@anthropic-ai/sdk');
const Groq      = require('groq-sdk');

const PROVIDERS = {
  claude: async (systemPrompt, messages) => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await client.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      system: systemPrompt, messages,
    });
    return r.content[0].text;
  },

  groq: async (systemPrompt, messages) => {
    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const r = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    });
    return r.choices[0].message.content;
  },

  ollama: async (systemPrompt, messages) => {
    const r = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: false,
      }),
    });
    const data = await r.json();
    return data.message.content;
  },
};

async function chat(provider, systemPrompt, messages) {
  const fn = PROVIDERS[provider] || PROVIDERS.claude;
  return fn(systemPrompt, messages);
}

module.exports = { chat };
```

### 5. Server-side content cache

Move content fetching to the backend so:
- It runs once per newspaper per day (not on every user page load)
- The browser never handles newspaper article text
- Works even if the RSS/CMS has CORS restrictions

```javascript
// backend/content-cache.js
const cache = new Map();

async function get(config) {
  const key = config.clientId + ':' + new Date().toISOString().slice(0, 10);
  if (cache.has(key)) return cache.get(key);

  const articles = await ingest(config.contentSource);
  const content  = buildContextString(articles, config);
  cache.set(key, content);
  setTimeout(() => cache.delete(key), 6 * 60 * 60 * 1000); // expire after 6h
  return content;
}
```

---

## Cost Comparison

| Deployment Mode | Monthly infra cost (1000 users/day) | Data leaves your servers? | Telugu quality |
|---|---|---|---|
| Claude API per client | $0 infra (client pays) | Yes → Anthropic | Excellent |
| Claude API centralized | ~$30–80/month | Yes → Anthropic | Excellent |
| Groq (Llama 70B) | ~$5–15/month | Yes → Groq | Good |
| Together AI (Qwen2-72B) | ~$10–20/month | Yes → Together AI | Very good (Qwen2 is strong on Indian languages) |
| Ollama CPU VPS | ~$30/month VPS | No — fully self-hosted | Depends on model |
| vLLM GPU VPS | ~$150/month VPS | No — fully self-hosted | Excellent (Llama 70B) |

---

## Recommendation by Use Case

**Starting out / MVP:**
→ Use the primary architecture (Claude API per client). Zero infra cost to you, easiest to ship.

**SaaS business (you own billing):**
→ Centralized Claude API on your backend. One API key, clean separation, easy to scale.

**Cost-sensitive / high volume:**
→ Groq with Llama 3.3 70B. Near-Claude quality at 10× lower cost per token.

**Data sovereignty / newspaper requires on-prem:**
→ Ollama (CPU) for low traffic, vLLM on a GPU VPS for production.

**Best Telugu language quality:**
→ Claude (primary) or Qwen2-72B via Together AI (specifically strong at Indian regional languages).

---

## Security in the Backend-LLM Variant

Since no API key lives in the browser, the main risks shift to the backend:

- **Rate limiting**: Limit requests per `clientId` to prevent abuse (e.g. express-rate-limit)
- **Client authentication**: Use a signed JWT or a per-newspaper bearer token in the widget request so only authorized newspapers can use your endpoint
- **Prompt injection**: Validate `messages` array server-side — reject messages containing jailbreak patterns before sending to the model
- **Content caching**: Never pass raw article HTML to the LLM; always pre-process and truncate server-side

---

*This document covers the architecture variation only. All other product behaviour (widget UI, voice, Chrome extension, config format) remains identical to the primary build.*
