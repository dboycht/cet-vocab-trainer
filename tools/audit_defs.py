# -*- coding: utf-8 -*-
"""
释义窜入检测：找「某词的释义里，混进了另一个词的主释义」。

背景（实测 3 例，全是源书缺陷，不是提取错）：
    bacterium n.细菌；拳击迷      ← 「拳击迷」是 boxer 的释义
    souvenir  n.纪念品，黄豆      ← 「黄豆」是 soy 的释义
    duke      n.公爵，君主；手    ← 「手」是 hand 的释义

**判据：如果词 A 的释义里出现了一个中文串 T，而 T 恰好是词 B 的唯一/主释义，
并且 A ≠ B —— 那 T 很可能是从 B 那一格窜过来的。**

**实测结果（2026-10-27）**：跑出 7 条候选，**逐条复核全是正常的同义复用，零窜入**：
    germ / dominate / exposition / firmness / fowl / appendix / pattern
    —— 例如 germ「细菌」与 bacterium「细菌」是同义词，不是窜入。
    三处真错（bacterium/souvenir/duke）在跑之前就已修掉，所以抓不到。
这说明规则是**收敛的**（不会动不动报一堆），但也说明它**只在窜入物本身是书中
另一个词的主释义时有效**。

⚠️ 覆盖边界（不要误以为全绿就等于没有窜入）：
   · 只能抓「窜进来的义项本身也是书中某个词的主释义」的情形；
   · 若窜入的是书中没有单独成词的词，抓不到；
   · 因此本工具输出是**线索**，不是判决 —— 每条都要人工确认。

用法：
  python tools/audit_defs.py           # 打印候选
  python tools/audit_defs.py --count   # 只要统计
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WB = os.path.join(ROOT, "assets", "wordbooks", "cet6.json")

# 拆分释义里的中文义项：去掉词性标记，再按 ；，、 切
POS_RE = re.compile(r"\b(?:n|v|vt|vi|a|ad|prep|conj|pron|num|int|art)\.", re.I)
SPLIT_RE = re.compile(r"[；;，,、|]")


def senses(defn: str) -> list[str]:
    s = POS_RE.sub("", defn)
    return [x.strip() for x in SPLIT_RE.split(s) if x.strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", action="store_true")
    args = ap.parse_args()

    wb = json.load(open(WB, encoding="utf-8"))
    words = wb["words"]

    # 建索引：某个中文串 → 哪些词「只有这一个义项」且就是它
    sole = {}
    for e in words:
        ss = senses(e["def"])
        if len(ss) == 1 and len(ss[0]) >= 2:
            sole.setdefault(ss[0], []).append(e["word"])

    cands = []
    for e in words:
        ss = senses(e["def"])
        if len(ss) < 2:
            continue
        for i, s in enumerate(ss):
            # 窜入的通常是最后一项，这里不预设位置，全部看
            others = [w for w in sole.get(s, []) if w != e["word"]]
            if not others:
                continue
            # 如果这个词自己也有同名义项，那不算可疑
            cands.append((e["word"], s, others, e["def"]))

    if args.count:
        print(f"候选 {len(cands)} 条（其中大部分是正常的同义复用，需人工判断）")
        return 0

    print(f"# 释义窜入候选 {len(cands)} 条")
    print("# 判读：A 的释义里出现了「只有 B 才有的主释义」→ T 可能是从 B 窜过来的")
    for w, s, others, defn in cands:
        print(f"  {w:<16} 可疑义项「{s}」↔ {','.join(others):<14} {defn[:46]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
