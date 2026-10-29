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
import { execFileSync } from "node:child_process";
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

  /* ---- 关键：git 里存的那份也必须是 CRLF ----
     实测教训（2026-10-29）：工作区文件是 CRLF、门禁全绿，但 **git 索引/HEAD 里存的是
     LF**（418B 工作区 vs 393B blob）。原因是最初 add 时 core.autocrlf=true，
     CR 在**提交时**就被剥掉了；之后 `-text` 让 git 按清洗后的内容比较，
     于是 `git status` 永远显示"干净"，门禁读工作区也永远是 CRLF。
     结果：**任何人 clone 下来拿到的 .bat 都是坏的**，而本机一切正常 ——
     这正是"本机绿、别人坏"的最坏一类缺陷。 */
  const blobCheck = (() => {
    if (!existsSync(join(ROOT, ".git"))) return ["已入库的 blob 也是 CRLF", true, "不在 git 仓库内，跳过"];
    try {
      const rev = ["rev-parse", "--verify", `HEAD:${name}`];
      const path = execFileSync("git", rev, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (!path) return ["已入库的 blob 也是 CRLF", true, "尚未提交过，跳过"];
      const blobBuf = execFileSync("git", ["cat-file", "blob", `HEAD:${name}`], { cwd: ROOT, maxBuffer: 1 << 20 });
      const cr = [...blobBuf].filter((b) => b === 0x0d).length;
      const lf = [...blobBuf].filter((b) => b === 0x0a).length;
      const ok = lf > 0 && cr === lf;
      return ["已入库的 blob 也是 CRLF", ok,
        ok ? `${blobBuf.length}B，${cr} 个 CRLF`
           : `blob 是 LF-only（${blobBuf.length}B，CR=${cr} LF=${lf}）—— clone 下来是坏的`];
    } catch {
      return ["已入库的 blob 也是 CRLF", true, "git 不可用，跳过"];
    }
  })();
  checks.push(blobCheck);

  for (const [n, ok, d] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}  — ${d}`);
    ok ? pass++ : fail++;
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail && !FIX) console.log("提示：node tools/check_launcher.mjs --fix 可自动修换行（非 ASCII 需人工改）");
process.exit(fail ? 1 : 0);
