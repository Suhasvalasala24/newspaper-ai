"""
edge_tts_mixed.py — Mixed Telugu/English text-to-speech for NewsAI.

Supports:
  • Mixed Telugu + English text (code-switching, e.g. "ఈరోజు Hyderabad లో...")
  • Auto language detection per sentence
  • Section-by-section audio from a JSON articles file
  • CLI arguments for custom text, voice, and output

Install:
    pip install edge-tts

Usage examples:
    # Read a single text string (auto-detects language)
    python edge_tts_mixed.py --text "ఈరోజు Hyderabad లో భారీ వర్షాలు కురిశాయి."

    # Read from a text file
    python edge_tts_mixed.py --file news_script.txt --output bulletin.mp3

    # Read articles from a JSON file (section-by-section)
    python edge_tts_mixed.py --articles articles.json --output-dir ./audio/

    # Use a specific voice
    python edge_tts_mixed.py --text "Hello" --voice en-IN-PrabhatNeural --output hello.mp3

    # List all available Telugu and English voices
    python edge_tts_mixed.py --list-voices
"""

import asyncio
import argparse
import json
import os
import re
import sys
from pathlib import Path

import edge_tts

# ── Voice configuration ────────────────────────────────────────────────────────

VOICES = {
    'te':        'te-IN-MohanNeural',    # Telugu Male   (default)
    'te-female': 'te-IN-ShrutiNeural',   # Telugu Female
    'en':        'en-IN-NeerjaNeural',   # English Female (default)
    'en-male':   'en-IN-PrabhatNeural',  # English Male
}

DEFAULT_VOICE = VOICES['te']

# ── Language detection ─────────────────────────────────────────────────────────

TELUGU_RE = re.compile(r'[ఀ-౿]')  # Telugu Unicode block

def detect_lang(text: str) -> str:
    """Return 'te' if text contains significant Telugu script, else 'en'."""
    telugu_chars = len(TELUGU_RE.findall(text))
    total_chars  = len(text.replace(' ', ''))
    if total_chars == 0:
        return 'en'
    return 'te' if telugu_chars / total_chars > 0.15 else 'en'

def voice_for_text(text: str, prefer_female: bool = False) -> str:
    """Pick the best Edge TTS voice based on text language."""
    lang = detect_lang(text)
    if lang == 'te':
        return VOICES['te-female'] if prefer_female else VOICES['te']
    else:
        return VOICES['en'] if prefer_female else VOICES['en-male']

# ── Core TTS function ──────────────────────────────────────────────────────────

async def synthesise(text: str, output_path: str, voice: str | None = None) -> None:
    """Convert text to MP3 using Edge TTS and save to output_path."""
    chosen_voice = voice or voice_for_text(text)
    print(f"  🎙  Voice: {chosen_voice}")
    print(f"  📝  Text ({len(text)} chars): {text[:80]}{'...' if len(text) > 80 else ''}")

    communicate = edge_tts.Communicate(text, chosen_voice)
    await communicate.save(output_path)
    size_kb = os.path.getsize(output_path) / 1024
    print(f"  ✅  Saved → {output_path}  ({size_kb:.1f} KB)")

# ── Article batch mode ─────────────────────────────────────────────────────────

async def synthesise_articles(articles_path: str, output_dir: str, voice: str | None = None) -> None:
    """
    Read a JSON file of articles (same shape as NewsAI contentSource API response)
    and generate one MP3 per section.

    Expected JSON format:
        {
          "articles": [
            { "headline": "...", "section": "National", "summary": "...", "body": "..." },
            ...
          ]
        }
    """
    with open(articles_path, encoding='utf-8') as f:
        data = json.load(f)

    articles = data.get('articles', data) if isinstance(data, dict) else data
    if not articles:
        print("No articles found in JSON file.")
        return

    # Group by section
    sections: dict[str, list] = {}
    for a in articles:
        sec = a.get('section', 'General')
        sections.setdefault(sec, []).append(a)

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    print(f"\n📰  Generating audio for {len(sections)} sections, {len(articles)} articles...\n")

    for sec, items in sections.items():
        # Build the section script
        lines = [f"{sec} వార్తలు." if detect_lang(sec) == 'te' else f"{sec} news."]
        for i, a in enumerate(items, 1):
            headline = a.get('headline', '')
            summary  = a.get('summary', '') or a.get('body', '')[:200]
            if headline:
                lines.append(f"{i}. {headline}.")
            if summary:
                lines.append(summary.strip())
            lines.append('')  # pause between articles

        script = '\n'.join(lines).strip()
        safe_sec = re.sub(r'[^\w\s-]', '', sec).strip().replace(' ', '_')
        out_file = os.path.join(output_dir, f"{safe_sec}.mp3")

        print(f"▶  Section: {sec} ({len(items)} articles)")
        chosen = voice or voice_for_text(script)
        await synthesise(script, out_file, voice=chosen)
        print()

# ── Voice listing ──────────────────────────────────────────────────────────────

async def list_voices() -> None:
    """Print all Telugu and English voices available in Edge TTS."""
    voices = await edge_tts.list_voices()
    te_voices = [v for v in voices if v['Locale'].startswith('te')]
    en_in     = [v for v in voices if v['Locale'].startswith('en-IN')]

    print("\n🔈  Telugu voices:")
    for v in te_voices:
        print(f"    {v['ShortName']:<35} {v['Gender']}")

    print("\n🔈  English (India) voices:")
    for v in en_in:
        print(f"    {v['ShortName']:<35} {v['Gender']}")
    print()

# ── Demo bulletin ──────────────────────────────────────────────────────────────

DEMO_TEXT = """
నమస్కారం. Welcome to today's Eenadu news bulletin.

ఈరోజు Hyderabad లో భారీ వర్షాలు కురిశాయి. The IMD has issued a yellow alert
for several districts in Telangana and Andhra Pradesh.

రాష్ట్ర ప్రభుత్వం irrigation projects కోసం రూ. 500 కోట్లు కేటాయించింది.
The state government has allocated ₹500 crores for irrigation projects.

Sports లో, India cricket team ఆస్ట్రేలియాపై Test మ్యాచ్ లో విజయం సాధించింది.
India beat Australia in the first Test match by 6 wickets.

మరిన్ని updates కోసం మా website ను సందర్శించండి. ధన్యవాదాలు.
""".strip()

# ── CLI ────────────────────────────────────────────────────────────────────────

async def main() -> None:
    parser = argparse.ArgumentParser(
        description='NewsAI Edge TTS — mixed Telugu/English text to speech',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('--text',        help='Text string to synthesise')
    parser.add_argument('--file',        help='Path to a .txt file to read')
    parser.add_argument('--articles',    help='Path to a JSON articles file (batch mode)')
    parser.add_argument('--output',      default='output.mp3', help='Output MP3 path (default: output.mp3)')
    parser.add_argument('--output-dir',  default='./audio',    help='Output folder for batch mode (default: ./audio)')
    parser.add_argument('--voice',       help='Override voice (e.g. te-IN-ShrutiNeural)')
    parser.add_argument('--female',      action='store_true',  help='Prefer female voice (Shruti/Neerja)')
    parser.add_argument('--list-voices', action='store_true',  help='List available Telugu/English voices and exit')
    args = parser.parse_args()

    if args.list_voices:
        await list_voices()
        return

    if args.articles:
        await synthesise_articles(args.articles, args.output_dir, voice=args.voice)
        return

    # Single-text mode
    text = None
    if args.text:
        text = args.text
    elif args.file:
        with open(args.file, encoding='utf-8') as f:
            text = f.read()
    else:
        # No args — run demo bulletin
        print("No --text or --file provided. Running demo bulletin...\n")
        text = DEMO_TEXT

    # Pick voice
    if args.voice:
        voice = args.voice
    elif args.female:
        voice = voice_for_text(text, prefer_female=True)
    else:
        voice = voice_for_text(text)

    print(f"\n🎙  Generating audio...")
    await synthesise(text, args.output, voice=voice)
    print(f"\n▶  Play with:  open {args.output}  (or:  ffplay {args.output})\n")


if __name__ == '__main__':
    asyncio.run(main())
