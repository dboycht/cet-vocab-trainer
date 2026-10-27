# -*- coding: utf-8 -*-
"""
离线拼写校验：借 vim 自带的 en 拼写词典（Git for Windows 附带 en.utf-8.spl）判断
每个首词是否是合法英文词，并对可疑词给出候选修正。

为什么用 vim：本机 GitHub 走不通（加速器上游 502），拿不到外部词表；
而 vim 自带完整英文拼写词典，`spellbadword()` / `spellsuggest()` 完全离线可用。

产出：.tmp/spellcheck.tsv  （每行：word \t badword \t 候选(逗号分隔)）
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = os.path.join(ROOT, ".tmp")
WORDBOOK = os.path.join(ROOT, "assets", "wordbooks", "cet6.json")
VIM = r"C:\Program Files\Git\usr\bin\vim.exe"


def main() -> int:
    wb = json.load(open(WORDBOOK, encoding="utf-8"))
    words = [w["word"] for w in wb["words"]]
    words_file = os.path.join(TMP, "headwords.txt")
    with open(words_file, "w", encoding="utf-8") as f:
        f.write("\n".join(words))

    out_tsv = os.path.join(TMP, "spellcheck.tsv").replace("\\", "/")
    words_path = words_file.replace("\\", "/")
    script = f"""set encoding=utf-8
set spelllang=en_us
set spell
let s:words = readfile('{words_path}')
let s:out = []
for s:w in s:words
  let s:bad = spellbadword(s:w)
  let s:sug = spellsuggest(s:w, 8)
  call add(s:out, s:w . "\\t" . s:bad[0] . "\\t" . join(s:sug, ","))
endfor
call writefile(s:out, '{out_tsv}')
qa!
"""
    script_path = os.path.join(TMP, "spellcheck.vim")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(script)

    # ⚠️ 必须用 `-c "source <file>"`：静默 ex 模式（-es）下 `-S <file>` 不会执行脚本，
    # 而且不报任何错，只是退出码 1、产物不存在（实测）。
    r = subprocess.run([VIM, "-es", "-u", "NONE", "-i", "NONE", "-N",
                        "-c", f"source {script_path.replace(chr(92), '/')}", "-c", "qa!"],
                       capture_output=True, text=True, timeout=900)
    print("vim exit:", r.returncode, "stderr:", (r.stderr or "")[:300])
    if not os.path.exists(os.path.join(TMP, "spellcheck.tsv")):
        print("[FAIL] spellcheck.tsv 未生成")
        return 1

    rows = [l.split("\t") for l in open(os.path.join(TMP, "spellcheck.tsv"), encoding="utf-8").read().splitlines() if l]
    bad = [r for r in rows if len(r) >= 2 and r[1]]
    print(f"checked : {len(rows)}")
    print(f"flagged : {len(bad)}")
    for r in bad[:40]:
        print("   %-16s -> %s" % (r[0], r[2][:60] if len(r) > 2 else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
