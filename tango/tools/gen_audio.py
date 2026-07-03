# -*- coding: utf-8 -*-
"""Tạo MP3 phát âm cho toàn bộ bank bằng edge-tts (giọng neural, giống N1 quiz).

Đọc data/bank.json → ghi audio/{id}.mp3 (đọc theo cách đọc kana `r` cho chuẩn).
Chỉ tạo file còn thiếu — sửa bank xong chạy lại là đủ.

Chạy:  py -3 -X utf8 tools/gen_audio.py   (từ thư mục tango/)
"""
import asyncio, json, sys
from pathlib import Path

import edge_tts

HERE = Path(__file__).resolve().parent.parent   # .../tango
VOICE = "ja-JP-NanamiNeural"
CONCURRENCY = 6


async def gen_one(sem, item, outdir, stats):
    f = outdir / f"{item['id']}.mp3"
    if f.exists() and f.stat().st_size > 500:
        stats["skip"] += 1
        return
    text = item.get("r") or item["w"]
    async with sem:
        for attempt in (1, 2, 3):
            try:
                await edge_tts.Communicate(text, VOICE).save(str(f))
                if f.stat().st_size > 500:
                    stats["ok"] += 1
                    return
            except Exception as e:
                if attempt == 3:
                    stats["fail"].append((item["id"], item["w"], str(e)[:80]))
                await asyncio.sleep(1.5 * attempt)


async def main():
    bank = json.loads((HERE / "data" / "bank.json").read_text(encoding="utf-8"))
    outdir = HERE / "audio"
    outdir.mkdir(exist_ok=True)
    sem = asyncio.Semaphore(CONCURRENCY)
    stats = {"ok": 0, "skip": 0, "fail": []}
    await asyncio.gather(*[gen_one(sem, it, outdir, stats) for it in bank["items"]])
    print(f"OK mới: {stats['ok']} · đã có sẵn: {stats['skip']} · lỗi: {len(stats['fail'])}")
    for fid, w, e in stats["fail"]:
        print("  FAIL", fid, w, e)
    if stats["fail"]:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
