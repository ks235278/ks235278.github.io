# -*- coding: utf-8 -*-
"""Bổ sung từ vựng TỰ SINH vào bank tango (ngoài phần trích từ n1-quiz DATA).

Nguồn: tools/new_words/*.json — mỗi file là list các mục thô:
  { "w": từ, "r": cách đọc TRỌN CỤM (hiragana), "m": nghĩa VI,
    "jp": định nghĩa JP ngắn, "ex": câu ví dụ CHỨA ĐÚNG w, "exvi": dịch VI }

Script:
  - wf căn theo từng cụm kanji (dùng lại extract_bank._align_parts / ruby_html)
  - ex → furigana toàn câu bằng fugashi; từ đích bọc <span class="targ">wf</span>
    (furigana của từ đích lấy từ wf để khớp chú thích, không tra máy)
  - id = t_ + FNV-1a(w|r) — chuẩn cũ, ổn định
  - chống trùng theo w và theo id với bank hiện có
  - ghi kết quả vào data/extra_bank.json (kho mục bổ sung — extract_bank.py sẽ
    merge lại file này khi re-extract) VÀ nối vào data/bank.json + functions/bank.json

Chạy:  py -3 -X utf8 tools/add_words.py     (từ thư mục tango/)
Sau đó: py -3 -X utf8 tools/gen_audio.py    (sinh MP3 từ + câu ví dụ còn thiếu)
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # .../tango/tools
sys.path.insert(0, str(HERE))
from extract_bank import ruby_html, _align_parts, fnv1a64, HAS_KANJI  # noqa: E402

import fugashi  # noqa: E402
_tagger = fugashi.Tagger()


def kata2hira(s):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def rubyfy(text):
    """Furigana toàn câu theo từng token (từng cụm kanji trong token)."""
    out = []
    for tk in _tagger(text):
        surf = tk.surface
        if not HAS_KANJI.search(surf):
            out.append(surf)
            continue
        rd = kata2hira(tk.feature.kana or surf)
        out.append(_align_parts(surf, rd) or f"<ruby>{surf}<rt>{rd}</rt></ruby>")
    return "".join(out)


def build_item(raw):
    w, r = raw["w"].strip(), raw["r"].strip()
    wf = ruby_html(w, r)
    ex_src = raw.get("ex", "").strip()
    ex = ""
    if ex_src:
        i = ex_src.find(w)
        if i < 0:
            print(f"  !! '{w}' không xuất hiện nguyên văn trong ví dụ — ruby cả câu, không đánh targ")
            ex = rubyfy(ex_src)
        else:
            targ = f'<span class="targ">{wf or w}</span>'
            ex = rubyfy(ex_src[:i]) + targ + rubyfy(ex_src[i + len(w):])
    return {
        "id": "t_" + fnv1a64(f"{w}|{r}"),
        "w": w,
        "r": r,
        **({"wf": wf} if wf else {}),
        "m": raw["m"].strip().rstrip(". "),
        "jp": raw.get("jp", "").strip(),
        "ex": ex,
        "exvi": raw.get("exvi", "").strip(),
        "lv": raw.get("lv", "N1"),
        "src": "gen",   # đánh dấu mục tự sinh (không có trong n1-quiz DATA)
    }


def main():
    tango = HERE.parent
    bank_path = tango / "data" / "bank.json"
    extra_path = tango / "data" / "extra_bank.json"
    bank = json.loads(bank_path.read_text(encoding="utf-8"))
    extra = json.loads(extra_path.read_text(encoding="utf-8")) if extra_path.exists() \
        else {"items": []}
    have_w = {it["w"] for it in bank["items"]}
    have_id = {it["id"] for it in bank["items"]}

    added, skipped = [], 0
    for f in sorted((HERE / "new_words").glob("*.json")):
        for raw in json.loads(f.read_text(encoding="utf-8")):
            it = build_item(raw)
            if it["w"] in have_w or it["id"] in have_id:
                skipped += 1
                continue
            have_w.add(it["w"]); have_id.add(it["id"])
            added.append(it)

    if not added:
        print(f"Không có mục mới (bỏ qua {skipped} trùng).")
        return
    extra["items"].extend(added)
    bank["items"].extend(added)
    bank["count"] = len(bank["items"])
    out = json.dumps(bank, ensure_ascii=False, separators=(",", ":"))
    bank_path.write_text(out, encoding="utf-8")
    (tango / "functions" / "bank.json").write_text(out, encoding="utf-8")
    extra_path.write_text(json.dumps(extra, ensure_ascii=False, separators=(",", ":")),
                          encoding="utf-8")
    print(f"Thêm {len(added)} mục (bỏ {skipped} trùng) → bank giờ {bank['count']} mục.")
    for it in added[:3]:
        print(" ", it["id"], it["w"], f'({it["r"]})')
        print("   ex:", it["ex"][:150])


if __name__ == "__main__":
    main()
