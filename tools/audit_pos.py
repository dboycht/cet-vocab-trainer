# -*- coding: utf-8 -*-
"""
词性审计：用「后缀 → 词性」的强信号，机械地找出书里标错的词性。

为什么需要它：源词汇书本身有词性标错（实测 `dignity` 标成 a.、`notable` 标成 n.），
而**靠人翻 2083 条是发现不了"少了一条"的** —— 必须有一个能自己跑的检查。
本机拿不到外网词典（连不上 etymonline/wordnet），所以用后缀这条**可自证**的信号。

⚠️ 只用**强信号**后缀，宁可漏报也不误报：`-er/-or` 这类（render/offer/differ 都是动词）
不参与判断；`-ly` 排除 friendly/likely 这类形容词。

用法：
  python tools/audit_pos.py            # 打印候选（人工确认后再进 entry_repairs.json）
  python tools/audit_pos.py --count    # 只打印统计
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WB = os.path.join(ROOT, "assets", "wordbooks", "cet6.json")

# 强信号后缀 → 必须包含的词性
#
# ⚠️ 这份表是**收窄过的**。第一版用了 12 类后缀，跑出 69 条候选而真错只有个位数
# （精确率约 10%）：`-ish` 把 abolish/cherish/perish/establish 全抓了，
# `-ly` 抓了 jelly/monopoly/melancholy/rally，`-ive` 抓了 revive/deprive/conceive，
# `-ance/-ence` 抓了 commence，`-ise` 抓了 merchandise/enterprise。
# **精确率 10% 的检查比没有检查更糟 —— 它会训练人忽略它。**
# 所以只留下"动词/形容词不可能长这样"的后缀，宁可漏报：
SUFFIX_RULES = [
    # 动词绝不以 -tion/-sion 结尾；名词后缀里最干净的一条
    (("tion", "sion"), "n."),
    (("ness",), "n."),
    (("ity",), "n."),          # -ity 名词后缀（quality/charity/ability），几乎无例外
    (("ify", "ize"), "v."),
    (("ous",), "a."),
    (("less", "ful"), "a."),
]
# 明确排除（精确率太低，不参与判断）：
#   -ment  -ance/-ence  -ship/-hood/-ism/-ist  -ive  -able/-ible  -ish  -ic  -ise  -ate  -er/-or
# 以及 -ly（名词 jelly/monopoly/melancholy 与形容词 friendly/likely 都会撞上）

# -ly 单独处理：绝大多数是副词，但下面这些是形容词
LY_ADJ = {
    "friendly", "lovely", "likely", "lively", "lonely", "silly", "daily", "weekly",
    "monthly", "yearly", "early", "costly", "orderly", "elderly", "timely", "deadly",
    "holy", "ugly", "unlikely", "manly", "cowardly", "sickly", "kindly", "scholarly",
}

# 已人工确认的例外（书标得对，是后缀信号误报）——避免每次都要重新判断
KNOWN_OK: set[str] = set()


def implied_pos(word: str) -> str | None:
    w = word.lower()
    for suffixes, pos in SUFFIX_RULES:
        if w.endswith(suffixes):
            return pos
    return None


def satisfied(want: str, pos: set[str]) -> bool:
    """后缀暗示的词性是否已被书本词性覆盖。

    ⚠️ `v.` 必须由 `vt.`/`vi.` 满足 —— 第一版没做这个等价，于是把
    characterize/notify/purify… 这 17 条及物动词全报成了「词性错」（纯误报）。
    """
    if want == "v.":
        return bool(pos & {"v.", "vt.", "vi."})
    return want in pos


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", action="store_true")
    args = ap.parse_args()

    wb = json.load(open(WB, encoding="utf-8"))
    cands = []
    for e in wb["words"]:
        pos = set(e.get("pos") or [])
        want = implied_pos(e["word"])
        if not want or satisfied(want, pos):
            continue
        if e["word"] in KNOWN_OK:
            continue
        # ⚠️ 这条信号的真实含义**不是**「书里词性标错了」，而是
        #    「这个词很可能还有另一个常用词性/义项，而书里只收了一个」。
        #    实测 22 条候选里真正标错的只有 1 条（dignity），其余多是"只收了一个义项"。
        cands.append((e["word"], "/".join(sorted(pos)) or "(无)", want, e["def"]))

    if args.count:
        print(f"候选 {len(cands)} 条（含义：很可能还有书里没收录的常用义项）")
        for k, v in Counter((c[1], c[2]) for c in cands).most_common():
            print(f"  书={k[0]:<10} 后缀暗示={k[1]:<5} {v} 条")
        return 0

    print(f"# 义项完整性候选 {len(cands)} 条（书本只收了其中一个词性/义项）")
    for w, got, want, d in sorted(cands):
        print(f"  {w:<18} 书={got:<10} 还可能是={want:<5} {d[:44]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
