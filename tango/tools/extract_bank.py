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
KANJI_RUN = re.compile(r"[一-鿿々〆ヶ]+|[^一-鿿々〆ヶ]+")
HAS_KANJI = re.compile(r"[一-鿿々〆ヶ]")

_tagger = None
def fugashi_reading(text):
    """Reading hiragana của một cụm kanji, tra bằng fugashi/unidic-lite."""
    global _tagger
    if _tagger is None:
        import fugashi
        _tagger = fugashi.Tagger()
    kata = "".join((w.feature.kana or w.surface) for w in _tagger(text))
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in kata)


def _align_parts(word, reading):
    """Căn chỉnh reading với surface: cụm kana giữ nguyên làm mốc, cụm kanji ăn phần reading ở giữa."""
    parts = [(m.group(0), bool(HAS_KANJI.match(m.group(0)[0]))) for m in KANJI_RUN.finditer(word)]
    pat = "".join(f"(?P<k{i}>.+?)" if isk else re.escape(s) for i, (s, isk) in enumerate(parts))
    m = re.fullmatch(pat, reading)
    if m:
        return "".join(f"<ruby>{s}<rt>{m.group(f'k{i}')}</rt></ruby>" if isk else s
                       for i, (s, isk) in enumerate(parts))
    kruns = [i for i, (_, isk) in enumerate(parts) if isk]
    if len(kruns) == 1:
        # reading chỉ chú cho lõi kanji duy nhất — nhưng nhiều khi ôm luôn cả
        # okurigana theo sau (「歯止めをかける」(はどめ): はど là của 歯止,
        # め là okurigana). Cắt phần đuôi reading trùng với đầu cụm kana sau.
        j = kruns[0]
        pre = "".join(s for s, _ in parts[:j])
        post = "".join(s for s, _ in parts[j + 1:])
        core = reading
        if pre and core.startswith(pre):
            core = core[len(pre):]
        rt = core
        for L in range(min(len(core) - 1, len(post)), 0, -1):
            if core.endswith(post[:L]):
                rt = core[:len(core) - L]
                break
        if rt:
            return pre + f"<ruby>{parts[j][0]}<rt>{rt}</rt></ruby>" + post
    return None


def ruby_html(word, reading):
    """HTML furigana theo TỪNG CỤM KANJI (không phủ cả cụm lên toàn từ).

    1. Căn chỉnh reading toàn phần / reading-lõi với surface.
    2. Bó tay mới tra fugashi — nhưng tra theo CẢ TỪ (đúng ngữ cảnh) rồi
       căn chỉnh lại trong từng token, không tra rời từng khối kanji.
    """
    if word == reading or not HAS_KANJI.search(word):
        return None  # thuần kana: không cần furigana
    html = _align_parts(word, reading)
    if html:
        return html
    global _tagger
    if _tagger is None:
        import fugashi
        _tagger = fugashi.Tagger()
    out = []
    for tk in _tagger(word):
        surf = tk.surface
        if not HAS_KANJI.search(surf):
            out.append(surf)
            continue
        kata = tk.feature.kana or surf
        rd = "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in kata)
        out.append(_align_parts(surf, rd) or f"<ruby>{surf}<rt>{rd}</rt></ruby>")
    return "".join(out)


RUBY_RT = re.compile(r"<ruby>(?:.*?)<rt>(.*?)</rt></ruby>", re.S)
TAG = re.compile(r"<.*?>")

def full_reading(word, reading, wf):
    """Cách đọc TRỌN CỤM. Chú thích gốc nhiều khi chỉ đọc lõi kanji đầu
    (「後手に回る」(ごて)) — suy ngược từ wf để r luôn khớp furigana hiển thị."""
    if not HAS_KANJI.search(word):
        return word
    if wf:
        return TAG.sub("", RUBY_RT.sub(lambda m: m.group(1), wf))
    return reading


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
        if not reading:
            # ghi chú gốc không kèm cách đọc: thuần kana thì đọc là chính nó,
            # có kanji thì suy cách đọc bằng fugashi (tra theo cả từ)
            reading = fugashi_reading(word) if HAS_KANJI.search(word) else word
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

        wf = ruby_html(word, reading)
        # id giữ nguyên theo key gốc (word|reading chú thích) — KHÔNG đổi khi
        # mở rộng r, để tiến độ học & servedIds & tên file audio không vỡ.
        items.append({
            "id": "t_" + fnv1a64(key),
            "w": word,
            "r": full_reading(word, reading, wf),
            **({"wf": wf} if wf else {}),
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
