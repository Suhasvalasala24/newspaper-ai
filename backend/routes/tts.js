'use strict';

/**
 * POST /api/tts
 * Body: { text: string, lang: "te" | "en", voice?: string }
 * Returns: audio/mpeg (MP3 stream)
 *
 * Uses Microsoft Edge TTS via the edge-tts Python CLI.
 * Install: pip install edge-tts
 *
 * Voices available:
 *   te-IN-MohanNeural   — Telugu Male   (default for lang:"te")
 *   te-IN-ShrutiNeural  — Telugu Female
 *   en-IN-NeerjaNeural  — English Female (default for lang:"en")
 *   en-IN-PrabhatNeural — English Male
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Voice map — key: lang code, value: default Edge TTS voice
const VOICE_MAP = {
  'te':        'te-IN-MohanNeural',
  'te-female': 'te-IN-ShrutiNeural',
  'en':        'en-IN-NeerjaNeural',
  'en-male':   'en-IN-PrabhatNeural',
};

// Max text length fed to edge-tts (prevents excessively long audio)
const MAX_CHARS = 3000;

async function tts(req, res) {
  const { text, lang = 'te', voice: customVoice } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const voice    = customVoice || VOICE_MAP[lang] || VOICE_MAP['te'];
  const trimmed  = text.trim().slice(0, MAX_CHARS);

  // Write text to a temp file — avoids shell injection risk with arbitrary text
  const tmpDir   = os.tmpdir();
  const textFile = path.join(tmpDir, `newsai_tts_in_${Date.now()}.txt`);
  const audioOut = path.join(tmpDir, `newsai_tts_out_${Date.now()}.mp3`);

  try {
    fs.writeFileSync(textFile, trimmed, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write temp file: ' + e.message });
  }

  // Call tts_helper.py — use venv python if it exists, else system python3
  const helperScript = path.join(__dirname, '..', 'tts_helper.py');
  const projectRoot  = path.join(__dirname, '..', '..');
  const venvPython   = path.join(projectRoot, 'venv', 'bin', 'python3');
  const pythonBin    = fs.existsSync(venvPython) ? venvPython : 'python3';
  console.log(`[NewsAI TTS] Using python: ${pythonBin}`);

  execFile(
    pythonBin,
    [helperScript, voice, textFile, audioOut],
    { timeout: 30_000 },
    (err) => {
      // Clean up text file regardless
      fs.unlink(textFile, () => {});

      if (err) {
        console.error('[NewsAI TTS] tts_helper error:', err.message);
        const hint = err.message.includes('edge_tts')
          ? 'edge-tts not installed — run: pip install edge-tts  (inside your venv if using one)'
          : err.message;
        return res.status(500).json({ error: `TTS failed: ${hint}` });
      }

      // Stream MP3 back to the widget
      res.set({
        'Content-Type':  'audio/mpeg',
        'Cache-Control': 'no-cache',
        'X-Voice':       voice,
      });

      const stream = fs.createReadStream(audioOut);
      stream.pipe(res);
      stream.on('end',   () => fs.unlink(audioOut, () => {}));
      stream.on('error', (e) => {
        console.error('[NewsAI TTS] Stream error:', e.message);
        if (!res.headersSent) res.status(500).end();
        fs.unlink(audioOut, () => {});
      });
    }
  );
}

module.exports = { tts };
