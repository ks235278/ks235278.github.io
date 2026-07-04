# -*- coding: utf-8 -*-
"""Tạo MP3 phát âm cho toàn bộ bank bằng edge-tts (giọng neural, giống N1 quiz).

Đọc data/bank.json → ghi:
  audio/{id}.mp3      — đọc TỪ theo cách đọc kana `r` (đã là trọn cụm)
  audio/{id}_ex.mp3   — đọc CÂU VÍ DỤ (bỏ furigana/thẻ HTML)
Chỉ tạo file còn thiếu — sửa bank xong chạy lại là đủ.
(r đổi thì phải xoá mp3 cũ của mục đó trước, script không tự so nội dung.)

Chạy:  py -3 -X utf8 tools/gen_audio.py   (từ thư mục tango/)
"""
import asyncio, json, re, sys
from pathlib import Path

import edge_tts

HERE = Path(__file__).resolve().parent.parent   # .../tango
VOICE = "ja-JP-NanamiNeural"
CONCURRENCY = 6

RT = re.compile(r"<rt>.*?</rt>", re.S)
TAG = re.compile(r"<.*?>", re.S)


def tts_text(s):
    """Bỏ furigana + thẻ HTML + ký hiệu 〜 (edge-tts đọc linh tinh)."""
    return TAG.sub("", RT.sub("", s)).replace("〜", "").strip()


async def gen_one(sem, fid, text, outdir, stats, label):
    f = outdir / f"{fid}.mp3"
    if f.exists() and f.stat().st_size > 500:
        stats["skip"] += 1
        return
    async with sem:
        for attempt in (1, 2, 3):
            try:
                await edge_tts.Communicate(text, VOICE).save(str(f))
                if f.stat().st_size > 500:
                    stats["ok"] += 1
                    return
            except Exception as e:
                if attempt == 3:
                    stats["fail"].append((fid, label, str(e)[:80]))
                await asyncio.sleep(1.5 * attempt)


async def main():
    bank = json.loads((HERE / "data" / "bank.json").read_text(encoding="utf-8"))
    outdir = HERE / "audio"
    outdir.mkdir(exist_ok=True)
    sem = asyncio.Semaphore(CONCURRENCY)
    stats = {"ok": 0, "skip": 0, "fail": []}
    jobs = []
    for it in bank["items"]:
        word = tts_text(it.get("r") or it["w"])
        if word:
            jobs.append(gen_one(sem, it["id"], word, outdir, stats, it["w"]))
        ex = tts_text(it.get("ex") or "")
        if ex:
            jobs.append(gen_one(sem, it["id"] + "_ex", ex, outdir, stats, it["w"] + " (ví dụ)"))
    await asyncio.gather(*jobs)
    print(f"OK mới: {stats['ok']} · đã có sẵn: {stats['skip']} · lỗi: {len(stats['fail'])}")
    for fid, w, e in stats["fail"]:
        print("  FAIL", fid, w, e)
    if stats["fail"]:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
