#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tạo sẵn audio neural (edge-tts) cho N1 quiz.

- Đọc DATA trong ../index.html, suy ra ĐÚNG các chuỗi mà speak() sẽ phát
  (port nguyên 3 hàm JS: stripHtml / answerAudio / sentenceText).
- Đặt tên file theo hash FNV-1a 64-bit (giống hệt hàm fnv1a() trong index.html)
  -> runtime chỉ cần hash chuỗi rồi phát audio/<hash>.mp3.
- Idempotent: bỏ qua file đã có -> chạy lại chỉ bù phần thiếu.

Cách dùng:
    py -3 tools/gen_audio.py                # giọng mặc định Nanami
    py -3 tools/gen_audio.py --voice ja-JP-KeitaNeural
    py -3 tools/gen_audio.py --rate=-10%    # đọc chậm lại 10%
"""
import re, json, os, sys, asyncio, argparse, hashlib  # noqa
import edge_tts

try:                                      # console Windows hay là cp1252 -> ép UTF-8
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                 # .../n1-quiz
HTML = os.path.join(ROOT, "index.html")
AUDIO_DIR = os.path.join(ROOT, "audio")

# ── Hash: phải KHỚP TUYỆT ĐỐI với fnv1a() trong index.html ──────────────
def fnv1a(s: str) -> str:
    h = 0xcbf29ce484222325
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001b3) & 0xffffffffffffffff
    return format(h, "016x")

# ── Port 3 hàm thuần từ index.html (giữ y hệt logic regex) ──────────────
_RT   = re.compile(r"<rt[^>]*>.*?</rt>", re.S)
_TAG  = re.compile(r"<[^>]+>")
_WS   = re.compile(r"\s+")
_BLANK= re.compile(r'<span class="blank">.*?</span>', re.S)
_BOLD = re.compile(r"⟦(.+?)⟧")

def strip_html(html: str) -> str:
    html = _RT.sub("", html)
    html = _TAG.sub("", html)
    html = _WS.sub(" ", html)
    return html.strip()

def answer_audio(q: dict) -> str:
    m = _BOLD.search(q["q"])
    if m:
        return q.get("r") or m.group(1)
    opts = q.get("opts") or []
    return opts[0] if opts else ""       # opts[0] = đáp án đúng (correct:i===0)

def sentence_text(q: dict, ans: str) -> str:
    return strip_html(_BLANK.sub(ans or "", q["qa"], count=1))

# ── Lấy DATA từ index.html ──────────────────────────────────────────────
def load_data() -> list:
    src = open(HTML, encoding="utf-8").read()
    m = re.search(r"const DATA = (\[.*?\]);", src, re.S)
    if not m:
        sys.exit("Không tìm thấy `const DATA = [...]` trong index.html")
    return json.loads(m.group(1))

def spoken_strings(data: list) -> dict:
    """Trả về {hash: text} cho mọi chuỗi speak() có thể nhận."""
    out = {}
    for q in data:
        opt0 = (q.get("opts") or [""])[0]
        for t in (answer_audio(q), sentence_text(q, ""), sentence_text(q, opt0)):
            t = t.strip()
            if t:
                out[fnv1a(t)] = t
    return out

# ── Sinh audio ──────────────────────────────────────────────────────────
async def synth_one(sem, h, text, voice, rate):
    path = os.path.join(AUDIO_DIR, h + ".mp3")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return ("skip", h)
    async with sem:
        for attempt in range(3):
            try:
                kw = {}
                if rate:
                    kw["rate"] = rate
                c = edge_tts.Communicate(text, voice, **kw)
                tmp = path + ".part"
                await c.save(tmp)
                os.replace(tmp, path)
                return ("ok", h)
            except Exception as e:                       # mạng chập chờn -> thử lại
                if attempt == 2:
                    return ("err", f"{h}: {e}")
                await asyncio.sleep(1.5 * (attempt + 1))

async def main_async(voice, rate, concurrency):
    os.makedirs(AUDIO_DIR, exist_ok=True)
    data = load_data()
    strings = spoken_strings(data)
    print(f"{len(data)} câu  ->  {len(strings)} clip duy nhất")
    sem = asyncio.Semaphore(concurrency)
    tasks = [synth_one(sem, h, t, voice, rate) for h, t in strings.items()]
    ok = skip = 0
    errs = []
    done = 0
    for fut in asyncio.as_completed(tasks):
        status, info = await fut
        done += 1
        if status == "ok":   ok += 1
        elif status == "skip": skip += 1
        else: errs.append(info)
        if done % 50 == 0 or done == len(tasks):
            print(f"  ... {done}/{len(tasks)}  (mới {ok}, bỏ qua {skip}, lỗi {len(errs)})")
    # manifest = danh sách hash hiện có trên đĩa
    have = sorted(f[:-4] for f in os.listdir(AUDIO_DIR) if f.endswith(".mp3"))
    with open(os.path.join(AUDIO_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(have, f)
    print(f"\nXong: {ok} mới, {skip} sẵn có, {len(errs)} lỗi.  manifest: {len(have)} file.")
    if errs:
        print("LỖI (chạy lại script để bù):")
        for e in errs[:20]:
            print("  -", e)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="ja-JP-NanamiNeural")
    ap.add_argument("--rate", default="", help='vd: "-10%%" để đọc chậm lại')
    ap.add_argument("--concurrency", type=int, default=8)
    a = ap.parse_args()
    asyncio.run(main_async(a.voice, a.rate, a.concurrency))

if __name__ == "__main__":
    main()
