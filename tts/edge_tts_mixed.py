"""
edge_tts_mixed.py — Mixed Telugu/English text-to-speech using Microsoft Edge TTS.

Usage:
    pip install edge-tts
    python edge_tts_mixed.py

Voices:
    te-IN-MohanNeural   — Male Telugu
    te-IN-ShrutiNeural  — Female Telugu
"""

import asyncio
import edge_tts

TEXT = """
నమస్కారం. Welcome to today's news bulletin.
ఈరోజు Hyderabad లో భారీ వర్షాలు కురిశాయి.
The IMD has issued a yellow alert for several districts.
మరిన్ని updates కోసం మా website ను సందర్శించండి.
ధన్యవాదాలు.
"""

VOICE = "te-IN-MohanNeural"   # Male Telugu voice
# VOICE = "te-IN-ShrutiNeural"  # Female Telugu voice

OUTPUT_FILE = "mixed_news.mp3"


async def main():
    communicate = edge_tts.Communicate(TEXT, VOICE)
    await communicate.save(OUTPUT_FILE)
    print(f"Audio saved as {OUTPUT_FILE}")


if __name__ == "__main__":
    asyncio.run(main())
