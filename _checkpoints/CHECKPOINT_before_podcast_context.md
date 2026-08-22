# Checkpoint — before podcast audio + user context + Telugu keyword expansion
Created: 2026-07-18

## What was in place at this checkpoint

### TTS (backend/routes/tts.js)
- SSE streaming with fast-start micro-chunk (extractFirstSentence)
- Parallel lookahead synthesis (synthesizeWithLookahead generator)
- socket.setNoDelay + flushHeaders
- Emotion-aware pace scoring
- TE_ENGLISH_PHONETIC map (breaking/live/update etc → Telugu phonetics)
- Bug fixes: keepAlive:false sarvamAgent, isRetryable, clientGone flag

### Widget (widget/newsai-widget.js + extension/widget/newsai-widget.js)
- speakGen generation counter (prevents stop-restart race)
- superseded flag (correct fall-through to Web Speech)
- trimTrailingSilence() for gapless chunk chaining
- TTS loading progress bar (.newsai-tts-loading)
- resp.body null guard
- Push-to-talk mic button (tap to start, tap to stop)

### NOT YET BUILT (being added after this checkpoint)
1. Podcast-style continuous voice mode (auto-listen/auto-send/barge-in)
2. Per-user prompt context memory (session interests → injected into system prompt)
3. Expanded Telugu keyword dataset (30-50 more per emotion category)

## How to revert to this checkpoint
Copy the backup files from this directory back over the originals.
Key files backed up below as inline content.

## widget/newsai-widget.js — TTS state variables (lines 15-24 at checkpoint)
```
let isSpeaking = false;
let currentUtterance = null;
let speakingMsgEl = null;
let speakGen = 0;
let recognition = null;
let isListening = false;
let voiceInputActive = false;
const MAX_HISTORY = 4;
let promptCount = 0;
let backendBaseUrl = 'http://localhost:3001';
```

## backend/routes/tts.js — grief pace at checkpoint
```
grief: { pace: 0.96, te: [...], en: [...] }
```
(Full keywords preserved in the file — this checkpoint just marks the divergence point)
