# -*- coding: utf-8 -*-
"""
阶段 2：把 extract_pdf.py 的原始格子文本清洗成可用词库。

源文件（PDF 本身）的三类缺陷，以及各自的处理方式：

  1. 列错位（可自动修）—— 左格词义的尾巴被排版画到了右格开头。
       实测：左 `block n.阻塞；障碍物；` + 右 `炮闩 damn vt.诅咒 n.诅咒；丝毫`
       真实应为：左 `block n.阻塞；障碍物；炮闩` + 右 `damn vt.诅咒 n.诅咒；丝毫`
       判据：**右格以中文字符开头 ⇒ 这一串中文必然属于左格**（每个词条都以英文首词打头）。

  2. 词条与词性粘连（可自动修）—— `suiciden.&vi.&vt.自杀` / `superba.壮丽的`。
       修法：取**第一个词性标记**的下标作为切分点 —— 之前的英文是首词、之后是释义。

  3. 首词本身损坏（自动修不了，只标记）—— `rmost`(utmost) / `outeintegral`(integral)。
       这类只能靠外部词典交叉校验，本阶段只输出可疑清单。

输出：
  assets/wordbooks/cet6.json   —— 应用直接读的词库
  .tmp/review_needed.json      —— 待词典校验的可疑词条
  .tmp/headwords.txt           —— 全部首词（便于人工通读）
  .tmp/glued.json              —— 粘连切分过的词条（需抽查）

用法：python tools/build_wordbook.py
"""
from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = os.path.join(ROOT, ".tmp")
RAW = os.path.join(TMP, "raw_cells.json")
OUT = os.path.join(ROOT, "assets", "wordbooks", "cet6.json")

CJK = r"\u4e00-\u9fff\u3400-\u4dbf"
FULL_PUNCT = r"\u3000-\u303f\uff00-\uffef"
CJK_OR_PUNCT = f"{CJK}{FULL_PUNCT}"
CJK_RE = re.compile(f"[{CJK}]")
CJK_LEAD_RE = re.compile(f"^[{CJK_OR_PUNCT}]+")
CJK_TAIL_ONLY_RE = re.compile(f"^[{CJK_OR_PUNCT}\\s]+$")

# 词性标记。长度降序排列，保证 `adv.` 不被 `a.` 抢先匹配。
POS_TAGS = ["adv", "adj", "prep", "conj", "pron", "aux", "art", "num", "pref", "suff",
            "int", "vt", "vi", "ad", "n", "v", "a"]
POS_RE = re.compile("|".join(rf"\b{t}\." for t in POS_TAGS[:0]) or r"(?!x)x")
POS_ANY_RE = re.compile(r"(?:" + "|".join(POS_TAGS) + r")\.")
# 源文件偶有词性丢了点（`allowance n 津贴，补助费`），剥掉首词尾部裸露的词性词
BARE_POS_TAIL_RE = re.compile(r"\s+(?:" + "|".join(POS_TAGS) + r")$")
# 「首词里混进中文」或「释义里出现孤立单个字母」= 格子里窜入了相邻格子的碎片
CJK_IN_WORD_RE = re.compile(rf"[{CJK}]")
STRAY_LETTER_RE = re.compile(r"(?<![A-Za-z])[A-Za-z](?![A-Za-z])")
# 合法词形里允许出现括号（书里写作 `onward(s)` / `dynamic(al)`）
WORD_SHAPE_RE = re.compile(r"^[a-z][a-z'\-]*(?:\([a-z]+\))?$")
# 复合词会自然出现 5~6 个连续辅音（offspring / 长词），阈值放到 6 免误报
CONSONANT_RUN_RE = re.compile(r"[bcdfghjklmnpqrstvwxz]{6,}")
POS_SPACED_RE = re.compile(r"\s(?=(?:" + "|".join(POS_TAGS) + r")\.)")


def normalize_spaces(text: str) -> str:
    """PDF 文本层在中英文之间塞了空格（`n. 组织` / `( 举止 )`），按中文排版习惯收掉。"""
    t = text.replace("\u00a0", " ").replace("\u3000", " ")
    t = re.sub(r"\s+", " ", t).strip()
    # 中文（或全角标点）两侧的空格一律去掉
    t = re.sub(rf"\s+(?=[{CJK_OR_PUNCT}])", "", t)
    t = re.sub(rf"(?<=[{CJK_OR_PUNCT}])\s+", "", t)
    # 半角括号内侧的空格
    t = re.sub(r"\(\s+", "(", t)
    t = re.sub(r"\s+\)", ")", t)
    return t.strip()


def parse_entry(text: str):
    """`suiciden.&vi.&vt.自杀` → ('suicide', 'n.&vi.&vt.自杀', glued=True)。

    glued=True 表示首词与词性之间没有空格（源文件丢空格），切分靠推断，需要抽查。
    """
    t = normalize_spaces(text)
    t = CJK_LEAD_RE.sub("", t).strip()  # 残留的中文前缀（列错位未搬净时）
    if not t:
        return None, None, False

    m = POS_ANY_RE.search(t)
    if m and m.start() > 0:
        head = t[:m.start()].strip()
        definition = t[m.start():].strip()
        glued = not t[:m.start()].endswith(" ")
    else:
        # 没有带点的词性标记：按第一个中文字符切，再从首词尾部剥掉裸露的词性词（源文件丢了点）
        j = CJK_RE.search(t)
        if j and j.start() > 0:
            head, definition, glued = t[:j.start()].strip(), t[j.start():].strip(), False
        else:
            return None, None, False
    head = BARE_POS_TAIL_RE.sub("", head).strip(" .,;:，。；：")
    if not head:
        return None, None, False
    return head, definition, glued


def repair_displacement(rows):
    """右格以中文开头 ⇒ 这串中文搬回左格末尾。返回 (修正后的行, 搬运记录)。"""
    fixed, moved = [], []
    for rno, row in enumerate(rows):
        cells = list(row) + [""] * (2 - len(row))
        left, right = cells[0], cells[1]
        m = CJK_LEAD_RE.match(right)
        if m and left.strip():
            frag = m.group(0)
            left = left.rstrip() + frag
            right = right[m.end():].lstrip()
            moved.append({"row": rno, "frag": frag, "to_left": left[-30:]})
        fixed.append([left, right])
    return fixed, moved


def pretty_def(definition: str) -> str:
    """排版微调：词性标记紧跟在中文字符/右括号之后时补一个空格，便于阅读。

    `vt.诅咒n.诅咒；丝毫` → `vt.诅咒 n.诅咒；丝毫`
    ⚠️ 不能碰 `vt.&vi.` 这种由 & 连接的组合。
    """
    t = re.sub(rf"(?<=[^{re.escape('A-Za-z')}\s&])(?=(?:{'|'.join(POS_TAGS)})\.)", " ", definition)
    return re.sub(r"\s{2,}", " ", t).strip()


def validate(word: str, definition: str):
    """不依赖词典的硬性检查：只抓「一定不是英文词条」的形态。"""
    reasons = []
    w = word.lower()
    if not WORD_SHAPE_RE.fullmatch(w):
        reasons.append("charset")
    if not re.search(r"[aeiouy]", w):
        reasons.append("no-vowel")
    if len(w) > 16:
        reasons.append("too-long")
    if len(w) < 2:
        reasons.append("too-short")
    if CONSONANT_RUN_RE.search(w):
        reasons.append("consonant-run")
    # 释义里没有中文 = 这条词义丢了
    if not CJK_IN_WORD_RE.search(definition):
        reasons.append("no-cn-def")
    # 释义里有孤立单字母 = 相邻格子窜入的碎片（`f` / `i`）。
    # ⚠️ 必须先把词性标记剥掉，否则 `n.组织` 里的 `n` 会被误判成碎片。
    body = POS_ANY_RE.sub("", definition)
    if STRAY_LETTER_RE.search(body):
        reasons.append("stray-letter")
    return (not reasons), reasons


def main() -> int:
    if not os.path.exists(RAW):
        print(f"[FAIL] 先跑 tools/extract_pdf.py 生成 {RAW}", file=sys.stderr)
        return 2
    raw = json.load(open(RAW, encoding="utf-8"))

    all_moved, parsed, unparsed = [], [], []
    for page in raw["pages"]:
        fixed, moved = repair_displacement(page["rows"])
        all_moved += [dict(p=page["page"], **m) for m in moved]
        for rno, row in enumerate(fixed):
            for col, text in enumerate(row):
                if not text.strip():
                    continue
                word, definition, glued = parse_entry(text)
                if not word:
                    unparsed.append({"page": page["page"], "row": rno, "col": col, "text": text})
                    continue
                parsed.append({
                    "word": word,
                    "def": definition,
                    "pos": [],
                    "page": page["page"],
                    "_glued": glued,
                    "_ok": True,
                    "_reasons": [],
                    "_src": text,
                })

    seen, unique, dupes = {}, [], []
    for p in parsed:
        k = p["word"].lower()
        if k in seen:
            # 书里对多义词会重复出现（如 mint 造币厂 / 薄荷、clip 剪 / 夹住）。
            # 去重时把第二个义项并进同一条，避免丢词义、也避免同一词在刷词时出现两次。
            prev = seen[k]
            if p["def"] and p["def"] not in prev["def"]:
                prev["def"] = f"{prev['def']} | {p['def']}"
                prev["merged_defs"] = prev.get("merged_defs", 1) + 1
            dupes.append({"word": p["word"], "merged_into": prev["def"]})
            continue
        seen[k] = p
        unique.append(p)

    # 应用人工修复表（源 PDF 首词损坏，判据见 tools/headword_repairs.json）
    # ⚠️ 必须在 validate 之前：否则报告里报的是修复前的形态，掩盖真实状态。
    repairs = json.load(open(os.path.join(HERE, "headword_repairs.json"), encoding="utf-8"))["repairs"]
    applied = []
    for p in unique:
        fix = repairs.get(p["word"])
        if not fix:
            continue
        raw_word = p["word"]
        p["word"] = fix["word"]
        p["source_word"] = raw_word  # 保留原始拼写，便于回溯
        if fix.get("def"):
            p["def"] = fix["def"]
        if fix.get("confidence"):
            p["repair_confidence"] = fix["confidence"]
        applied.append({"from": raw_word, "to": fix["word"], "confidence": fix.get("confidence", "exact")})

    # 词条修正表（源书词性标错 / 漏收常用义项；判据见 tools/entry_repairs.json）
    # 同样必须走表 —— 直接手改 cet6.json 会在下次重跑 PDF 提取时被冲掉。
    entry_repairs_path = os.path.join(HERE, "entry_repairs.json")
    entry_applied = []
    if os.path.exists(entry_repairs_path):
        er = json.load(open(entry_repairs_path, encoding="utf-8"))["repairs"]
        for p in unique:
            fix = er.get(p["word"])
            if not fix:
                continue
            was = {"pos": list(p["pos"]), "def": p["def"]}
            if fix.get("def"):
                p["def"] = fix["def"]
            if fix.get("pos"):
                p["pos"] = list(fix["pos"])
            p["source_def"] = was["def"]        # 保留书本原释义，便于回溯
            p["source_pos"] = was["pos"]
            p["entry_fix"] = fix["kind"]
            entry_applied.append({"word": p["word"], "kind": fix["kind"], "was": was,
                                  "now": {"pos": p["pos"], "def": p["def"]}})

    # 修复之后再定稿：排版微调 + 词性 + 形态校验
    for p in unique:
        p["def"] = pretty_def(p["def"])
        # 走表的条目的 pos 以表为准（书里的词性标错过，不能再从释义里反推）
        if not p.get("entry_fix"):
            p["pos"] = list(dict.fromkeys(POS_ANY_RE.findall(p["def"])))
        p["_ok"], p["_reasons"] = validate(p["word"], p["def"])

    review = [p for p in unique if not p["_ok"]]
    glued = [p for p in unique if p["_glued"]]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    book = {
        "id": "cet6",
        "name": "大学英语六级词汇（乱序版）",
        "source": os.path.basename(raw["pdf"]),
        "count": len(unique),
        "words": [{k: v for k, v in p.items() if not k.startswith("_")} for p in unique],
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(book, f, ensure_ascii=False, indent=1)

    # 词库清单（多词库架构的入口）：按 id 更新，保留其它词库条目
    manifest_path = os.path.join(os.path.dirname(OUT), "index.json")
    manifest = {"wordbooks": []}
    if os.path.exists(manifest_path):
        try:
            manifest = json.load(open(manifest_path, encoding="utf-8"))
        except Exception:
            pass
    entry = {
        "id": book["id"], "name": book["name"], "file": os.path.basename(OUT),
        "count": book["count"], "source": book["source"],
        "builtAt": __import__("datetime").date.today().isoformat(),
    }
    books = [b for b in manifest.get("wordbooks", []) if b.get("id") != book["id"]]
    books.append(entry)
    manifest["wordbooks"] = sorted(books, key=lambda b: b.get("id", ""))
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)

    def dump(name, obj):
        with open(os.path.join(TMP, name), "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=1)

    dump("review_needed.json", review)
    dump("glued.json", glued)
    dump("displaced.json", all_moved)
    dump("duplicates.json", dupes)
    dump("repairs_applied.json", applied)
    dump("entry_repairs_applied.json", entry_applied)
    with open(os.path.join(TMP, "headwords.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(p["word"] for p in unique))

    print(f"格子条目        : {len(parsed)}")
    print(f"列错位搬运      : {len(all_moved)}")
    print(f"解析失败        : {len(unparsed)}")
    print(f"去重后唯一词    : {len(unique)}   (合并重复义项 {len(dupes)})")
    print(f"首词修复        : {len(applied)}")
    print(f"词条修正        : {len(entry_applied)}  (词性/义项，见表 entry_repairs.json)")
    print(f"形态即可疑      : {len(review)}")
    print(f"粘连切分待抽查  : {len(glued)}")
    if unparsed:
        print("--- 解析失败样例 ---")
        for e in unparsed[:8]:
            print("   ", repr(e["text"])[:110])
    if glued:
        print("--- 粘连切分样例 ---")
        for p in glued[:8]:
            print(f"    {p['word']!r:16s} <- {p['_src'][:60]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
