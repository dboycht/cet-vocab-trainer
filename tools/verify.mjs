/**
 * 一键回归门禁：启动器 Gate + 数据 Gate + 真浏览器端到端 Gate。
 *
 *   node tools/verify.mjs            跑全部
 *   node tools/verify.mjs --data     只跑本地两道（秒级，不需要浏览器）
 *
 * ⭐ 浏览器 Gate 需要的本地服务由**本脚本自己起、自己收**（临时实例，跑完就杀）。
 *    原来是"要求外部先跑 node server.mjs，没起来就 SKIP" —— 结果长驻后台作业
 *    被系统回收后，探针报出的是「Cannot read properties of undefined (reading 'stateInfo')」
 *    这种**误导性的错**（真因是服务没在跑，页面压根没加载）。
 *    判据：**任何 Gate 都不该依赖"某个进程恰好还活着"**。
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const URL_ = process.env.VERIFY_URL || "http://127.0.0.1:8710/";
const PORT = Number(new URL(URL_).port || 8710);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(script, args = []) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [join(HERE, script), ...args], { cwd: ROOT, stdio: "inherit" });
    p.on("close", (code) => done(code ?? 1));
  });
}

async function reachable() {
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

console.log("=".repeat(62));
console.log(" Gate 0/3 · 启动器（用户双击的那个 .bat）");
console.log("=".repeat(62));
const launcherCode = await run("check_launcher.mjs");

console.log("");
console.log("=".repeat(62));
console.log(" Gate 1/3 · 词库数据完整性 + 助记文件校验");
console.log("=".repeat(62));
const dataCode = await run("check_wordbook.mjs");
const tipsCode = await run("validate_tips.mjs");

if (process.argv.includes("--data")) {
  console.log(`\n本地 Gate：启动器 ${launcherCode === 0 ? "✅" : "❌"} · 数据 ${dataCode === 0 ? "✅" : "❌"} · 助记 ${tipsCode === 0 ? "✅" : "❌"}`);
  process.exit(launcherCode || dataCode || tipsCode ? 1 : 0);
}

console.log("");
console.log("=".repeat(62));
console.log(" Gate 2/3 · 真浏览器端到端");
console.log("=".repeat(62));

/* ---- 自己准备服务：已在跑就复用，没在跑就起临时实例 ---- */
let owned = null;
if (await reachable()) {
  console.log(`  复用已在运行的本地服务：${URL_}`);
} else {
  console.log(`  本地服务没在跑，临时起一个实例（端口 ${PORT}），跑完自动关闭`);
  owned = spawn(process.execPath, [join(ROOT, "server.mjs"), "--port", String(PORT), "--no-open"],
    { cwd: ROOT, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (await reachable()) { up = true; break; }
  }
  if (!up) {
    try { owned.kill(); } catch { /* 已经退了 */ }
    console.error(`\n[FAIL] 临时服务起不来（端口 ${PORT}）。手动排查：node server.mjs --port ${PORT}`);
    process.exit(1);
  }
  console.log("  临时服务就绪");
}

let webCode = 1;
try {
  webCode = await run("cdp_probe.mjs", ["--url", URL_]);
} finally {
  if (owned) {
    owned.kill();
    console.log("  临时服务已关闭");
  }
}

console.log("");
console.log("=".repeat(62));
console.log(` 汇总：启动器 ${launcherCode === 0 ? "✅" : "❌"} · 数据 ${dataCode === 0 ? "✅" : "❌"} · 助记 ${tipsCode === 0 ? "✅" : "❌"} · 浏览器 ${webCode === 0 ? "✅" : "❌"}`);
console.log("=".repeat(62));
process.exit(launcherCode || dataCode || tipsCode || webCode ? 1 : 0);
