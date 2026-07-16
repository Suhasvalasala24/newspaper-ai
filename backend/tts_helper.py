"""
tts_helper.py — Called by backend/routes/tts.js via python3.
Usage: python3 tts_helper.py <voice> <text_file> <output_mp3>

Features:
- Headline list detection: newline-separated short lines → each line as separate TTS chunk
  with 1500ms silence gap between headlines so they sound distinct
- Parallel synthesis: asyncio.gather runs all segments simultaneously (reduces latency)
- Per-chunk emotion analysis: sports victory → upbeat prosody; tragedy → somber prosody
- Text normalization: symbols → spoken Telugu/English words
- Year expansion (Telugu only): 2026 → రెండు వేల ఇరవై ఆరు
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
TE_ONES  = ['', 'ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది']
TE_TENS  = ['', 'పది',  'ఇరవై', 'ముప్పై', 'నలభై',  'ఏభై',  'అరవై', 'డెభై', 'ఎనభై',   'తొంభై']
TE_TEENS = [
    'పది', 'పదకొండు', 'పన్నెండు', 'పదమూడు', 'పదునాలుగు',
    'పదిహేను', 'పదహారు', 'పదిహేడు', 'పదెనిమిది', 'పంతొమ్మిది',
]

# English letter → Telugu pronunciation (for expanding ALL-CAPS abbreviations)
EN_LETTER_TE = {
    'A': 'ఏ',  'B': 'బీ',  'C': 'సీ',     'D': 'డీ',     'E': 'ఈ',
    'F': 'ఎఫ్', 'G': 'జీ',  'H': 'హెచ్',  'I': 'ఐ',     'J': 'జే',
    'K': 'కే',  'L': 'ఎల్', 'M': 'ఎం',    'N': 'ఎన్',   'O': 'ఓ',
    'P': 'పీ',  'Q': 'క్యూ','R': 'ఆర్',   'S': 'ఎస్',   'T': 'టీ',
    'U': 'యూ',  'V': 'వీ',  'W': 'డబ్ల్యూ','X': 'ఎక్స్', 'Y': 'వై',
    'Z': 'జెడ్',
}


def num_to_telugu(n: int) -> str:
    """Convert integer 0–9999 to Telugu words. Returns str(n) for out-of-range."""
    try:
        n = int(n)
    except Exception:
        return str(n)
    if n == 0:
        return 'సున్న'
    if n > 9999:
        return str(n)   # leave very large numbers; handled upstream (lakhs/crores)
    parts = []
    if n >= 1000:
        t = n // 1000
        parts.append(TE_ONES[t] + ' వేయి')
        n %= 1000
    if n >= 100:
        h = n // 100
        parts.append(TE_ONES[h] + ' వంద' + ('' if h == 1 else 'ల'))
        n %= 100
    if n >= 20:
        parts.append(TE_TENS[n // 10])
        if n % 10:
            parts.append(TE_ONES[n % 10])
    elif n >= 10:
        parts.append(TE_TEENS[n - 10])
    elif n > 0:
        parts.append(TE_ONES[n])
    return ' '.join(parts)


def make_ordinal_te(n: int) -> str:
    """Return Telugu ordinal for n.  3 → మూడవ  72 → డెభై రెండవ"""
    word = num_to_telugu(n)
    # Drop trailing ఉ/ు vowel then append వ (ordinal suffix)
    if word.endswith('ు'):
        return word[:-1] + 'వ'
    if word.endswith('ి'):
        return word[:-1] + 'వ'
    return word + 'వ'


def expand_en_abbrev(text: str) -> str:
    """Spell out remaining ALL-CAPS English words letter-by-letter in Telugu.
    Named abbreviations (CM, IPL …) are already replaced before this runs.
    RGV → ఆర్ జీ వీ  |  NTR → ఎన్ టీ ఆర్  |  SP → already replaced (ఎస్పీ)
    """
    def spell(m):
        return ' '.join(EN_LETTER_TE.get(c, c) for c in m.group(0))
    # Match 2+ consecutive uppercase letters (word boundary on both sides)
    return re.sub(r'\b[A-Z]{2,}\b', spell, text)


def year_to_telugu(year_str: str) -> str:
    """Convert a 4-digit year to Telugu words.
    Examples: 2026 → 'రెండు వేల ఇరవై ఆరు'  |  1947 → 'ఒకటి వేల తొమ్మిది వందల నలభై ఏడు'
    Falls back to the original string if out of supported range (1000–2999).
    """
    TE_TEENS = [
        'పది', 'పదకొండు', 'పన్నెండు', 'పదమూడు', 'పదునాలుగు',
        'పదిహేను', 'పదహారు', 'పదిహేడు', 'పదెనిమిది', 'పంతొమ్మిది',
    ]
    try:
        n = int(year_str)
    except ValueError:
        return year_str
    if not (1000 <= n <= 2999):
        return year_str

    thousands = n // 1000
    remainder = n % 1000
    hundreds  = remainder // 100
    tens_unit = remainder % 100

    parts = []
    if thousands:
        parts.append(TE_ONES[thousands] + ' వేల')
    if hundreds:
        parts.append(TE_ONES[hundreds] + ' వంద')
    if tens_unit >= 20:
        parts.append(TE_TENS[tens_unit // 10])
        if tens_unit % 10:
            parts.append(TE_ONES[tens_unit % 10])
    elif 10 <= tens_unit <= 19:
        parts.append(TE_TEENS[tens_unit - 10])
    elif tens_unit > 0:
        parts.append(TE_ONES[tens_unit])

    return ' '.join(parts) if parts else year_str


# ── Normalise a single line for TTS ──────────────────────────────────────────
def normalise_line(line: str, lang: str = 'te') -> str:
    # ── Step 0: strip markdown / bullets / URLs ───────────────────────────────
    line = re.sub(r'[*#]', '', line)
    line = re.sub(r'^\s*[•\-]\s*', '', line)
    line = re.sub(r'https?://\S+', '', line)

    if lang == 'te':
        # ── Step 1: currency & percentage → Telugu words ──────────────────────
        line = re.sub(r'₹\s*([\d,]+)', r'రూపాయలు \1', line)
        line = re.sub(r'Rs\.?\s*([\d,]+)', r'రూపాయలు \1', line)
        line = re.sub(r'([\d.]+)\s*%', r'\1 శాతం', line)

        # ── Step 2: named abbreviations (longest first to avoid sub-matches) ──
        abbrevs = {
            # Govt / admin
            r'\bCM\b':   'ముఖ్యమంత్రి', r'\bPM\b':   'ప్రధానమంత్రి',
            r'\bMLA\b':  'ఎమ్మెల్యే',   r'\bMP\b':   'ఎంపీ',
            r'\bDGP\b':  'డీజీపీ',       r'\bSP\b':   'ఎస్పీ',
            r'\bCI\b':   'సీఐ',          r'\bDSP\b':  'డీఎస్పీ',
            # Economy / finance
            r'\bGDP\b':  'జీడీపీ',       r'\bBSE\b':  'బీఎస్ఈ',
            r'\bNSE\b':  'ఎన్ఎస్ఈ',     r'\bRBI\b':  'ఆర్‌బీఐ',
            r'\bGST\b':  'జీఎస్టీ',      r'\bIMD\b':  'ఐఎండీ',
            # Parties
            r'\bBJP\b':  'బీజేపీ',       r'\bNDA\b':  'ఎన్‌డీఏ',
            r'\bUPA\b':  'యూపీఏ',        r'\bBRS\b':  'బీఆర్ఎస్',
            r'\bTDP\b':  'టీడీపీ',       r'\bYSRCP\b':'వైఎస్సార్‌సీపీ',
            r'\bCPI\b':  'సీపీఐ',
            # Sports
            r'\bIPL\b':  'ఇండియన్ ప్రీమియర్ లీగ్',
            r'\bT-?20\b':'టీ ట్వంటీ',   r'\bODI\b':  'వన్ డే',
            r'\bFIFA\b': 'ఫిఫా',         r'\bNBA\b':  'ఎన్‌బీఏ',
            r'\bWC\b':   'వరల్డ్ కప్',   r'\bBCCI\b': 'బీసీసీఐ',
            # Distance / weight
            r'\bKM\b':   'కిలోమీటర్లు', r'\bkm\b':   'కిలోమీటర్లు',
            r'\bKG\b':   'కిలోగ్రాములు',r'\bkg\b':   'కిలోగ్రాములు',
            # Entertainment / industry
            r'\bOTT\b':  'ఓటీటీ',        r'\bVFX\b':  'విఎఫ్ఎక్స్',
        }
        for pat, rep in abbrevs.items():
            line = re.sub(pat, rep, line)

        # ── Step 3: expand remaining ALL-CAPS (RGV→ఆర్ జీ వీ, NTR→ఎన్ టీ ఆర్) ──
        line = expand_en_abbrev(line)

        line = re.sub(r'\s*/\s*', ' లేదా ', line)

    else:
        # ── English path ──────────────────────────────────────────────────────
        line = re.sub(r'₹\s*([\d,]+)', r'rupees \1', line)
        line = re.sub(r'Rs\.?\s*([\d,]+)', r'rupees \1', line)
        line = re.sub(r'([\d.]+)\s*%', r'\1 percent', line)
        abbrevs_en = {
            r'\bCM\b':  'Chief Minister',            r'\bPM\b':  'Prime Minister',
            r'\bGDP\b': 'Gross Domestic Product',    r'\bIMD\b': 'Indian Meteorological Department',
            r'\bRBI\b': 'Reserve Bank of India',     r'\bGST\b': 'Goods and Services Tax',
        }
        for pat, rep in abbrevs_en.items():
            line = re.sub(pat, rep, line)
        line = re.sub(r'\s*/\s*', ' or ', line)

    # ── Step 4: remove thousands comma separators: 82,450 → 82450 ─────────────
    line = re.sub(r'(\d),(\d{3})', r'\1\2', line)

    if lang == 'te':
        # ── Step 5: ordinal numbers  3వ → మూడవ  72వ → డెభై రెండవ ────────────
        line = re.sub(r'(\d+)వ\b', lambda m: make_ordinal_te(int(m.group(1))), line)

        # ── Step 6: 4-digit years → Telugu words (before general num expansion)
        # Keeps "2026" as "రెండు వేల ఇరవై ఆరు" not "రెండు వేయి ఇరవై ఆరు"
        line = re.sub(r'\b(1[0-9]{3}|20[0-9]{2})\b', lambda m: year_to_telugu(m.group(0)), line)

        # ── Step 7: numbers glued to Telugu chars  60ఏళ్ల → అరవై ఏళ్ల ────────
        line = re.sub(r'(\d+)(?=[ఀ-౿])', lambda m: num_to_telugu(int(m.group(1))), line)

        # ── Step 8: remaining standalone numbers → Telugu words ───────────────
        line = re.sub(r'\b(\d+)\b', lambda m: num_to_telugu(int(m.group(1))), line)

    # ── Step 9: sentence-final punctuation (gives TTS a natural stop) ─────────
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
    'ఘర్షణ', 'ఆందోళన', 'హెచ్చరిక', 'సమ్మె', 'కాంట్రవర్సీ', 'వార్నింగ్',
]
_CINEMA_TE = [
    'సినిమా', 'చిత్రం', 'నటుడు', 'నటి', 'హీరో', 'హీరోయిన్', 'దర్శకుడు',
    'రిలీజ్', 'ట్రెయిలర్', 'అవార్డు', 'ఓటీటీ', 'టాలీవుడ్', 'బాలీవుడ్',
    'మూవీ', 'షూటింగ్', 'నేషనల్ అవార్డు',
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
_CINEMA_EN = [
    'movie', 'film', 'actor', 'actress', 'director', 'release', 'trailer',
    'award', 'ott', 'tollywood', 'bollywood', 'cinema', 'star', 'national award',
]


def detect_emotion(text: str) -> tuple[str, str]:
    """
    Returns (rate_adjustment, pitch_adjustment) SSML prosody values.
    victory     → faster, brighter pitch   (upbeat sports energy)
    cinema      → slightly faster, warmer  (entertainment excitement)
    grief       → slower, lower pitch      (somber)
    tension     → slightly slower          (serious/grave)
    neutral     → default
    """
    tl = text.lower()
    victory = (sum(1 for w in _VICTORY_TE if w in text) +
               sum(1 for w in _VICTORY_EN if w in tl))
    grief   = (sum(1 for w in _GRIEF_TE   if w in text) +
               sum(1 for w in _GRIEF_EN   if w in tl))
    tension = (sum(1 for w in _TENSION_TE if w in text) +
               sum(1 for w in _TENSION_EN if w in tl))
    cinema  = (sum(1 for w in _CINEMA_TE  if w in text) +
               sum(1 for w in _CINEMA_EN  if w in tl))

    # grief and tension override entertainment signals
    if grief > 0 or tension > 0:
        dominant_neg = max(grief, tension)
        if grief >= tension:
            return ('-5%', '-3Hz')   # somber — slower, lower
        else:
            return ('-2%', '-1Hz')    # serious/tense

    if victory > 0:
        return ('+5%', '+3Hz')        # sports win — faster, brighter

    if cinema > 0:
        return ('+3%', '+2Hz')        # entertainment — slightly upbeat, engaging

    return ('-5%', '+0Hz')            # neutral


# ── Silent MP3 gap ────────────────────────────────────────────────────────────
def make_silent_mp3(duration_ms: int = 700) -> bytes:
    """
    Return bytes of a valid-ish silent MP3 for inter-headline gaps.
    Uses MPEG1 Layer3 32kbps mono frame (each frame ≈ 24ms).
    Frames: duration_ms / 24  (rounded up).
    The silent frame bytes are standard for 32kbps 44100Hz mono.
    """
    # MPEG1 Layer3 32kbps 44100Hz mono — 104 bytes per frame, ~24ms each
    # Header breakdown: 0xFF 0xFB = sync + MPEG1/Layer3;
    #   0x10 = bitrate-index 0001 (32kbps); 0xC4 = 44100Hz + mono channel mode
    # Total frame size = 144 * bitrate / sample_rate + padding = 144*32000/44100 = 104 bytes ✓
    SILENT_FRAME = (
        b'\xff\xfb\x10\xc4'   # MP3 frame header: MPEG1 L3 32kbps 44100Hz mono
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
        # All segments are synthesised IN PARALLEL (asyncio.gather) to avoid
        # sequential API round-trips — 8 headlines used to take 8–16s, now ~2s.
        # After gathering, insert 1500ms silence between every pair so headlines
        # sound clearly separated when read aloud.
        tmp_dir = tempfile.mkdtemp()
        chunk_files = []   # list of {'type', 'path'}

        try:
            async def synthesise_seg(i, seg):
                rate, pitch = detect_emotion(seg['text'])
                print(f"[tts_helper] seg {i+1}/{len(segments)} [{seg['type']}]: "
                      f"rate={rate} pitch={pitch} | {seg['text'][:60]}", file=sys.stderr)
                chunk_path = os.path.join(tmp_dir, f'chunk_{i:03d}.mp3')
                await synthesise(seg['text'], voice, rate, pitch, chunk_path)
                return {'type': seg['type'], 'path': chunk_path}

            # Run all TTS calls in parallel — drastically reduces total latency
            results = await asyncio.gather(*[synthesise_seg(i, seg) for i, seg in enumerate(segments)])
            chunk_files = list(results)   # already in order because gather preserves index

            # Concatenate: 2000ms silence between every pair — gives readers a
            # clear auditory break between headlines.
            silence = make_silent_mp3(2000)
            with open(output_mp3, 'wb') as out:
                for i, chunk in enumerate(chunk_files):
                    with open(chunk['path'], 'rb') as f:
                        out.write(f.read())
                    if i < len(chunk_files) - 1:   # no trailing silence
                        out.write(silence)

        finally:
            # Clean up ALL files in tmp_dir — not just the ones in chunk_files.
            # If asyncio.gather raises mid-way, chunk_files may be empty/partial
            # while some chunks were already written to disk → glob tmp_dir instead.
            try:
                for fname in os.listdir(tmp_dir):
                    try:
                        os.unlink(os.path.join(tmp_dir, fname))
                    except OSError:
                        pass
                os.rmdir(tmp_dir)
            except OSError:
                pass


asyncio.run(main())
