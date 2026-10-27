/**
 * 词库数据门禁 —— 不需要浏览器，秒级跑完。
 *
 * 判据（任何一条不过就退出码 1）：
 *   1. 词库存在、count 与实际条目数一致
 *   2. 没有重复首词
 *   3. 每条都有首词与释义
 *   4. 首词形态合法（纯字母/连字符/撇号，可带 (s)/(al) 这类括注）
 *   5. 释义里必须有中文（否则等于丢词义）
 *   6. 没有残留的源文件碎片（孤立单字母）与残留水印字符
 *   7. 抽查若干已知修复项，确保修复表没被回退
 *
 * 用法：node tools/check_wordbook.mjs [--file assets/wordbooks/cet6.json]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const ai = argv.indexOf("--file");
const FILE = join(ROOT, ai >= 0 && argv[ai + 1] ? argv[ai + 1] : "assets/wordbooks/cet6.json");

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail = "") {
  ok ? pass++ : fail++;
  if (!ok) fails.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

if (!existsSync(FILE)) {
  console.error(`[FAIL] 词库文件不存在：${FILE}`);
  console.error("       先跑：python tools/extract_pdf.py && python tools/build_wordbook.py");
  process.exit(2);
}

const wb = JSON.parse(readFileSync(FILE, "utf8"));
const words = wb.words || [];

console.log(`词库：${FILE}`);
console.log(`名称：${wb.name}`);
console.log(`来源：${wb.source}`);
console.log("");

check("count 字段与实际条目数一致", wb.count === words.length, `count=${wb.count} actual=${words.length}`);
check("条目数在合理量级（1500~4000）", words.length >= 1500 && words.length <= 4000, `${words.length} 条`);

const seen = new Set();
const dupes = [];
const shape = /^[a-z][a-z'\-]*(?:\([a-z]+\))?$/;
const stray = /(?<![A-Za-z])[A-Za-z](?![A-Za-z])/;
const posTag = /(?:adv|adj|prep|conj|pron|aux|art|num|pref|suff|int|vt|vi|ad|n|v|a)\./g;
const watermark = /新东方|国际教育/;

const badShape = [], noDef = [], noCn = [], strayDef = [], wm = [];
for (const w of words) {
  const key = (w.word || "").toLowerCase();
  if (seen.has(key)) dupes.push(w.word);
  seen.add(key);

  if (!w.word) { noDef.push(String(w.word)); continue; }
  if (!shape.test(key)) badShape.push(w.word);
  if (!w.def || w.def.length < 2) noDef.push(w.word);
  else {
    if (!/[\u4e00-\u9fff]/.test(w.def)) noCn.push(w.word);
    if (stray.test(w.def.replace(posTag, ""))) strayDef.push(`${w.word}:${w.def}`);
  }
  if (watermark.test(w.word) || watermark.test(w.def || "")) wm.push(w.word);
}

check("无重复首词", dupes.length === 0, dupes.slice(0, 5).join(", "));
check("首词形态全部合法", badShape.length === 0, badShape.slice(0, 6).join(", "));
check("每条都有释义", noDef.length === 0, noDef.slice(0, 6).join(", "));
check("每条释义都含中文", noCn.length === 0, noCn.slice(0, 6).join(", "));
check("释义无残留碎片（孤立单字母）", strayDef.length === 0, strayDef.slice(0, 4).join(" | "));
check("无水印残留（新东方/国际教育）", wm.length === 0, wm.slice(0, 5).join(", "));

// 已知修复项：确保 tools/headword_repairs.json 的成果没被回退
const MUST_FIX = ["utmost", "integral", "infinitely", "indefinite", "tile", "watt",
                  "statistics", "mischief", "scout", "instructor"];
const byWord = new Map(words.map((w) => [w.word, w]));
const missing = MUST_FIX.filter((w) => !byWord.has(w));
check("修复表成果仍在词库中", missing.length === 0, missing.join(", "));
const stale = MUST_FIX.map((w) => byWord.get(w)?.source_word).filter(Boolean);
check("保留了原始拼写出处（source_word）", stale.length === MUST_FIX.length,
  `${stale.length}/${MUST_FIX.length} 个修复项带 source_word`);
// 推断出来的那一条必须留痕，不能和「逐字恢复」混为一谈
const inferred = words.filter((w) => w.repair_confidence === "inference");
check("推断类修复有 repair_confidence 标记", inferred.length === 1 && inferred[0].word === "instructor",
  inferred.map((w) => `${w.word}(${w.repair_confidence})`).join(", ") || "无标记");

// 多义词合并应保留两个义项
const mint = byWord.get("mint");
check("多义词合并保留了两个义项", !!mint && mint.def.includes("|"), mint?.def || "缺 mint");

// ---- 词条修正表（tools/entry_repairs.json）的成果不许回退 ----
// 这批修的是「源书词性标错 / 漏收常用义项」，走表由 build_wordbook.py 应用。
// 判据：这些词的 pos 必须含下列项，且带 entry_fix 与 source_def（可回溯书本原文）。
const ENTRY_FIXED = {
  dignity: ["n."], notable: ["a.", "n."], question: ["n.", "vt."],
  over: ["prep.", "ad."], operation: ["n."], platform: ["n."],
  stalk: ["n.", "vt."], second: ["num.", "n.", "vt."], way: ["n."],
  main: ["a.", "n."], workshop: ["n."], check: ["n.", "vt."], doubtless: ["ad.", "a."],
  periodic: ["a."], eternal: ["a."],
};
const entryMissing = [], entryPosBad = [], entryTraceBad = [];
for (const [w, need] of Object.entries(ENTRY_FIXED)) {
  const e = byWord.get(w);
  if (!e) { entryMissing.push(w); continue; }
  if (!need.every((p) => (e.pos || []).includes(p))) entryPosBad.push(`${w}[${(e.pos || []).join("/")}]`);
  if (!e.entry_fix || !e.source_def) entryTraceBad.push(w);
}
check("词条修正表全部生效（抽查 15 条代表性条目）", entryMissing.length === 0 && entryPosBad.length === 0,
  [...entryMissing, ...entryPosBad].join(", ") || "抽查全部生效");
check("被修正的条目留了书本原文（entry_fix + source_def 可回溯）", entryTraceBad.length === 0,
  entryTraceBad.join(", ") || "全部留痕");
// ⚠️ 条数**不写死**：修正表会持续增长，写死数字每加一条就假红（本轮实测踩过）。
// 判据 = 「库里带 entry_fix 的条数 == 修正表里的条数」——同源比较，自己跟着长。
const repairsPath = join(ROOT, "tools", "entry_repairs.json");
const repairTable = existsSync(repairsPath)
  ? JSON.parse(readFileSync(repairsPath, "utf8")).repairs
  : {};
const tableCount = Object.keys(repairTable).filter((k) => !k.startsWith("_")).length;
const entryCount = words.filter((w) => w.entry_fix).length;
check("带 entry_fix 的条目数 == 修正表条数（同源比较）", entryCount === tableCount,
  `库 ${entryCount} / 表 ${tableCount}`);

const withPos = words.filter((w) => (w.pos || []).length).length;
check("绝大多数条目带词性", withPos / words.length > 0.99, `${withPos}/${words.length}`);

const withPage = words.filter((w) => w.page).length;
check("条目带原书页码（可回溯出处）", withPage === words.length, `${withPage}/${words.length}`);

console.log("");
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log("\n失败项：");
  for (const f of fails) console.log("  - " + f);
}
process.exit(fail ? 1 : 0);
