/**
 * 把 packaging/ 下的 .bat 规范成 CRLF。
 *
 * 为什么必须单独做：工作区规则（memory/11）实测过 —— `.bat` 里若有非 ASCII
 * 内容且换行为 LF-only，cmd 会解析崩（注释当命令执行、set 被截断、变量变空）。
 * 而 git 的 autocrlf 会在提交时把 CRLF 剥掉，所以**工作区是 CRLF 不代表入库的也是**
 * （本项目 ERROR.md E68 就栽在这上面，clone 下来 launcher 是坏的）。
 * 所以：写文件时显式用 \r\n，并用门禁校验 HEAD blob 也是 CRLF。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packaging");

let fixed = 0;
for (const f of readdirSync(dir)) {
  if (!f.toLowerCase().endsWith(".bat")) continue;
  const p = join(dir, f);
  const raw = readFileSync(p, "utf8");
  const norm = raw.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  if (norm !== raw) {
    writeFileSync(p, norm, "utf8");
    fixed++;
    console.log(`  转为 CRLF: ${f}`);
  } else {
    console.log(`  已是 CRLF: ${f}`);
  }
}
console.log(`完成，改动 ${fixed} 个文件`);
