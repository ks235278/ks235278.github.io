#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Dựng DATA cho N1 quiz từ các file batch quote (kanji/goi/iikae/bunpou) và CÓ
furigana toàn câu trong `qa` (giống bản gốc) — KHÔNG để mất furigana câu đề bài.

- Tách câu tại marker trong `q`: ⟦target⟧ (kanji/iikae) hoặc ＿ (goi/bunpou).
- Sinh furigana cho phần trước/sau bằng fugashi + unidic-lite (đọc theo ngữ cảnh),
  tách okurigana gọn như bản gốc: <ruby>培<rt>つちか</rt></ruby>って.
- Từ mục tiêu (kanji) dùng `r` làm furigana (chuẩn, KHÔNG suy từ tokenizer).
- goi/bunpou giữ ô trống <span class="blank">（　）</span> trong qa (khớp app gốc,
  không lộ đáp án qua audio).
- rt bị CSS ẩn cho tới khi .revealed nên hiện furigana ở câu hỏi không lộ đáp án.

Dùng:
  py -3 tools/build_quotes.py --src "C:/.../Downloads" --apply        # ghi vào index.html
  py -3 tools/build_quotes.py --src "C:/.../Downloads" --dry 6        # in thử, không ghi
"""
import re, json, os, sys, glob, argparse, html
import fugashi

sys.stdout.reconfigure(encoding="utf-8")
_TAGGER = fugashi.Tagger()

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HTML = os.path.join(ROOT, "index.html")
BLANK_SPAN = '<span class="blank">（&nbsp;&nbsp;&nbsp;）</span>'

# ── kana helpers ─────────────────────────────────────────────────────────
def kata2hira(s: str) -> str:
    out = []
    for ch in s:
        o = ord(ch)
        if 0x30A1 <= o <= 0x30F6:          # katakana -> hiragana
            out.append(chr(o - 0x60))
        else:
            out.append(ch)                 # ー, 々, ・, kana sẵn... giữ nguyên
    return "".join(out)

def is_kana(ch: str) -> bool:
    o = ord(ch)
    return (0x3040 <= o <= 0x309F) or (0x30A0 <= o <= 0x30FF) or ch == "ー"

def has_kanji(s: str) -> bool:
    for ch in s:
        o = ord(ch)
        if (0x3400 <= o <= 0x4DBF) or (0x4E00 <= o <= 0x9FFF) or \
           (0xF900 <= o <= 0xFAFF) or ch in "々〆ヶ":
            return True
    return False

def esc(s: str) -> str:
    return html.escape(s, quote=False)

# ── Chuẩn hoá `vn`: nguồn hay rơi dấu ')' -> bù lại cho cân ngoặc ─────────
# Mẫu chuẩn: 「từ」(cách đọc): nghĩa.  (câu vốn đúng được GIỮ NGUYÊN)
def fix_vn(s: str) -> str:
    if not s:
        return s
    # 1) đóng ngoặc cách đọc: 」(kana: -> 」(kana):  (không khớp câu đã có ')')
    s = re.sub(r"」\(([^():：]+?)\s*[:：]\s*", r"」(\1): ", s, count=1)
    # 2) thiếu ')' (ngoặc phụ trong nghĩa) -> chèn ngay trước dấu chấm cuối
    need = s.count("(") - s.count(")")
    if need > 0:
        m = re.search(r"[.。]+\s*$", s)
        s = (s[: m.start()] + ")" * need + s[m.start():]) if m else (s + ")" * need)
    return s

# ── furigana 1 cụm: tách okurigana đầu/cuối, ruby phần lõi kanji ──────────
def furi_token(surface: str, reading_hira: str) -> str:
    if not has_kanji(surface):
        return esc(surface)
    if not reading_hira:
        return esc(surface)                # OOV: không có cách đọc -> để trần
    i = 0
    while i < len(surface) and is_kana(surface[i]):
        i += 1
    j = len(surface)
    while j > i and is_kana(surface[j - 1]):
        j -= 1
    lead, core, trail = surface[:i], surface[i:j], surface[j:]
    r = reading_hira
    if lead and r.startswith(kata2hira(lead)):
        r = r[len(lead):]
    if trail and r.endswith(kata2hira(trail)):
        r = r[: len(r) - len(trail)]
    if not core or not r:                  # phòng lệch -> ruby cả cụm
        return f"<ruby>{esc(surface)}<rt>{esc(reading_hira)}</rt></ruby>"
    return f"{esc(lead)}<ruby>{esc(core)}<rt>{esc(r)}</rt></ruby>{esc(trail)}"

def reading_of(word) -> str:
    f = word.feature
    for attr in ("kana", "pron"):
        v = getattr(f, attr, None)
        if v and v != "*":
            return kata2hira(v)
    return ""

# ── Sửa cách đọc unidic-lite hay sai (kiểm bằng rà tay 535 cặp kanji→đọc) ──
# COMPOUND_FIX: từ ghép bị tokenizer tách/đọc sai -> gộp thành 1 ruby đúng.
COMPOUND_FIX = {
    "既読": "きどく",      # bị đọc き・よみ
    "一日": "いちにち",    # bị đọc ついたち (mùng 1) — ở đây nghĩa "một ngày"
    "給料日": "きゅうりょうび",  # 日 bị đọc にち
    "何気": "なにげ",      # bị đọc なん・げ
    "一曲": "いっきょく",  # bị đọc いち・きょく
}
# TOKEN_FIX: chỉ áp khi tokenizer tách ĐÚNG token đó (an toàn cho từ ghép khác).
TOKEN_FIX = {}
_CF_RE = re.compile("|".join(sorted(map(re.escape, COMPOUND_FIX), key=len, reverse=True))) \
    if COMPOUND_FIX else None

def _furigana_raw(text: str) -> str:
    if not text:
        return ""
    out = []
    for w in _TAGGER(text):
        rd = TOKEN_FIX.get(w.surface) or reading_of(w)
        out.append(furi_token(w.surface, rd))
    return "".join(out)

def furigana(text: str) -> str:
    if not text or not _CF_RE:
        return _furigana_raw(text)
    out, pos = [], 0
    for m in _CF_RE.finditer(text):
        if m.start() > pos:
            out.append(_furigana_raw(text[pos:m.start()]))
        comp = m.group(0)
        out.append(furi_token(comp, COMPOUND_FIX[comp]))
        pos = m.end()
    out.append(_furigana_raw(text[pos:]))
    return "".join(out)

# ── tách prefix/suffix từ q rồi dựng qa ──────────────────────────────────
RE_BOLD = re.compile(r"⟦(.+?)⟧")

def build_qa(it: dict) -> str:
    cat, q = it["cat"], it["q"]
    m = RE_BOLD.search(q)
    if m:                                   # kanji / iikae
        pre, suf = q[: m.start()], q[m.end():]
        label = m.group(1)
        r = it.get("r")
        targ_inner = furi_token(label, kata2hira(r)) if r else esc(label)
        return furigana(pre) + f'<span class="targ">{targ_inner}</span>' + furigana(suf)
    if "＿" in q:                            # goi / bunpou — giữ ô trống
        parts = q.split("＿")
        return BLANK_SPAN.join(furigana(p) for p in parts)
    raise ValueError("q không có marker ⟦⟧ hoặc ＿: " + it["id"])

# ── nạp batch -> list item DATA theo schema app ──────────────────────────
CAT_ORDER = {"kanji": 0, "goi": 1, "iikae": 2, "bunpou": 3}

def load_items(src_dir: str) -> list:
    files = sorted(glob.glob(os.path.join(src_dir, "n1_quiz_batch*_*.json")))
    if not files:
        sys.exit("Không thấy file batch nào trong " + src_dir)
    by_id = {}
    for f in files:
        d = json.load(open(f, encoding="utf-8"))
        for it in d["items"]:
            by_id[it["id"]] = it            # trùng id -> bản sau thắng
    items = list(by_id.values())
    def sort_key(it):
        idn = re.sub(r"\D", "", it["id"])
        return (CAT_ORDER.get(it["cat"], 9), int(idn) if idn else 0)
    items.sort(key=sort_key)
    return items

def to_data(items: list) -> list:
    out = []
    for it in items:
        cat = it["cat"]; opts = it["opts"]
        assert len(opts) == 4, it["id"]
        if it.get("answer") is not None:
            assert opts[0] == it["answer"], (it["id"], "opts0 != answer")
        rec = {"cat": cat, "q": it["q"], "qa": build_qa(it),
               "opts": opts, "vt": it["vt"], "vn": fix_vn(it["vn"]), "jp": it["jp"]}
        if cat == "kanji":
            rec["r"] = it["r"]
        out.append(rec)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="thư mục chứa file batch")
    ap.add_argument("--apply", action="store_true", help="ghi đè DATA trong index.html")
    ap.add_argument("--dry", type=int, default=0, help="in thử N item rồi thoát")
    a = ap.parse_args()

    items = load_items(a.src)
    from collections import Counter
    print(f"Nạp {len(items)} item:", dict(Counter(i['cat'] for i in items)))
    data = to_data(items)

    if a.dry:
        for rec in data[: a.dry] + data[-2:]:
            print("\n===", rec["cat"], "===")
            print(" q :", rec["q"])
            print(" qa:", rec["qa"])
        return

    payload = json.dumps(data, ensure_ascii=False)
    src = open(HTML, encoding="utf-8").read()
    m = re.search(r"const DATA = (\[.*?\]);", src, re.S)
    assert m, "không thấy const DATA trong index.html"
    new = src[: m.start(1)] + payload + src[m.end(1):]
    m2 = re.search(r"const DATA = (\[.*?\]);", new, re.S)
    assert len(json.loads(m2.group(1))) == len(data)
    if a.apply:
        open(HTML, "w", encoding="utf-8").write(new)
        print(f"ĐÃ ghi {len(data)} câu vào index.html (DATA {len(m.group(1))} -> {len(payload)} ký tự)")
    else:
        print("Chưa ghi (thiếu --apply). DATA mới dài", len(payload), "ký tự.")

if __name__ == "__main__":
    main()
