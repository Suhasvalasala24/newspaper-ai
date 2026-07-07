"""
tts_helper.py — Called by backend/routes/tts.js via python3.
Usage: python3 tts_helper.py <voice> <text_file> <output_mp3>

Features:
- Headline list detection: newline-separated short lines → each line as separate TTS chunk
  with 750ms silence gap between headlines so they sound distinct
- Per-chunk emotion analysis: sports victory → upbeat prosody; tragedy → somber prosody
- Text normalization: symbols → spoken Telugu/English words
- Number expansion (Telugu only)
- Abbreviation expansion (CM, PM, IPL, etc.)
"""
import asyncio
import re
import sys
import tempfile
import os
import struct
import edge_tts

# ── Telugu digit words ────────────────────────────────────────────────────────
TE_ONES = ['', 'ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది']
TE_TENS = ['', 'పది', 'ఇరవై', 'ముప్పై', 'నలభై', 'ఏభై', 'అరవై', 'డెభై', 'ఎనభై', 'తొంభై']

def num_to_telugu(n):
    try:
        n = int(n)
    except Exception:
        return str(n)
    if n == 0:
        return 'సున్న'
    parts = []
    if n >= 100:
        h = n // 100
        parts.append(TE_ONES[h] + ' వంద' + ('' if h == 1 else 'ల'))
        n %= 100
    if n >= 10:
        parts.append(TE_TENS[n // 10])
        n %= 10
    if n > 0:
        parts.append(TE_ONES[n])
    return ' '.join(parts)


# ── Normalise a single line for TTS ──────────────────────────────────────────
def normalise_line(line: str, lang: str = 'te') -> str:
    # Remove markdown
    line = re.sub(r'[*#]', '', line)
    line = re.sub(r'^\s*[•\-]\s*', '', line)
    line = re.sub(r'https?://\S+', '', line)

    if lang == 'te':
        line = re.sub(r'₹\s*([\d,]+)', r'రూపాయలు \1', line)
        line = re.sub(r'Rs\.?\s*([\d,]+)', r'రూపాయలు \1', line)
        line = re.sub(r'([\d.]+)\s*%', r'\1 శాతం', line)
        abbrevs = {
            r'\bKM\b': 'కిలోమీటర్లు', r'\bkm\b': 'కిలోమీటర్లు',
            r'\bCM\b': 'ముఖ్యమంత్రి', r'\bPM\b': 'ప్రధానమంత్రి',
            r'\bMLA\b': 'ఎమ్మెల్యే', r'\bMP\b': 'ఎంపీ',
            r'\bGDP\b': 'జీ డీ పీ',   r'\bBSE\b': 'బీ ఎస్ ఈ',
            r'\bBCCI\b': 'బీ సీ సీ ఐ', r'\bNDA\b': 'ఎన్ డీ ఏ',
            r'\bUPA\b': 'యూ పీ ఏ',    r'\bBJP\b': 'బీ జే పీ',
            r'\bIMD\b': 'ఐ ఎం డీ',
            # Cricket / sports abbreviations
            r'\bIPL\b': 'ఇండియన్ ప్రీమియర్ లీగ్',
            r'\bT-?20\b': 'టీ ట్వంటీ',
            r'\bODI\b': 'వన్ డే మ్యాచ్',
            r'\bFIFA\b': 'ఫిఫా',
            r'\bNBA\b': 'ఎన్ బీ ఏ',
            r'\bWC\b': 'వరల్డ్ కప్',
        }
        for pat, rep in abbrevs.items():
            line = re.sub(pat, rep, line)
        line = re.sub(r'\s*/\s*', ' లేదా ', line)
    else:
        line = re.sub(r'₹\s*([\d,]+)', r'rupees \1', line)
        line = re.sub(r'Rs\.?\s*([\d,]+)', r'rupees \1', line)
        line = re.sub(r'([\d.]+)\s*%', r'\1 percent', line)
        abbrevs_en = {
            r'\bCM\b': 'Chief Minister', r'\bPM\b': 'Prime Minister',
            r'\bGDP\b': 'Gross Domestic Product', r'\bIMD\b': 'Indian Meteorological Department',
        }
        for pat, rep in abbrevs_en.items():
            line = re.sub(pat, rep, line)
        line = re.sub(r'\s*/\s*', ' or ', line)

    # Remove thousands comma separators: 82,450 → 82450
    line = re.sub(r'(\d),(\d{3})', r'\1\2', line)

    # Ensure line ends with sentence-final punctuation (gives TTS a natural stop)
    line = line.strip()
    if line and line[-1] not in '.?!।':
        line += '।'

    return re.sub(r'\s{2,}', ' ', line).strip()


# ── Emotion detection ─────────────────────────────────────────────────────────
# Keywords that signal emotional context → different prosody
_VICTORY_TE = [
    'విజయం', 'గోల్', 'రికార్డు', 'స్వర్ణం', 'ఛాంపియన్', 'అద్భుతం',
    'హ్యాట్రిక్', 'ఐతిహాసిక', 'జయం', 'ఫైనల్', 'క్వార్టర్', 'సెమీఫైనల్',
    'సెంచరీ', 'గెలిచ', 'ఘన', 'జోరు', 'విన్', 'డబుల్',
]
_GRIEF_TE = [
    'మృతి', 'మరణం', 'ప్రమాదం', 'విషాదం', 'నిర్యాణం', 'దుర్ఘటన',
    'కన్నీరు', 'కన్నీటి', 'విపత్తు', 'వీడ్కోలు', 'శోకం', 'మృతుల',
    'పరాభవం', 'ఓటమి', 'చిత్తు',
]
_TENSION_TE = [
    'నిషేధం', 'అరెస్టు', 'వివాదం', 'ఆరోపణ', 'మోసం', 'విమర్శ',
    'ఘర్షణ', 'ఆందోళన', 'హెచ్చరిక', 'సమ్మె',
]
_VICTORY_EN = [
    'win', 'gold', 'record', 'champion', 'victory', 'hat-trick', 'historic',
    'final', 'semi', 'double', 'stunning', 'incredible', 'beats', 'triumphs',
]
_GRIEF_EN = [
    'death', 'died', 'tragedy', 'accident', 'killed', 'disaster',
    'farewell', 'tears', 'mourning', 'sad', 'passes away', 'shock',
]
_TENSION_EN = [
    'arrested', 'banned', 'controversy', 'accused', 'fraud', 'protest',
    'clash', 'warning', 'strike', 'crisis',
]


def detect_emotion(text: str) -> tuple[str, str]:
    """
    Returns (rate_adjustment, pitch_adjustment) SSML prosody values.
    victory  → slightly faster, higher pitch  (upbeat sports energy)
    grief    → slower, lower pitch            (somber)
    tension  → slightly slower, neutral pitch (serious/grave)
    neutral  → default
    """
    victory = (sum(1 for w in _VICTORY_TE  if w in text) +
               sum(1 for w in _VICTORY_EN  if w in text.lower()))
    grief   = (sum(1 for w in _GRIEF_TE    if w in text) +
               sum(1 for w in _GRIEF_EN    if w in text.lower()))
    tension = (sum(1 for w in _TENSION_TE  if w in text) +
               sum(1 for w in _TENSION_EN  if w in text.lower()))

    dominant = max(victory, grief, tension)
    if dominant == 0:
        return ('-5%', '+0Hz')    # neutral

    if victory >= grief and victory >= tension:
        return ('+5%', '+3Hz')    # upbeat — faster, brighter
    elif grief >= tension:
        return ('-15%', '-3Hz')   # somber — slower, lower
    else:
        return ('-8%', '-1Hz')    # serious/tense — slightly slower


# ── Silent MP3 gap ────────────────────────────────────────────────────────────
def make_silent_mp3(duration_ms: int = 700) -> bytes:
    """
    Return bytes of a valid-ish silent MP3 for inter-headline gaps.
    Uses MPEG1 Layer3 32kbps mono frame (each frame ≈ 24ms).
    Frames: duration_ms / 24  (rounded up).
    The silent frame bytes are standard for 32kbps 44100Hz mono.
    """
    # MPEG1 Layer3 32kbps 44100Hz mono — 104 bytes per frame, ~24ms each
    # Header: 0xFF 0xFB = sync + MPEG1/Layer3; 0x40 = 32kbps; 0x44 = 44100Hz mono
    SILENT_FRAME = (
        b'\xff\xfb\x40\x44'   # MP3 frame header: MPEG1 L3 32kbps 44100Hz mono
        + b'\x00' * 100       # zero-filled audio data (silence)
    )
    n_frames = max(1, int(duration_ms / 24) + 1)
    return SILENT_FRAME * n_frames


# ── Main ──────────────────────────────────────────────────────────────────────
async def synthesise(text: str, voice: str, rate: str, pitch: str, out_path: str):
    """Synthesise text with edge-tts and save to out_path."""
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await communicate.save(out_path)


async def main():
    if len(sys.argv) != 4:
        print("Usage: tts_helper.py <voice> <text_file> <output_mp3>", file=sys.stderr)
        sys.exit(1)

    voice      = sys.argv[1]
    text_file  = sys.argv[2]
    output_mp3 = sys.argv[3]

    with open(text_file, encoding='utf-8') as f:
        raw_text = f.read().strip()

    if not raw_text:
        print("Empty text", file=sys.stderr)
        sys.exit(1)

    lang = 'te' if 'te-IN' in voice else 'en'

    # ── Step 1: Split into lines ──────────────────────────────────────────────
    # The widget preserves newlines in stripMarkdownForTTS so each headline
    # arrives on its own line.
    raw_lines = [l.strip() for l in raw_text.split('\n') if l.strip()]

    # ── Step 2: Normalise each line ───────────────────────────────────────────
    lines = [normalise_line(l, lang) for l in raw_lines]
    lines = [l for l in lines if l]

    if not lines:
        print("Text became empty after normalisation", file=sys.stderr)
        sys.exit(1)

    # ── Step 3: Segment lines into headlines vs body paragraphs ─────────────
    # A line is a "headline" if it is ≤ 120 chars (short, standalone).
    # Consecutive body lines are merged into one paragraph segment.
    # This handles LLM responses that mix short headlines with longer body text.
    HEADLINE_MAX = 120

    segments = []   # list of {'type': 'headline'|'paragraph', 'text': str}
    para_buf  = []

    def flush_para():
        if para_buf:
            segments.append({'type': 'paragraph', 'text': ' '.join(para_buf)})
            para_buf.clear()

    for line in lines:
        if len(line) <= HEADLINE_MAX:
            flush_para()
            segments.append({'type': 'headline', 'text': line})
        else:
            para_buf.append(line)
    flush_para()

    headline_count = sum(1 for s in segments if s['type'] == 'headline')
    print(f"[tts_helper] {len(lines)} line(s), {len(segments)} segment(s), "
          f"{headline_count} headline(s), voice={voice}", file=sys.stderr)

    # ── Step 4: Generate audio ────────────────────────────────────────────────
    if len(segments) == 1 and segments[0]['type'] == 'paragraph':
        # Pure paragraph — single TTS call
        text = segments[0]['text']
        rate, pitch = detect_emotion(text)
        print(f"[tts_helper] paragraph mode — rate={rate} pitch={pitch}", file=sys.stderr)
        await synthesise(text, voice, rate, pitch, output_mp3)

    elif len(segments) == 1 and segments[0]['type'] == 'headline':
        # Single headline — treat as paragraph (no gap needed)
        text = segments[0]['text']
        rate, pitch = detect_emotion(text)
        print(f"[tts_helper] single headline — rate={rate} pitch={pitch}", file=sys.stderr)
        await synthesise(text, voice, rate, pitch, output_mp3)

    else:
        # Mixed or multi-segment mode:
        # Each headline → separate TTS chunk with 750ms silence gap after it.
        # Paragraph segments → single TTS chunk (no gap within body text).
        tmp_dir = tempfile.mkdtemp()
        chunk_files = []   # list of {'type', 'path'}

        try:
            for i, seg in enumerate(segments):
                rate, pitch = detect_emotion(seg['text'])
                print(f"[tts_helper] seg {i+1}/{len(segments)} [{seg['type']}]: "
                      f"rate={rate} pitch={pitch} | {seg['text'][:60]}", file=sys.stderr)
                chunk_path = os.path.join(tmp_dir, f'chunk_{i:03d}.mp3')
                await synthesise(seg['text'], voice, rate, pitch, chunk_path)
                chunk_files.append({'type': seg['type'], 'path': chunk_path})

            # Concatenate: insert 750ms silence between every segment pair
            # so headlines sound distinctly separated from each other and from body text.
            silence = make_silent_mp3(750)
            with open(output_mp3, 'wb') as out:
                for i, chunk in enumerate(chunk_files):
                    with open(chunk['path'], 'rb') as f:
                        out.write(f.read())
                    if i < len(chunk_files) - 1:   # no trailing silence
                        out.write(silence)

        finally:
            for chunk in chunk_files:
                try:
                    os.unlink(chunk['path'])
                except OSError:
                    pass
            try:
                os.rmdir(tmp_dir)
            except OSError:
                pass


asyncio.run(main())
