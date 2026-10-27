/**
 * 助记文件校验（数据门禁的一部分，也可单独跑）。
 *
 * 判据：
 *   1. 每条都有 kind + certainty + 实质内容（≥30 字）
 *   2. kind / certainty 都在受支持的那几种里
 *   3. 助记里的词首必须真实存在于词库（防止打错字/写错词）
 *   4. 不许出现与已修正数据矛盾的措辞（「书里只收了…」在 entry_repairs 修好之后就是假话）
 *   5. 不许出现 ASCII 双引号（会破坏 JSON 可读性与后续编辑的字面量匹配）
 *
 * 用法：node tools/validate_tips.mjs [--progress]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TIPS = join(ROOT, "assets", "wordbooks", "tips", "cet6.json");
const WB = join(ROOT, "assets", "wordbooks", "cet6.json");

const KINDS = ["root", "family", "sense", "story", "sound", "image", "usage"];
const CERT = ["high", "medium", "low"];

let pass = 0, fail = 0;
const bad = [];
function check(name, ok, detail = "") {
  ok ? pass++ : fail++;
  if (!ok) bad.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

if (!existsSync(TIPS)) {
  console.error("[FAIL] 助记文件不存在:", TIPS);
  process.exit(2);
}

const doc = JSON.parse(readFileSync(TIPS, "utf8"));
const tips = doc.tips || {};
const keys = Object.keys(tips);
const wb = JSON.parse(readFileSync(WB, "utf8"));
const words = new Set(wb.words.map((w) => w.word));
const fixed = new Set(wb.words.filter((w) => w.entry_fix).map((w) => w.word));

console.log(`助记 ${keys.length} 条 / 词库 ${wb.count} 词\n`);

const tooShort = [], badKind = [], badCert = [], notInBook = [], hasQuote = [], metaTalk = [], corrupted = [], repeated = [];
for (const [w, t] of Object.entries(tips)) {
  if (!t.tip || t.tip.length < 30) tooShort.push(w);
  if (!KINDS.includes(t.kind)) badKind.push(`${w}:${t.kind}`);
  if (!CERT.includes(t.certainty)) badCert.push(`${w}:${t.certainty}`);
  if (!words.has(w)) notInBook.push(w);
  if (/"/.test(t.tip || "")) hasQuote.push(w);
  // U+FFFD 替换字符 = 写入时坏掉的字节（实测踩过一次：「存电荷的器」写成了「存\uFFFD的器」）
  if (/\uFFFD/.test(t.tip || "")) corrupted.push(w);
  // 同一个 tip 里把「X 同族：A / A / B」这种同项连写两遍 = 复制粘贴的疏忽。
  // ⚠️ 只在**确实有「同族：」标记**时才检查 —— 第一版对没有该标记的 tip 也跑，
  //    结果把音标里的斜杠（/rəʊ/ 一排 /rəʊ/ 划船）当成了列表分隔符，row 被假红。
  const m = /同族[^：:]*[：:]([^。]*)/.exec(t.tip || "");
  if (m) {
    const items = m[1].split("/").map((s) => s.trim()).filter(Boolean);
    if (items.length >= 2 && new Set(items).size < items.length) repeated.push(w);
  }
  // 助记只管记忆，「与书不一致」由界面横幅统一提示（entry_repairs + fixNote）。
  // 助记里写「书里只收了 X」有两个毛病：数据补齐后它变成假话；学习者也并不关心版本学。
  //
  // ⚠️ 判据必须锚在**「谈论源书缺陷」的特有句式**上，不能只匹配「书里」两个字。
  //    实测两次假红：① 「法律文*书里*也表示『鉴于』」②「沉浸在*书里*」——
  //    都是「书里」的正常用法，产品与文案都没问题。
  //    所以只抓「书里只收/只给/没有/漏/标成」与「源书/书本」这些真正指向源书的说法。
  if (/(源书|书本)|书里(?:只收|只给|没有|漏|没收录|标成)/.test(t.tip || "")) metaTalk.push(w);
}

const certCount = {};
for (const t of Object.values(tips)) certCount[t.certainty] = (certCount[t.certainty] || 0) + 1;
const kindCount = {};
for (const t of Object.values(tips)) kindCount[t.kind] = (kindCount[t.kind] || 0) + 1;

check("每条都有实质内容（≥30 字）", tooShort.length === 0, tooShort.slice(0, 5).join(", ") || "全部达标");
check("kind 都受支持", badKind.length === 0, badKind.slice(0, 5).join(", ") || JSON.stringify(kindCount));
check("certainty 都受支持", badCert.length === 0, badCert.slice(0, 5).join(", ") || JSON.stringify(certCount));
check("每条的首词都在词库里（没有打错字）", notInBook.length === 0, notInBook.slice(0, 5).join(", ") || "全部命中");
check("助记文本里没有 ASCII 双引号", hasQuote.length === 0, hasQuote.slice(0, 5).join(", ") || "无");
check("助记文本里没有乱码替换字符（U+FFFD）", corrupted.length === 0,
  corrupted.slice(0, 5).join(", ") || "无");
check("同族列表里没有重复项", repeated.length === 0, repeated.slice(0, 5).join(", ") || "无");
check("助记里不谈论源书（出处由界面横幅统一提示）", metaTalk.length === 0,
  metaTalk.slice(0, 5).join(", ") || `已修正的 ${fixed.size} 条都由横幅提示，助记不重复`);
check("确定度三档齐备", Object.keys(certCount).length === 3, JSON.stringify(certCount));

if (process.argv.includes("--progress")) {
  const first300 = wb.words.slice(0, 300).map((w) => w.word);
  const done = first300.filter((w) => w in tips).length;
  console.log("");
  console.log(`前 300 目标覆盖：${done}/300`);
  console.log(`助记总覆盖：${keys.length}/${wb.count}`);
  const miss = wb.words.slice(0, 300).map((w) => w.word).filter((w) => !(w in tips));
  console.log(`前 300 还缺 ${miss.length} 个；下一个是从第 ${300 - miss.length + 1} 个起`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("\n失败项："); for (const b of bad) console.log("  - " + b); }
process.exit(fail ? 1 : 0);
