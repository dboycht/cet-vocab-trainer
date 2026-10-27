# -*- coding: utf-8 -*-
"""
阶段 1：从「大学英语六级词汇乱序版.pdf」中做几何提取（不做语义清洗）。

为什么不用 page.get_text() 直接抓：
  PDF 每一页都铺了「新东方国际教育」的旋转水印（KaiTi 字体、每页 7 段、约 100×100pt），
  它的笔画会落进表格格子里，混进词条文本（实测会把 `教`/`际`/`国` 塞进词条）。
  ⇒ 唯一可靠的判据是**字体**：真内容只有 BookmanOldStyle（英文）与 SimSun（中文），
     水印只有 KaiTi。所以这里按 span 级字体过滤，再把 span 归位到表格格子里。

输出：.tmp/raw_cells.json —— 每页每格的原始文本（未清洗），供 build_wordbook.py 消费。

用法：python tools/extract_pdf.py [--pdf <path>] [--out <path>]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

try:
    import pymupdf
except ImportError:  # pragma: no cover
    import fitz as pymupdf  # type: ignore

DEFAULT_PDF = r"C:\Users\micak\Downloads\大学英语六级词汇乱序版.pdf"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(ROOT, ".tmp", "raw_cells.json")

CONTENT_FONTS = ("BookmanOldStyle", "SimSun")  # 真内容字体（水印 KaiTi 被排除在外）
WATERMARK_FONTS = ("KaiTi",)


def is_content_font(font: str) -> bool:
    if any(w in font for w in WATERMARK_FONTS):
        return False
    return any(c in font for c in CONTENT_FONTS)


def collect_spans(page):
    """按字体取出真内容 span（跳过水印与纯空白）。"""
    out = []
    for b in page.get_text("dict")["blocks"]:
        if b.get("type") != 0:
            continue
        for line in b["lines"]:
            for s in line["spans"]:
                if not s["text"].strip():
                    continue
                if not is_content_font(s["font"]):
                    continue
                out.append({"text": s["text"], "bbox": list(s["bbox"]), "font": s["font"]})
    return out


def assign_to_cells(spans, cell_boxes):
    """把 span 按「中心点落在哪个格子」归位；中心点落在格外时按重叠面积兜底。"""
    grid = {}
    for r, row in enumerate(cell_boxes):
        for c, box in enumerate(row):
            if box is None:
                continue
            grid[(r, c)] = pymupdf.Rect(box)

    buckets = {k: [] for k in grid}
    orphans = []
    for s in spans:
        x0, y0, x1, y1 = s["bbox"]
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        hit = None
        for key, rect in grid.items():
            if rect.x0 - 1 <= cx <= rect.x1 + 1 and rect.y0 - 1 <= cy <= rect.y1 + 1:
                hit = key
                break
        if hit is None:  # 兜底：取重叠面积最大的格子
            best, best_area = None, 0.0
            sr = pymupdf.Rect(x0, y0, x1, y1)
            for key, rect in grid.items():
                inter = sr & rect
                area = inter.get_area() if not inter.is_empty else 0.0
                if area > best_area:
                    best, best_area = key, area
            hit = best
        if hit is None:
            orphans.append(s)
        else:
            buckets[hit].append(s)

    cells = {}
    for (r, c), items in buckets.items():
        cells[(r, c)] = " ".join(s["text"].strip() for s in order_spans(items)).strip()
    return cells, orphans


def order_spans(items, tol: float = 6.0):
    """把一个格子里的 span 排成阅读顺序：先聚类成行，行内再按 x。

    ⚠️ 不能用 `round(cy/4)` 这种固定分桶：SimSun 与 BookmanOldStyle 的基线只差
    0.2pt（实测 398.0 vs 398.2），却会正好跨过桶边界，把中文排到英文前面。
    必须按「与前一行中心距 ≤ tol」做聚类。
    """
    items = sorted(items, key=lambda s: (s["bbox"][1] + s["bbox"][3]) / 2)
    lines: list[tuple[float, list]] = []
    for s in items:
        cy = (s["bbox"][1] + s["bbox"][3]) / 2
        if lines and abs(cy - lines[-1][0]) <= tol:
            lines[-1][1].append(s)
        else:
            lines.append((cy, [s]))
    ordered = []
    for _cy, group in lines:
        ordered.extend(sorted(group, key=lambda s: s["bbox"][0]))
    return ordered


def extract(pdf_path: str) -> dict:
    doc = pymupdf.open(pdf_path)
    pages = []
    for pno, page in enumerate(doc):
        tabs = page.find_tables()
        if not tabs.tables:
            pages.append({"page": pno + 1, "rows": [], "note": "no table found"})
            continue
        table = max(tabs.tables, key=lambda t: (t.bbox[2] - t.bbox[0]) * (t.bbox[3] - t.bbox[1]))
        cell_boxes = [[cell for cell in row.cells] for row in table.rows]
        spans = collect_spans(page)
        cells, orphans = assign_to_cells(spans, cell_boxes)
        ncols = len(cell_boxes[0]) if cell_boxes else 0
        rows = [[cells.get((r, c), "") for c in range(ncols)] for r in range(len(cell_boxes))]
        pages.append({
            "page": pno + 1,
            "bbox": [round(v, 1) for v in table.bbox],
            "rows": rows,
            "orphan_spans": [s["text"] for s in orphans],
        })
    doc.close()
    return {"pdf": pdf_path, "pages": pages}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default=DEFAULT_PDF)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args(argv)

    if not os.path.exists(args.pdf):
        print(f"[FAIL] PDF not found: {args.pdf}", file=sys.stderr)
        return 2

    data = extract(args.pdf)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    cells = [c for p in data["pages"] for r in p["rows"] for c in r]
    nonempty = [c for c in cells if c]
    orphans = [s for p in data["pages"] for s in p.get("orphan_spans", [])]
    print(f"pages        : {len(data['pages'])}")
    print(f"cells        : {len(cells)} (non-empty {len(nonempty)})")
    print(f"orphan spans : {len(orphans)} {orphans[:8]}")
    print(f"written      : {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
