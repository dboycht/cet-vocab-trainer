/**
 * 把文本文件统一成 LF（仓库里只存一种换行，避免 git 假 diff）。
 * `启动.bat` **排除在外** —— Windows 的 cmd 要求 CRLF，由 check_launcher.mjs 守护。
 *
 * 用法：node tools/normalize_eol.mjs [--check]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CHECK = process.argv.includes("--check");

const EXTS = new Set([".json", ".mjs", ".js", ".css", ".html", ".md", ".py", ".yml", ".yaml", ".txt"]);
const SKIP_DIRS = new Set([".git", ".tmp", "node_modules", "__pycache__"]);
const KEEP_CRLF = new Set(["启动.bat"]);   // .bat 必须 CRLF

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter((p) => !KEEP_CRLF.has(p.split(/[\\/]/).pop()));
let changed = 0;
for (const p of files) {
  const s = readFileSync(p, "utf8");
  if (!s.includes("\r\n")) continue;
  const fixed = s.replace(/\r\n/g, "\n");
  if (CHECK) {
    console.log("  需要转 LF:", p.replace(ROOT + "\\", ""));
  } else {
    writeFileSync(p, fixed, "utf8");
  }
  changed++;
}
console.log(`${CHECK ? "检查" : "已归一"} ${changed} 个文件（共扫描 ${files.length} 个）`);
process.exit(CHECK && changed ? 1 : 0);
