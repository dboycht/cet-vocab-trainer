# -*- coding: utf-8 -*-
"""
按词库顺序列出词条，供人工/代理写助记用。

用法：
  python tools/list_words.py 1 100        # 第 1~100 个（含两端，1 起数）
  python tools/list_words.py 1 300 --plain  # 只输出首词，每行一个
  python tools/list_words.py --todo       # 列出「还没有助记」的前 N 个
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WB = os.path.join(ROOT, "assets", "wordbooks", "cet6.json")
TIPS = os.path.join(ROOT, "assets", "wordbooks", "tips", "cet6.json")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("start", nargs="?", type=int, default=1)
    ap.add_argument("end", nargs="?", type=int, default=50)
    ap.add_argument("--plain", action="store_true", help="只输出首词")
    ap.add_argument("--todo", action="store_true", help="列出前 end 个里还没有助记的词")
    args = ap.parse_args()

    wb = json.load(open(WB, encoding="utf-8"))
    words = wb["words"]
    have = set()
    if os.path.exists(TIPS):
        have = set(json.load(open(TIPS, encoding="utf-8")).get("tips", {}).keys())

    lo, hi = args.start - 1, min(args.end, len(words))
    rows = words[lo:hi]
    if args.todo:
        rows = [w for w in rows if w["word"] not in have]

    if args.plain:
        print("\n".join(w["word"] for w in rows))
        return 0

    print(f"# 词库顺序 第 {args.start}~{args.end} 个（共 {len(words)}）· 已有助记 {len(have)} 条")
    for i, w in enumerate(rows, start=args.start):
        mark = "✓" if w["word"] in have else " "
        pos = "/".join(w.get("pos") or [])
        print(f"{mark} {i:4d}  {w['word']:<18}{pos:<10}{w['def']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
