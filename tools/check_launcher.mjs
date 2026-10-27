/**
 * 启动器门禁 —— 校验「用户双击的那个 .bat」真的能跑。
 *
 * 为什么单独一条 Gate：`.bat` 是本项目**唯一的用户入口**，而它的两种坏法
 * 都不会在开发时暴露（我们总是用 node 直接起服务）：
 *   1. **LF-only 换行** ⇒ cmd 按行解析崩（注释被当命令、分支走错、程序从未启动）
 *   2. **含非 ASCII** ⇒ cmd 默认按 ANSI(GBK) 读文件，UTF-8 中文变乱码、
 *      注释里的字被当成命令
 * 判据 = 纯 ASCII（每个字节 ≤ 0x7F）+ 全 CRLF（孤立 LF 计数为 0）+ 无 BOM。
 *
 * 用法：
 *   node tools/check_launcher.mjs          # 只检查
 *   node tools/check_launcher.mjs --fix    # 就地修成 CRLF（只做换行归一，不动内容）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FIX = process.argv.includes("--fix");

/** 项目里的所有 .bat 都要过这一关 */
const LAUNCHERS = ["启动.bat"];

let pass = 0, fail = 0;
for (const name of LAUNCHERS) {
  const p = join(ROOT, name);
  console.log(`\n${name}`);

  if (!existsSync(p)) {
    console.log("  FAIL  文件不存在");
    fail++;
    continue;
  }

  let buf = readFileSync(p);
  let text = buf.toString("latin1");

  if (FIX) {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
    if (normalized !== text) {
      writeFileSync(p, Buffer.from(normalized, "latin1"));
      console.log("  FIX   已把换行归一为 CRLF");
      buf = readFileSync(p);
      text = buf.toString("latin1");
    }
  }

  const checks = [];
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  checks.push(["无 BOM", !bom, bom ? "文件以 EF BB BF 开头" : "无 BOM"]);

  const nonAscii = [...buf].filter((b) => b > 0x7f);
  checks.push(["纯 ASCII（字节 ≤ 0x7F）", nonAscii.length === 0,
    nonAscii.length ? `${nonAscii.length} 个非 ASCII 字节，首个 0x${nonAscii[0].toString(16)}` : "0 个"]);

  const loneLf = (text.match(/(?<!\r)\n/g) || []).length;
  checks.push(["全 CRLF（孤立 LF 为 0）", loneLf === 0,
    loneLf ? `${loneLf} 个孤立 LF —— cmd 会解析崩` : "0 个孤立 LF"]);

  const hasNodeGuard = /where node/i.test(text);
  checks.push(["有 node 缺失时的提示分支", hasNodeGuard, hasNodeGuard ? "有" : "没有（用户没装 Node 会看到乱码报错）"]);

  const startsWithEchoOff = /^@echo off/im.test(text);
  checks.push(["以 @echo off 开头（不回显命令）", startsWithEchoOff, startsWithEchoOff ? "是" : "否"]);

  const callsServer = /node\s+server\.mjs/.test(text);
  checks.push(["真的去起 server.mjs", callsServer, callsServer ? "是" : "否"]);

  for (const [n, ok, d] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}  — ${d}`);
    ok ? pass++ : fail++;
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail && !FIX) console.log("提示：node tools/check_launcher.mjs --fix 可自动修换行（非 ASCII 需人工改）");
process.exit(fail ? 1 : 0);
