# -*- coding: utf-8 -*-
"""Trích subset bank cho app tango từ DATA của n1-quiz/index.html.

Mỗi mục DATA có trường vn dạng 「từ」(cách đọc): nghĩa tiếng Việt — đó là
nguồn chân lý cho khuôn câu hỏi tango (từ to giữa màn + hỏi nghĩa VI).

Chạy:  py -3 -X utf8 tools/extract_bank.py   (từ thư mục tango/)
Ghi ra: data/bank.json  và  functions/bank.json (bản cho Cloud Functions)
"""
import json, re, sys, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent          # .../tango
SRC  = HERE.parent / "n1-quiz" / "index.html"           # .../ghsite/n1-quiz/index.html

VN_RE = re.compile(r"「(.+?)」\s*(?:[（(](.+?)[)）])?\s*[:：]\s*(.+)", re.S)
BLANK_RE = re.compile(r'<span class="blank">.*?</span>')


def fnv1a64(s: str) -> str:
    h = 0xCBF29CE484222325
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"


def load_data(src_path: Path):
    src = src_path.read_text(encoding="utf-8")
    m = re.search(r"const\s+DATA\s*=\s*", src)
    if not m:
        sys.exit("Không tìm thấy 'const DATA =' trong " + str(src_path))
    i = m.end()
    depth = 0
    start = i
    while True:
        c = src[i]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return json.loads(src[start : i + 1])


def main():
    data = load_data(SRC)
    items, skipped, seen = [], 0, set()
    for it in data:
        m = VN_RE.match(it.get("vn", "").strip())
        if not m:
            skipped += 1
            continue
        word, reading, meaning = ((g or "").strip() for g in m.groups())
        reading = reading or word  # từ thuần kana: cách đọc là chính nó
        meaning = meaning.rstrip(". ").strip()
        key = f"{word}|{reading}"
        if key in seen:
            skipped += 1
            continue
        seen.add(key)

        ex = it.get("qa", "")
        if 'class="blank"' in ex:
            # câu cloze: điền đáp án (dạng chia trong opts[0]) vào chỗ trống, kèm ruby
            surface = (it.get("opts") or [word])[0]
            rt = it.get("ra") or it.get("r") or reading
            fill = f'<span class="targ"><ruby>{surface}<rt>{rt}</rt></ruby></span>'
            ex = BLANK_RE.sub(fill, ex)

        items.append({
            "id": "t_" + fnv1a64(key),
            "w": word,
            "r": reading,
            "m": meaning,
            "jp": (it.get("jp") or "").strip(),
            "ex": ex,
            "exvi": (it.get("vt") or "").strip(),
            "lv": "N1",
        })

    bank = {
        "v": 1,
        "generated": datetime.date.today().isoformat(),
        "source": "n1-quiz index.html DATA (subset để test tango)",
        "count": len(items),
        "items": items,
    }
    out1 = HERE / "data" / "bank.json"
    out2 = HERE / "functions" / "bank.json"
    for out in (out1, out2):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(bank, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"OK: {len(items)} mục (bỏ qua {skipped}) -> {out1} & {out2}")
    # vài mẫu để soát mắt
    for x in items[:3]:
        print(" ", x["id"], x["w"], f'({x["r"]})', "=", x["m"][:60])


if __name__ == "__main__":
    main()
