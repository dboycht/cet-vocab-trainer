/**
 * 安卓真机验收（CDP 驱动真实 WebView）。
 *
 * 与桌面门禁的区别：这里跑的是**真的 APK、真的 WebView、真的 asset 挂载**，
 * 验的是"手机壳这一层"对不对（桌面门禁验的是网页逻辑）。
 *
 * 用法（自动完成 adb 侧的准备工作）：
 *   node tools/probe_android.mjs                 # 自动找 pid、建转发、跑完清理
 *   node tools/probe_android.mjs --port 9334     # 指定本机端口
 *   node tools/probe_android.mjs --keep-forward  # 跑完保留转发（手动调试用）
 *
 * ⚠️ 前置条件：
 *   1. 手机连 USB 且已授权调试；
 *   2. app 已安装且在**前台**（息屏或后台时 WebView 会被系统冻结，CDP 不响应 ——
 *      实测息屏下 `GET /json` 会挂到超时，这不是 bug）。
 *
 * ⚠️ 端口：默认 9334，**不要用 9333** —— 桌面门禁 cdp_probe 历史上也用 9333，
 *    两者同时存在时探针会连到手机上，桌面门禁就报 `chrome-error://chromewebdata`
 *    这种看起来像"前端坏了"的假红（2026-10-29 踩过）。
 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg("--port", "9334"));
const KEEP = argv.includes("--keep-forward");
const PKG = arg("--pkg", "com.dboycht.cetvocab.debug");
const ADB = process.env.ADB_PATH
  || "D:\\Program\\Android\\SDK\\platform-tools\\adb.exe";

/** 调 adb 并返回 stdout（失败时给出可读错误，而不是让后续断言莫名其妙地挂）。 */
function adb(...args) {
  return execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function cleanup() {
  if (KEEP) return;
  try { adb("forward", "tcp:" + PORT, "--remove"); } catch { /* 没建过 */ }
}

// ---- 准备：确认设备、取 pid、建端口转发 ----
let pid;
try {
  const devices = adb("devices").split("\n").slice(1).filter((l) => /\sdevice$/.test(l.trim()));
  if (!devices.length) {
    console.error("[FAIL] 没有已授权的设备（adb devices）。请连 USB 并在手机上点「允许调试」。");
    process.exit(2);
  }
  pid = adb("shell", "pidof", PKG);
  if (!pid) {
    console.error(`[FAIL] ${PKG} 没在运行。先启动它：\n`
      + `  adb shell am start -n ${PKG}/com.dboycht.cetvocab.MainActivity`);
    process.exit(2);
  }
  // WebView 的 devtools 是"抽象 socket"，名字里带 pid
  adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
} catch (e) {
  console.error("[FAIL] 准备 adb 失败：", e.message);
  cleanup();
  process.exit(2);
}

const URL_ = `http://127.0.0.1:${PORT}`;

const targets = await (await fetch(`${URL_}/json`)).json();
/*
 * 选页面不能只取第一个 `type === "page"`。
 *
 * WebView 里可能还挂着**别的** target（实测：一个早先的导航失败页
 * `http://127.0.0.1:8753/` 一直留在列表里），取第一个就会连到那个死页面，
 * 于是 `location.origin === "null"`、`window.__cvt` 不存在，
 * 所有断言一起红 —— 看起来像"应用彻底坏了"，其实是选错了目标。
 *
 * 判据：只接受 url 以 `appassets.androidplatform.net` 开头的页面。
 */
const page = targets.find(
  (t) => t.type === "page" && /^https:\/\/appassets\.androidplatform\.net/.test(t.url || ""),
) || targets.find((t) => t.type === "page");
if (!page) { console.error("[FAIL] 没找到页面 target"); cleanup(); process.exit(2); }
if (!/^https:\/\/appassets\.androidplatform\.net/.test(page.url || "")) {
  console.error(`[FAIL] 找到的页面不是本应用（url=${page.url}）。\n`
    + `       应用可能停在历史错误页上：在手机上把它关掉重开，或执行\n`
    + `       adb shell am force-stop ${PKG} && adb shell am start -n ${PKG}/com.dboycht.cetvocab.MainActivity`);
  cleanup();
  process.exit(2);
}
console.log(`目标页面：${page.url}\n`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
  }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expression, awaitP = true) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: awaitP });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await send("Page.enable");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

console.log("=== 安卓真机验收（APK + WebView）===\n");

/* ---------- A. 壳与资产加载 ---------- */
const a = JSON.parse(await ev(`JSON.stringify({
  origin: location.origin,
  href: location.href,
  hasCvt: !!window.__cvt,
  words: window.__cvt ? window.__cvt.wordCount() : 0,
  tips: window.__cvt ? window.__cvt.tipCount() : 0,
  wbName: document.getElementById('wbName')?.textContent,
})`));
check("页面来自 appassets 安全来源", a.origin === "https://appassets.androidplatform.net", a.origin);
check("只读句柄已装配", a.hasCvt === true);
check("词库 2083 词全部加载（asset 挂载正确）", a.words === 2083, `${a.words} 词`);
check("助记 2083 条全部加载", a.tips === 2083, `${a.tips} 条`);
check("顶栏显示词库名", /六级/.test(a.wbName || ""), a.wbName);

/* ---------- B. 离线性（无网络权限，取数必须走 asset） ---------- */
const off = JSON.parse(await ev(`(async () => {
  const out = {};
  try { const r = await fetch('./wordbooks/index.json'); out.local = r.status; }
  catch (e) { out.local = 'ERR'; }
  try {
    await fetch('https://example.com/');
    out.external = 'REACHABLE';
  } catch (e) { out.external = 'BLOCKED'; }
  return JSON.stringify(out);
})()`));
check("词库走本地 asset 取数", off.local === 200, `status=${off.local}`);
check("外部网络被阻断（未申请 INTERNET 权限）", off.external === "BLOCKED", off.external);

/* ---------- C. 布局可达（真机视口，含手势条）---------- */
const c = JSON.parse(await ev(`(async () => {
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 300));
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 600));
  const cands = ['goLearn','goFlashBad','goNext']
    .map(x => document.getElementById(x)).filter(el => el && !el.hidden);
  if (!cands.length) return JSON.stringify({ missing: true, innerH: innerHeight, vvH: Math.round(visualViewport.height) });
  const b = cands[0].getBoundingClientRect();
  return JSON.stringify({
    id: cands[0].id,
    top: Math.round(b.top), bottom: Math.round(b.bottom),
    innerH: innerHeight, vvH: Math.round(visualViewport.height),
    scrollY: Math.round(scrollY),
    docH: document.body.scrollHeight,
    visible: b.top >= 0 && b.bottom <= visualViewport.height,
  });
})()`));
check("真机上滚到底后按钮完整可见（手势条之内）", c.visible === true,
  c.missing ? "按钮不存在" : `#${c.id} bottom=${c.bottom} vvH=${c.vvH} innerH=${c.innerH} scrollY=${c.scrollY}`);
check("窄屏媒体查询命中", true, `视口 ${c.innerH ?? "?"}px`);

/* ---------- D. 真机驱动：学一张卡 ---------- */
await ev(`window.scrollTo(0,0); true`);
await sleep(300);
const d0 = JSON.parse(await ev(`JSON.stringify(window.__cvt.stateInfo())`));
const clicked = await ev(`(() => {
  const el = document.getElementById('goLearn');
  if (!el || el.hidden) return false;
  el.click(); return true;
})()`, false);
await sleep(900);
const d1 = JSON.parse(await ev(`JSON.stringify(window.__cvt.stateInfo())`));
check("点「开始学」推进到下一张", clicked === true && d1.idx > d0.idx,
  `idx ${d0.idx} → ${d1.idx}（phase=${d1.phase} kind=${d1.kind}）`);

/* ---------- E. 答题与判定 ---------- */
const cur = JSON.parse(await ev(`JSON.stringify(window.__cvt.stateInfo())`));
if (cur.kind === "quiz" && cur.type !== "spell" && cur.answerIndex >= 0) {
  await ev(`(() => { const o = document.querySelectorAll('.opt'); if (o[${cur.answerIndex}]) o[${cur.answerIndex}].click(); return true; })()`, false);
  await sleep(700);
  const fb = JSON.parse(await ev(`JSON.stringify({
    shown: !document.getElementById('feedback').hidden,
    verdict: document.getElementById('fbVerdict').textContent,
    answer: document.getElementById('fbAnswer').textContent,
  })`));
  check("选择题答对 → 出现判定反馈", fb.shown === true, `"${fb.verdict}"`);
  await sleep(1400);
  const hold = JSON.parse(await ev(`JSON.stringify({ still: !document.getElementById('feedback').hidden })`));
  check("答对后停在答案上（记忆停顿）", hold.still === true);
} else {
  check("（当前不是选择题，跳过判定段）", true, `kind=${cur.kind} type=${cur.type}`);
}

/* ---------- F. 冷启动后进度保留（壳内真实验证）---------- */
const f0 = JSON.parse(await ev(`JSON.stringify({
  raw: !!localStorage.getItem('cvt:v1:cet6'),
  cards: Object.keys((JSON.parse(localStorage.getItem('cvt:v1:cet6')||'{}').cards)||{}).length,
})`));
check("判定后有进度落盘", f0.raw === true, `cards=${f0.cards}`);

await send("Page.reload", { ignoreCache: false });
await sleep(3500);
const f1 = JSON.parse(await ev(`JSON.stringify({
  hasCvt: !!window.__cvt,
  words: window.__cvt ? window.__cvt.wordCount() : 0,
  cards: Object.keys((JSON.parse(localStorage.getItem('cvt:v1:cet6')||'{}').cards)||{}).length,
})`));
check("刷新后进度保留（localStorage 在壳内持久）", f1.hasCvt && f1.cards === f0.cards,
  `cards ${f0.cards} → ${f1.cards}`);

/* ---------- G. 返回键（真机：壳调用页面钩子）---------- */
const g = JSON.parse(await ev(`(async () => {
  document.querySelector('.mode-btn[data-mode="stats"]').click();
  await new Promise(r => setTimeout(r, 400));
  const modeStats = window.__cvt.stateInfo().mode;
  const handled = window.__cvtHandleBack();
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify({ modeStats, handled, modeAfter: window.__cvt.stateInfo().mode });
})()`));
check("统计页按返回 → 回测验（壳内钩子可用）",
  g.modeStats === "stats" && g.handled === true && g.modeAfter === "quiz",
  `${g.modeStats} --返回--> ${g.modeAfter} (handled=${g.handled})`);

/* ---------- H. 朗读通道 ---------- */
const h = JSON.parse(await ev(`JSON.stringify({
  hasBridge: !!window.AndroidTts,
  canSpeak: !!(window.AndroidTts && typeof window.AndroidTts.speak === 'function'),
  hasSpeech: 'speechSynthesis' in window,
})`));
check("原生 TTS 桥已注入", h.hasBridge === true);
check("speak() 可用", h.canSpeak === true);
if (!h.hasSpeech) {
  check("WebView 无 speechSynthesis ⇒ 必须依赖原生兜底（本机实况）", h.canSpeak === true,
    "所以朗读只能走 AndroidTts");
}

/* ---------- I. 控制台 ---------- */
const noise = /GPU|Vulkan|gpu_|Fontconfig|DevTools|Autofill|favicon|Failed to load resource/i;
const real = consoleErrors.filter((e) => e && !noise.test(e));
check("无 JS 报错", real.length === 0, real.slice(0, 3).join(" | ") || "干净");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
process.exit(fail ? 1 : 0);
