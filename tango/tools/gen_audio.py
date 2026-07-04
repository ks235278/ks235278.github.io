# -*- coding: utf-8 -*-
"""Tạo MP3 phát âm cho toàn bộ bank bằng edge-tts (giọng neural, giống N1 quiz).

Đọc data/bank.json → ghi:
  audio/{id}.mp3      — đọc TỪ theo cách đọc kana `r` (đã là trọn cụm)
  audio/{id}_ex.mp3   — đọc CÂU VÍ DỤ theo ĐÚNG FURIGANA hiển thị:
                        mọi cụm kanji được thay bằng phần rt (kana) trước khi
                        đưa cho máy đọc → không còn kiểu 労う bị đọc ろう.
Chỉ tạo file còn thiếu — sửa bank xong chạy lại là đủ.
(r đổi thì phải xoá mp3 cũ của mục đó trước, script không tự so nội dung.)

Chạy:  py -3 -X utf8 tools/gen_audio.py              (từ thư mục tango/)
       py -3 -X utf8 tools/gen_audio.py --force-ex   (GHI ĐÈ toàn bộ *_ex.mp3
                                                      — dùng khi đổi cách đọc câu)
"""
import asyncio, json, re, sys
from pathlib import Path

import edge_tts

HERE = Path(__file__).resolve().parent.parent   # .../tango
VOICE = "ja-JP-NanamiNeural"
CONCURRENCY = 6

RUBY = re.compile(r"<ruby>.*?<rt>(.*?)</rt></ruby>", re.S)
RT = re.compile(r"<rt>.*?</rt>", re.S)
TAG = re.compile(r"<.*?>", re.S)


def tts_text_word(s):
    """Từ: r đã là kana trọn cụm — chỉ bỏ thẻ + ký hiệu 〜."""
    return TAG.sub("", RT.sub("", s)).replace("〜", "").strip()


def tts_text_ex(s):
    """Câu ví dụ: thay từng cụm <ruby>kanji<rt>kana</rt></ruby> bằng kana
    → máy đọc đúng y furigana trên màn, không tự đoán cách đọc kanji."""
    s = RUBY.sub(lambda m: m.group(1), s)
    return TAG.sub("", s).replace("〜", "").strip()


async def gen_one(sem, fid, text, outdir, stats, label, force=False):
    f = outdir / f"{fid}.mp3"
    if not force and f.exists() and f.stat().st_size > 500:
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
    force_ex = "--force-ex" in sys.argv
    bank = json.loads((HERE / "data" / "bank.json").read_text(encoding="utf-8"))
    outdir = HERE / "audio"
    outdir.mkdir(exist_ok=True)
    sem = asyncio.Semaphore(CONCURRENCY)
    stats = {"ok": 0, "skip": 0, "fail": []}
    jobs = []
    for it in bank["items"]:
        word = tts_text_word(it.get("r") or it["w"])
        if word:
            jobs.append(gen_one(sem, it["id"], word, outdir, stats, it["w"]))
        ex = tts_text_ex(it.get("ex") or "")
        if ex:
            jobs.append(gen_one(sem, it["id"] + "_ex", ex, outdir, stats,
                                it["w"] + " (ví dụ)", force=force_ex))
    await asyncio.gather(*jobs)
    print(f"OK mới: {stats['ok']} · đã có sẵn: {stats['skip']} · lỗi: {len(stats['fail'])}")
    for fid, w, e in stats["fail"]:
        print("  FAIL", fid, w, e)
    if stats["fail"]:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
