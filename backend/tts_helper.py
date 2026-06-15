"""
tts_helper.py — Called by backend/routes/tts.js via python3.
Usage: python3 tts_helper.py <voice> <text_file> <output_mp3>
"""
import asyncio
import sys
import edge_tts

async def main():
    if len(sys.argv) != 4:
        print("Usage: tts_helper.py <voice> <text_file> <output_mp3>", file=sys.stderr)
        sys.exit(1)

    voice      = sys.argv[1]
    text_file  = sys.argv[2]
    output_mp3 = sys.argv[3]

    with open(text_file, encoding='utf-8') as f:
        text = f.read().strip()

    if not text:
        print("Empty text", file=sys.stderr)
        sys.exit(1)

    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(output_mp3)

asyncio.run(main())
