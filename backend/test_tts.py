"""
test_tts.py — TTS endpoint test runner
Usage: python3 backend/test_tts.py
Requires: backend server running on localhost:3001
          pip install requests --break-system-packages
"""
import json
import os
import subprocess
import sys
import urllib.request
import urllib.error

BASE_URL = "http://localhost:3001/api/tts"
OUT_DIR  = "/tmp/newsai_tts_tests"
os.makedirs(OUT_DIR, exist_ok=True)

TESTS = [
    {
        "id": "T1",
        "name": "Victory headlines (3 lines) — expect gaps + upbeat prosody",
        "body": {
            "lang": "te",
            "text": (
                "బెల్లింగ్‌హామ్ డబుల్.. క్వార్టర్ ఫైనల్‌కు ఇంగ్లండ్\n"
                "ఎంబపే జోరు.. ఫ్రాన్స్ క్వార్టర్‌ఫైనల్‌లో\n"
                "భారత్ ఘన విజయం.. శ్రీలంక 10 వికెట్ల తేడా"
            ),
        },
        "expect": "headline_list=True | 3 chunks | rate=+5% pitch=+3Hz each",
    },
    {
        "id": "T2",
        "name": "Grief + tension headlines (2 lines)",
        "body": {
            "lang": "te",
            "text": (
                "నెయ్‌మార్‌ కన్నీటి వీడ్కోలు.. అంతర్జాతీయ ఫుట్‌బాల్‌కు\n"
                "పసికూన చేతిలో పరాభవం.. ఇంగ్లండ్‌లోనూ అదే తడబాటు"
            ),
        },
        "expect": "headline_list=True | line1: rate=-15% pitch=-3Hz | line2: rate=-8% pitch=-1Hz",
    },
    {
        "id": "T3",
        "name": "Neutral paragraph (single block of text)",
        "body": {
            "lang": "te",
            "text": (
                "వైభవ్ తప్పు చేశాడు అస్సలు ఊహించలేదు అని సునీల్ గవాస్కర్ అన్నారు. "
                "ఆట మొదటి ఇన్నింగ్స్‌లో అతను ఔట్ అయ్యాడు."
            ),
        },
        "expect": "paragraph mode | 1 chunk | rate=-5% pitch=+0Hz",
    },
    {
        "id": "T4",
        "name": "5 headlines — verify exactly 4 gaps",
        "body": {
            "lang": "te",
            "text": (
                "రవి బిష్ణోయ్ చెత్త రికార్డు.. టీ20ల్లో తొలి ప్లేయర్‌గా\n"
                "స్వియాటెక్‌కు షాక్ లండన్\n"
                "ప్రిన్స్ యాదవ్ అరుదైన రికార్డు\n"
                "తెలంగాణకు మూడు స్వర్ణాలు\n"
                "ప్రీ క్వార్టర్స్‌కు కొలంబియా.. ఘనాపై ఘన విజయం"
            ),
        },
        "expect": "headline_list=True | 5 chunks | 4 × 750ms silence gaps",
    },
    {
        "id": "T5",
        "name": "Single headline — paragraph mode, no gap",
        "body": {
            "lang": "te",
            "text": "అర్జెంటీనా మూడు సార్లు ప్రపంచ కప్ విజేత",
        },
        "expect": "paragraph (1 line) | rate=+5% pitch=+3Hz (విజేత)",
    },
    {
        "id": "T6",
        "name": "Abbreviations + currency + percentage normalisation",
        "body": {
            "lang": "te",
            "text": (
                "₹82,450 కోట్ల బడ్జెట్.. GDP 7.2% పెరిగింది\n"
                "CM హుజ్జత్ సమావేశం నేడు\n"
                "IPL వేలం ₹1,200 కోట్లు"
            ),
        },
        "expect": "₹→రూపాయలు | %→శాతం | CM→ముఖ్యమంత్రి | IPL→ఐ పీ ఎల్",
    },
    {
        "id": "T7",
        "name": "English paragraph",
        "body": {
            "lang": "en",
            "text": (
                "Bellingham scores a double as England reach the quarter-finals. "
                "France's Mbappe also advances with a stunning victory."
            ),
        },
        "expect": "voice=en-IN-NeerjaNeural | paragraph | rate=+5% pitch=+3Hz",
    },
    {
        "id": "T8",
        "name": "Mixed: short headlines + long body paragraph",
        "body": {
            "lang": "te",
            "text": (
                "సంజూపై వేటు.. జట్టులోకి విధ్వంసకర ఓపెనర్‌\n"
                "జింబాబ్వేతో జ‌ర‌గ‌నున్న మూడు మ్యాచ్‌ల T20 సిరీస్ కోసం బీసీసీఐ సోమవారం "
                "టీమిండియా జ‌ట్టును ప్ర‌క‌టించింది. శ్రేయస్‌ అయ్యర్‌ సారథ్యంలో 15 మందితో "
                "కూడిన జట్టులో ఓపెనర్‌ సంజూ శాంసన్‌కు చోటు దక్కలేదు.\n"
                "బెల్లింగ్‌హామ్ డబుల్.. క్వార్టర్ ఫైనల్‌కు ఇంగ్లండ్‌\n"
                "ఎంబపే జోరు.. క్వార్టర్‌ఫైనల్‌లో మొరాకో, ఫ్రాన్స్‌"
            ),
        },
        "expect": "mixed mode | 4 segments (2 headlines + 1 para + 1 headline) | gaps between all",
    },
    {
        "id": "T9",
        "name": "T20 / IPL pronunciation",
        "body": {
            "lang": "te",
            "text": (
                "T20 వరల్డ్ కప్‌లో భారత్ విజయం\n"
                "IPL 2026 వేలం ₹1,200 కోట్లకు చేరింది"
            ),
        },
        "expect": "T20→టీ ట్వంటీ | IPL→ఇండియన్ ప్రీమియర్ లీగ్ | 2 headline chunks | gap",
    },
    {
        "id": "T10",
        "name": "Empty text — expect 400 error",
        "body": {"lang": "te", "text": "   "},
        "expect": "HTTP 400 | {\"error\": \"text is required\"}",
        "expect_error": True,
    },
    {
        "id": "T11",
        "name": "Invalid voice — expect 400 error",
        "body": {"lang": "te", "text": "నమస్కారం", "voice": "evil-voice; rm -rf /"},
        "expect": "HTTP 400 | {\"error\": \"Invalid voice...\"}",
        "expect_error": True,
    },
]

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

def post(body):
    data = json.dumps(body).encode("utf-8")
    req  = urllib.request.Request(
        BASE_URL,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read(), resp.headers.get("X-Voice", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), ""

def play(mp3_path):
    """Play mp3 via afplay (macOS). Non-blocking."""
    subprocess.Popen(["afplay", mp3_path],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def run():
    print(f"\n{BOLD}NewsAI TTS Test Suite{RESET}  →  {BASE_URL}\n")
    passed = failed = 0

    for t in TESTS:
        tid   = t["id"]
        name  = t["name"]
        body  = t["body"]
        exp   = t["expect"]
        is_err = t.get("expect_error", False)

        print(f"{CYAN}{tid}{RESET} {name}")
        print(f"     expect : {YELLOW}{exp}{RESET}")

        status, content, voice_hdr = post(body)

        if is_err:
            if status >= 400:
                try:
                    err_body = json.loads(content)
                    print(f"     result : {GREEN}✅ HTTP {status} — {err_body}{RESET}")
                except Exception:
                    print(f"     result : {GREEN}✅ HTTP {status}{RESET}")
                passed += 1
            else:
                print(f"     result : {RED}❌ Expected error, got HTTP {status}{RESET}")
                failed += 1
        else:
            if status == 200:
                size_kb = len(content) / 1024
                mp3_path = os.path.join(OUT_DIR, f"{tid}.mp3")
                with open(mp3_path, "wb") as f:
                    f.write(content)
                voice_info = f" | voice: {voice_hdr}" if voice_hdr else ""
                print(f"     result : {GREEN}✅ HTTP 200 | {size_kb:.1f} KB{voice_info}{RESET}")
                print(f"     saved  : {mp3_path}")
                play(mp3_path)
                passed += 1
            else:
                try:
                    err = json.loads(content)
                    print(f"     result : {RED}❌ HTTP {status} — {err}{RESET}")
                except Exception:
                    print(f"     result : {RED}❌ HTTP {status} — {content[:200]}{RESET}")
                failed += 1

        print()

    print(f"{BOLD}Results: {GREEN}{passed} passed{RESET}{BOLD}, {RED}{failed} failed{RESET}\n")
    print(f"MP3 files saved to: {OUT_DIR}")
    print("Play any file with: afplay /tmp/newsai_tts_tests/T1.mp3\n")

if __name__ == "__main__":
    run()
