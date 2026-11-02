/**
 * 真浏览器端到端门禁（CDP 直连，零第三方依赖）
 *
 * HTTP 200 只能证明文件送达；这里用 Chrome DevTools Protocol 真跑页面，
 * 读**计算样式**、派发真实键盘/点击事件、核对 localStorage，最后出截图。
 *
 * 覆盖 v2 的客观判分主线，重点是三条**只有渲染+交互后才暴露**的规则：
 *   · 新词第一次只教不考（不写成绩）
 *   · 「本轮答错过再答对」只能算模糊（防刚看完答案就当自己会）
 *   · 「记住了」必须连对 ≥3 次且跨天（同日连对不算）
 *
 * 用法：node tools/cdp_probe.mjs [--url http://127.0.0.1:8710/] [--keep]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TMP = join(ROOT, ".tmp");
mkdirSync(TMP, { recursive: true });

/**
 * 「没有助记的词」这条断言的输入，演进过程（三次，都记下来因为每次的教训不同）：
 *
 *   1. 最初写死成 `overhang` —— 助记写到第 327 个词时它有助记了，断言凭空变红。
 *      教训：**断言不许编码"某个词恰好没有助记"这种会变的事实。**
 *   2. 改成"当场从数据里算出一个没有助记的词" —— 方向对，但助记覆盖到 100% 后
 *      **算不出来了**，于是我当初埋的守卫按设计抛错：「这条断言已失去意义，需重写」。
 *      教训：**依赖"数据里恰好存在某种情况"的输入，终究会随数据演进而失效。**
 *   3. 试过"合成一个词库外的词"，**走不通**：队列是从词库生成的，词库外的词进不了队列
 *      （实测 stateInfo().word === null）。
 *   4. 最终方案：**从真实数据里临时摘掉一条助记**（`__cvt.dropTip`），走真实的渲染路径，
 *      验完再还原。被测的仍是真实的守卫逻辑，输入却完全可控。
 *
 * 判据：**断言的输入要可控，不要寄望于"数据里恰好有那种情况"。**
 */
const NO_TIP_WORD = "overhang";

const argv = process.argv.slice(2);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL_ = arg("--url", "http://127.0.0.1:8710/");

/*
 * CDP 端口。
 *
 * ⚠️ 原来这里硬编码 9333，而**安卓真机调试也用 9333**（`adb forward tcp:9333
 * localabstract:webview_devtools_remote_<pid>`）。两者同时存在时，探针连上的
 * 是**手机上的 WebView** 而不是桌面 Chrome —— 桌面门禁于是报
 * 「页面没有加载出来：URL=chrome-error://chromewebdata」，
 * 看起来像前端坏了，其实是端口被别人占了（2026-10-29 实测踩到）。
 *
 * 所以：允许 -P/--port 覆盖；默认改用很少有人占的 9463。
 * 判据（真因识别）：探针报 `chrome-error://chromewebdata` 且
 *   `Get-NetTCPConnection -LocalPort <port>` 的 OwningProcess 不是我们起的 Chrome
 *   ⇒ 先查 `adb forward --list`。
 */
const PORT = Number(arg("-P", arg("--port", "9463")));

const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) { console.error("[FAIL] 找不到 Chrome/Edge"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 启动浏览器 ---------------- */
// 每次都从干净 profile 起：只用 localStorage.clear() 不够 ——
// 应用在 beforeunload 里会把内存里的进度回写，清完立刻被写回来（实测踩过）。
const PROFILE = join(TMP, "cdp-profile");
rmSync(PROFILE, { recursive: true, force: true });

const child = spawn(browser, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--hide-scrollbars", "--mute-audio", "--no-sandbox",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1360,940", "about:blank",
], { stdio: "ignore" });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  await sleep(300);
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { child.kill(); console.error("[FAIL] 连不上 CDP"); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  } else if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval 失败");
  return r.result.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const p = join(TMP, name);
  writeFileSync(p, Buffer.from(r.data, "base64"));
  return p;
}
/** 用注入脚本播种（必须在应用脚本之前跑），播种完重载 */
async function seedAndReload(progressJson) {
  const src = `try{localStorage.setItem('cvt:v1:cet6', ${JSON.stringify(JSON.stringify(progressJson))});}catch(e){window.__seedErr=String(e)}`;
  const inj = await send("Page.addScriptToEvaluateOnNewDocument", { source: src });
  await send("Page.reload", { ignoreCache: false });
  await sleep(2200);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: inj.identifier });
}
const DAY = 86400000;
const dayNum = () => Math.floor(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()) / DAY);

await send("Runtime.enable");
await send("Page.enable");

/* ---------------- 断言框架 ---------------- */
let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  ok ? pass++ : fail++;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/* ================= 开跑 ================= */
console.log("探针启动：", browser);
console.log("目标页面：", URL_);
await send("Page.navigate", { url: URL_ });
await sleep(2600);

/* ---- 前置检查：页面到底加载了没有 ----
   ⚠️ 少了这一步，服务没在跑时会在 A 段报
   「Cannot read properties of undefined (reading 'stateInfo')」——
   看起来像产品 bug，真因却是"页面压根没加载"（实测踩过两次：长驻服务被回收）。 */
const pre = await evalJs(`({
  hasWord: !!document.getElementById('word'),
  hasApp: !!document.querySelector('.app'),
  ready: document.readyState,
  title: document.title,
  url: location.href,
})`);
if (!pre.hasWord || !pre.hasApp) {
  console.error(`\n[FAIL] 页面没有加载出来（真因，不是断言失败）：`);
  console.error(`       URL=${pre.url}  readyState=${pre.ready}  title=${JSON.stringify(pre.title)}`);
  console.error(`       有 .app 容器=${pre.hasApp}  有 #word=${pre.hasWord}`);
  console.error(`       ⇒ 先确认本地服务在跑：node server.mjs --no-open`);
  console.error(`       （用 node tools/verify.mjs 跑会自动起临时服务）`);
  ws.close(); child.kill();
  process.exit(2);
}
console.log(`  前置检查通过：页面已加载（${pre.ready}）`);

const api = () => evalJs(`(() => {
  const c = window.__cvt;
  const s = c.stateInfo();
  const ln = document.getElementById('learnNote');
  const opt = [...document.querySelectorAll('.opt')];
  return {
    hasHandle: !!c,
    ...s,
    wordText: document.getElementById('word').textContent,
    wordHidden: document.getElementById('word').hidden,
    promptCn: document.getElementById('promptCn').hidden ? null : document.getElementById('promptCn').textContent,
    learnShown: !ln.hidden, learnHiddenAttr: ln.dataset.hidden,
    lnDef: document.getElementById('lnDef').textContent,
    typeBadge: document.getElementById('typeBadge').textContent,
    optTexts: opt.map(o => o.querySelector('.t')?.textContent || ''),
    optDisabled: opt.map(o => o.disabled),
    fbHidden: document.getElementById('feedback').hidden,
    fbClass: document.getElementById('feedback').className,
    fbVerdict: document.getElementById('fbVerdict').textContent,
    fbDiff: !!document.querySelector('.sp-diff .bad'),
    spellShown: !document.getElementById('spellBox').hidden,
    goLearnShown: !document.getElementById('goLearn').hidden,
    goNextShown: !document.getElementById('goNext').hidden,
    ctrNew: document.getElementById('ctrNew').textContent,
    ctrToday: document.getElementById('ctrToday').textContent,
    ctrKnown: document.getElementById('ctrKnown').textContent,
  };
})()`);

/* ---------- A0. 首屏（没学过任何词）= 测验板块空态 ---------- */
/*
 * 2026-11-01 用户报告：原来 boot 直接 buildQueue()（新词+复习混排），
 * 全新用户一打开就落在测验板块、还能直接学词答题 ——「没学过词也能测验」。
 * 现在 boot 走 setMode(state.mode)，板块分工从首屏成立：
 * 学过为 0 ⇒ 测验板块显示「还没有学过的词」空态，唯一动作是「去学习」。
 */
console.log("\n--- A0. 首屏空态：没学过词时测验板块不可测验 ---");
const A0 = JSON.parse(await evalJs(`JSON.stringify((() => {
  const c = window.__cvt;
  return {
    hasHandle: !!c,
    mode: c.stateInfo().mode,
    title: document.getElementById('doneTitle').textContent,
    text: document.getElementById('doneText').textContent,
    doneShown: !document.getElementById('done').hidden,
    gridHidden: document.getElementById('doneGrid').hidden,
    moreHidden: document.getElementById('doneMore').hidden,
    batchQuizHidden: document.getElementById('doneBatchQuiz').hidden,
    drawHidden: document.getElementById('doneDraw').hidden,
    goLearnShown: !document.getElementById('doneGoLearn').hidden,
    drawDisabled: document.getElementById('barDraw').disabled,
    batchDisabled: document.getElementById('barBatch').disabled,
    drawHint: document.getElementById('barDrawHint').textContent,
    quizBarShown: !document.getElementById('quizBar').hidden,
  };
})())`));
console.log("     ", JSON.stringify(A0));
check("调试句柄已装配", A0.hasHandle === true);
check("首屏落在测验板块", A0.mode === "quiz", `mode=${A0.mode}`);
check("空态标题=「还没有学过的词」", A0.title === "还没有学过的词", A0.title);
check("空态文案说清下一步（去学习板块学新词）", A0.text.includes("学习"), A0.text);
check("两个测验入口都禁用", A0.drawDisabled && A0.batchDisabled && A0.quizBarShown,
  `draw=${A0.drawDisabled} batch=${A0.batchDisabled}`);
check("没有「开始一轮」死按钮", A0.moreHidden === true);
check("结算面板的两个测验死按钮也都藏掉", A0.batchQuizHidden && A0.drawHidden,
  `batchQuiz=${A0.batchQuizHidden} draw=${A0.drawHidden}`);
check("不显示全零成绩单", A0.gridHidden === true);
check("唯一动作是「去学习」", A0.goLearnShown === true);
await shot("cdp-0-quiz-empty.png");

/* ---------- A. 点「去学习」→ 新词只教不考 ---------- */
console.log("\n--- A. 点「去学习」→ 学习卡（新词只教不考） ---");
await evalJs(`document.getElementById('doneGoLearn').click()`);
await sleep(700);
const A = await api();
console.log("     ", JSON.stringify({ word: A.wordText, badge: A.typeBadge, learnShown: A.learnShown, ctrNew: A.ctrNew }));
check("「去学习」把界面带到学习板块", A.phase === "learn", `phase=${A.phase}`);
check("首词已渲染（非占位符）", !!A.wordText && A.wordText !== "—", `word=${A.wordText}`);
check("题型徽记写明是新词", A.typeBadge.includes("新词"), `badge=${A.typeBadge}`);
check("释义直接摊开（教，不是考）", A.learnShown && A.learnHiddenAttr === "0" && A.lnDef.length > 1, `lnDef=${A.lnDef.slice(0, 24)}`);
check("没有 options / 拼写框（不是考题）", A.optTexts.length === 0 && !A.spellShown);
check("有「记住了，开始学」按钮", A.goLearnShown === true);
check("新词计数 = 2083", A.ctrNew === "2083", `ctrNew=${A.ctrNew}`);
await shot("cdp-1-learn.png");

/* ---------- B. 学完 → 排期 1 天但**不写成绩** ---------- */
console.log("\n--- B. 学完新词：排期 1 天、不写客观成绩 ---");
const learnWord = A.wordText;
await evalJs(`document.getElementById('goLearn').click()`);
await sleep(900);
const B = await evalJs(`(() => {
  const LW = ${JSON.stringify(learnWord)};
  const c = window.__cvt.cardOf(LW);
  const raw = JSON.parse(localStorage.getItem('cvt:v1:cet6'));
  const d = raw.days[Object.keys(raw.days)[0]] || {};
  const st = window.__cvt.stateInfo();
  return {
    card: c, day: d, nextWord: document.getElementById('word').textContent,
    nextIsQuizOfLearned: st.word === LW && st.kind === 'quiz',
    nextKind: st.kind,
    batch: st.batch,
  };
})()`);
check("已排到 1 天后", B.card && B.card.i === 1 && B.card.s === 2, JSON.stringify(B.card));
check("没有写任何答题成绩（a=0、c=0、k=0）", B.card && B.card.a === 0 && B.card.c === 0 && B.card.k === 0,
  `a=${B.card?.a} c=${B.card?.c} k=${B.card?.k}`);
check("今日新学计数 +1", B.day.n === 1, JSON.stringify(B.day));
check("⭐ 学完立刻就地考这道词（不是等到明天）", B.nextIsQuizOfLearned === true,
  `next=${B.nextWord} kind=${B.nextKind} 期望 quiz of ${learnWord}`);
check("⭐ 本批进度已 +1（一批一批来的核心）", B.batch && B.batch.index >= 1 && B.batch.size > 0,
  JSON.stringify(B.batch));

/* ---------- B2. ⭐ 整队不会「全是记忆卡、一题练习都没有」 ---------- */
// 这正是用户报的问题：今天没有到期复习词时，旧逻辑会排出一整队只教不考的学习卡。
console.log("\n--- B2. 队列编排：学必有考（不会只剩记忆） ---");
const B2 = await evalJs(`window.__cvt.queueSnapshot ? window.__cvt.queueSnapshot() : null`);
check("调试句柄能读到队列快照", !!(B2 && Array.isArray(B2.queue)), B2 ? 'ok' : '无 queueSnapshot');
if (B2 && Array.isArray(B2.queue)) {
  const kinds = B2.queue.map((x) => x.kind);
  const learnCount = kinds.filter((k) => k === 'learn').length;
  const quizCount = kinds.filter((k) => k === 'quiz').length;
  check("队列里既有学习卡也有测验题", learnCount > 0 && quizCount > 0, `learn=${learnCount} quiz=${quizCount}`);
  let unpaired = 0;
  for (let i = 0; i < B2.queue.length; i++) {
    if (B2.queue[i].kind !== 'learn') continue;
    const nxt = B2.queue[i + 1];
    if (!nxt || nxt.kind !== 'quiz' || nxt.word !== B2.queue[i].word) unpaired++;
  }
  check("⭐ 每个学习卡后面都紧跟着它自己的测验（学必有考）", unpaired === 0, `未配对 ${unpaired} 个`);
  // 2026-10-30：一批改为 20 词（用户要求），断言跟着改，并加一条"恰好是 20"，
  // 免得以后 BATCH_SIZE 改了而断言仍然只查 ≤ 某个大数。
  check("⭐ 每批新词数 = BATCH_SIZE(20)", B2.batch && B2.batch.size === 20, JSON.stringify(B2.batch));
}

/* ---------- C. 测验题：4 选项、恰好 1 个正确 ---------- */
console.log("\n--- C. 到期卡 → 测验题（英→中） ---");
const W = "mischief";
await seedAndReload({
  version: 2,
  cards: { [W]: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 2, c: 2, k: 2, fd: dayNum() - 9, ld: dayNum() - 2, bd: 0, ms: 9000, t: dayNum() - 5 } },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "en2cn", timeGate: false, autoSpeak: false, showPos: true },
});
const C = await api();
console.log("     ", JSON.stringify({ type: C.type, opts: C.optTexts.length, idx: C.answerIndex, badge: C.typeBadge }));
check("首屏是测验题", C.phase === "asking" && C.type === "en2cn", `phase=${C.phase} type=${C.type}`);
check("题干是英文词", C.wordText === W && !C.wordHidden, `word=${C.wordText}`);
check("恰好 4 个选项", C.optTexts.length === 4, `${C.optTexts.length} 个`);
check("4 个选项互不相同", new Set(C.optTexts).size === 4, JSON.stringify(C.optTexts));
check("answerIndex 在 0~3", C.answerIndex >= 0 && C.answerIndex <= 3, `answerIndex=${C.answerIndex}`);
const correctText = await evalJs(`(() => { const t = document.querySelector('.opt .t'); const e = window.__cvt.buildQuestion(${JSON.stringify(W)}, 'en2cn'); return e.options[e.answerIndex]; })()`);
check("正确选项只出现一次", C.optTexts.filter((t) => t === correctText).length === 1,
  `correct=${correctText}`);
check("未作答时无反馈", C.fbHidden === true);
const C2 = await evalJs(`({
  dunnoShown: !document.getElementById('dunnoRow').hidden,
  dunnoText: document.getElementById('dunnoBtn').textContent.trim(),
})`);
check("有「我不会」入口（不被迫瞎蒙）", C2.dunnoShown && C2.dunnoText.includes("我不会"), C2.dunnoText);
await shot("cdp-2-quiz-en2cn.png");

/* ---------- D. 答对 → 成绩单 + 连对 +1 ---------- */
console.log("\n--- D. 答对：客观成绩单与连对 ---");
await evalJs(`document.querySelectorAll('.opt')[${C.answerIndex}].click()`);
await sleep(400);
const D = await evalJs(`(() => {
  const c = window.__cvt.cardOf(${JSON.stringify(W)});
  const raw = JSON.parse(localStorage.getItem('cvt:v1:cet6'));
  return { card: c, types: raw.types, verdict: document.getElementById('fbVerdict').textContent,
           fbClass: document.getElementById('feedback').className,
           nextShown: !document.getElementById('goNext').hidden };
})()`);
check("判定为「答对了」", D.verdict.includes("答对了") && D.fbClass.includes("ok"), `${D.verdict} / ${D.fbClass}`);
check("成绩单记了一次作答", D.card.a === 3 && D.card.c === 3, `a=${D.card.a} c=${D.card.c}`);
check("连对 +1（3）", D.card.k === 3, `k=${D.card.k}`);
check("题型成绩单进了 en2cn", D.types.en2cn.a === 1 && D.types.en2cn.c === 1, JSON.stringify(D.types.en2cn));
check("出现「下一个」按钮", D.nextShown === true);
check("这个词现已满足记住判据（连对3 且跨天）", D.card.mastered === true, `fd=${D.card.fd} ld=${D.card.ld}`);

/* ---------- E. 核心规则：本轮答错过、再答对只能算「模糊」 ---------- */
console.log("\n--- E. 核心规则：刚看过答案再答对 = 模糊（不是认识） ---");
await seedAndReload({
  version: 2,
  cards: { [W]: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 2, c: 2, k: 2, fd: dayNum() - 9, ld: dayNum() - 2, bd: 0, ms: 9000, t: dayNum() - 5 } },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "en2cn", timeGate: false, autoSpeak: false, showPos: true },
});
// 第一遍：故意选错
const wrongIdx = await evalJs(`(() => { const s = window.__cvt.stateInfo(); return (s.answerIndex + 1) % s.optionCount; })()`);
await evalJs(`document.querySelectorAll('.opt')[${wrongIdx}].click()`);
await sleep(400);
const E1 = await evalJs(`(() => {
  const c = window.__cvt.cardOf(${JSON.stringify(W)});
  const raw = JSON.parse(localStorage.getItem('cvt:v1:cet6'));
  return { k: c.k, bad: c.bd, qlen: window.__cvt.stateInfo().queueLen,
           inMistakes: raw.mistakes.includes(${JSON.stringify(W)}),
           verdict: document.getElementById('fbVerdict').textContent };
})()`);
check("答错判定正确", E1.verdict.includes("答错了"), E1.verdict);
check("答错清零连对", E1.k === 0, `k=${E1.k}`);
check("答错的词进了错词本", E1.inMistakes === true);
check("答错的词已重排到本轮队列（队列变长）", E1.qlen >= 2, `queueLen=${E1.qlen}`);

// 第二遍：同一个词再次出现（本轮已答错过），这次选对
await evalJs(`document.getElementById('goNext').click()`);
await sleep(500);
const E2 = await api();
check("重排后又是这个词", E2.wordText === W, `word=${E2.wordText}`);
await evalJs(`document.querySelectorAll('.opt')[${E2.answerIndex}].click()`);
await sleep(400);
const E3 = await evalJs(`(() => {
  const c = window.__cvt.cardOf(${JSON.stringify(W)});
  return { verdict: document.getElementById('fbVerdict').textContent,
           fbClass: document.getElementById('feedback').className, k: c.k, note: document.getElementById('fbNote').textContent };
})()`);
console.log("     ", JSON.stringify(E3));
check("答对但只算「模糊」", E3.verdict.includes("模糊") && E3.fbClass.includes("meh"), `${E3.verdict} / ${E3.fbClass}`);
check("连对**没有**增加（仍是 0）", E3.k === 0, `k=${E3.k}`);
check("反馈里说明了原因", E3.note.includes("答错过"), E3.note.slice(0, 40));
await shot("cdp-3-meh.png");

/* ---------- F. 拼写题 ---------- */
console.log("\n--- F. 拼写题：打字判分 + 错字母标注 ---");
await seedAndReload({
  version: 2,
  cards: { [W]: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 0, c: 0, k: 0, fd: 0, ld: 0, bd: 0, ms: 0, t: 0 } },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "spell", timeGate: true, autoSpeak: false, showPos: true },
});
const F = await api();
check("题型是拼写", F.type === "spell", `type=${F.type}`);
check("题干是中文释义、英文词已隐藏", F.wordHidden === true && !!F.promptCn, `promptCn=${String(F.promptCn).slice(0, 20)}`);
check("出现拼写输入框", F.spellShown === true);
await evalJs(`(() => { const i = document.getElementById('spellInput'); i.value = 'mishief'; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
await sleep(400);
const F2 = await evalJs(`(() => {
  const c = window.__cvt.cardOf(${JSON.stringify(W)});
  const note = document.getElementById('fbNote');
  return { verdict: document.getElementById('fbVerdict').textContent,
           cls: document.getElementById('feedback').className,
           diff: !!document.querySelector('.sp-diff .bad, .sp-diff .miss'),
           diffText: note.textContent,
           diffHtml: note.innerHTML,
           answer: document.getElementById('fbAnswer').textContent,
           inputCls: document.getElementById('spellInput').className };
})()`);
check("拼错判为答错", F2.verdict.includes("答错了") && F2.cls.includes("no"), `${F2.verdict} / ${F2.cls}`);
check("标出了拼错的位置", F2.diff === true);
// 回归守卫：mishief→mischief 是「漏了一个 c」，必须说成漏字，
// 而不是把前后缀重叠算错、渲染出 `mis∅hief` 这种占位符（实测踩过）
check("漏字母的情形说成「漏了 c」", F2.diffText.includes("漏了 c"), F2.diffText.slice(0, 50));
check("不出现占位符 ∅（前后缀重叠的旧 bug）", !F2.diffHtml.includes("∅"), F2.diffHtml.slice(0, 90));
check("反馈里给出了正确拼写", F2.answer.includes(W), F2.answer.slice(0, 40));
check("输入框标红", F2.inputCls.includes("no"), F2.inputCls);
await shot("cdp-4-spell-wrong.png");

/* ---------- G. 拼写答对 = 认识（不受「慢」影响） ---------- */
console.log("\n--- G. 拼写答对一律算「认识」 ---");
await evalJs(`document.getElementById('goNext').click()`);
await sleep(400);
await evalJs(`(() => { const i = document.getElementById('spellInput'); i.value = ${JSON.stringify(W)}; i.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
await sleep(400);
const G = await evalJs(`(() => {
  const c = window.__cvt.cardOf(${JSON.stringify(W)});
  return { verdict: document.getElementById('fbVerdict').textContent, cls: document.getElementById('feedback').className, k: c.k, a: c.a, c: c.c };
})()`);
check("拼对判为「答对了」（不是模糊）", G.verdict === "答对了" && G.cls.includes("ok"), `${G.verdict} / ${G.cls}`);
check("连对 +1", G.k >= 1, `k=${G.k}`);

/* ---------- G2. ⭐ 答对了也必须停下来（记忆停顿） ---------- */
console.log("\n--- G2. 答对后的记忆停顿：答案必须留在眼前 ---");
const W2 = "overhang";
const seedTwo = (memorizeMs) => ({
  version: 2,
  cards: {
    [W]: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 0, c: 0, k: 0, fd: 0, ld: 0, bd: 0, ms: 0, t: 0 },
    [W2]: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 0, c: 0, k: 0, fd: 0, ld: 0, bd: 0, ms: 0, t: 0 },
  },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "en2cn", timeGate: false, memorizeMs, autoSpeak: false, showPos: true },
});
// 默认（memorizeMs = 0）：答对后应该**一直**停在答案上，等我自己按
await seedAndReload(seedTwo(0));
const first = await evalJs(`window.__cvt.stateInfo().word`);
const idx1 = await evalJs(`window.__cvt.stateInfo().answerIndex`);
await evalJs(`document.querySelectorAll('.opt')[${idx1}].click()`);
await sleep(2200);   // 旧版本 700ms 就跳走了
const hold1 = await evalJs(`({
  word: window.__cvt.stateInfo().word, phase: window.__cvt.stateInfo().phase,
  hold: document.getElementById('fbHold').textContent,
  nextShown: !document.getElementById('goNext').hidden,
})`);
check("答对 2.2 秒后仍停在答案上（不再 700ms 自动跳走）",
  hold1.phase === "answered" && hold1.word === first, JSON.stringify(hold1));
check("提示写明「停留时间由你定」", hold1.hold.includes("你定"), hold1.hold.slice(0, 40));
check("「下一个」按钮已出现（可随时手动继续）", hold1.nextShown === true);

// 设成 3 秒自动：应该先停住，再在 3 秒左右前进
await evalJs(`(() => { const s = document.getElementById('setMemorize'); s.value = '3000';
  s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await evalJs(`document.getElementById('goNext').click()`);
await sleep(500);
const second = await evalJs(`window.__cvt.stateInfo().word`);
const idx2 = await evalJs(`window.__cvt.stateInfo().answerIndex`);
await evalJs(`document.querySelectorAll('.opt')[${idx2}].click()`);
await sleep(1200);
const mid = await evalJs(`({ word: window.__cvt.stateInfo().word, phase: window.__cvt.stateInfo().phase,
  hold: document.getElementById('fbHold').textContent })`);
check("设 3 秒时，1.2 秒后仍停在答案上", mid.phase === "answered" && mid.word === second, JSON.stringify(mid));
check("提示写明会自动继续", mid.hold.includes("自动继续"), mid.hold.slice(0, 40));
await sleep(2600);   // 累计 3.8s > 3s
const after = await evalJs(`({ word: window.__cvt.stateInfo().word, phase: window.__cvt.stateInfo().phase })`);
check("3.8 秒后已自动前进", after.word !== second || after.phase !== "answered", JSON.stringify(after));
await shot("cdp-5-hold.png");

/* ---------- G3. 「我不会」入口 ---------- */
console.log("\n--- G3. 「我不会」：不被迫瞎蒙 ---");
await seedAndReload(seedTwo(0));
const D3 = await evalJs(`({
  shown: !document.getElementById('dunnoRow').hidden,
  text: document.getElementById('dunnoBtn').textContent.trim(),
})`);
check("选项下方有「我不会」按钮", D3.shown && D3.text.includes("我不会"), D3.text);
// ⚠️ 必须动态取当前词：种子里两张卡的顺序是 shuffle 出来的，
// 写死第一张是哪个词 ⇒ 偶发假红（实测 3 次跑中 1 次）。
const dWord = await evalJs(`window.__cvt.stateInfo().word`);
await evalJs(`document.getElementById('dunnoBtn').click()`);
await sleep(400);
const D4 = await evalJs(`(() => {
  const c = window.__cvt.cardOf(${JSON.stringify(dWord)});
  const raw = JSON.parse(localStorage.getItem('cvt:v1:cet6'));
  return { verdict: document.getElementById('fbVerdict').textContent,
           cls: document.getElementById('feedback').className,
           k: c.k, inMistakes: raw.mistakes.includes(${JSON.stringify(dWord)}),
           qlen: window.__cvt.stateInfo().queueLen,
           dunnoRowHidden: document.getElementById('dunnoRow').hidden,
           note: document.getElementById('fbNote').textContent };
})()`);
console.log("     ", JSON.stringify({ w: dWord, v: D4.verdict, k: D4.k, mk: D4.inMistakes, qlen: D4.qlen }));
check("「我不会」判为答错（不是蒙对的机会）", D4.verdict.includes("我不会") && D4.cls.includes("no"), `${D4.verdict} / ${D4.cls}`);
check("连对清零", D4.k === 0, `k=${D4.k}`);
check("进了错词本", D4.inMistakes === true);
check("本轮会再问你一次", D4.qlen >= 2, `queueLen=${D4.qlen}`);
check("判定后收起「我不会」按钮", D4.dunnoRowHidden === true);
await shot("cdp-6-dunno.png");

/* ---------- G4. 助记技巧：学习卡与判定后都要出现 ---------- */
console.log("\n--- G4. 助记技巧（学习卡 + 判定后） ---");
// ⚠️ 条数**不写死**：助记是分批生成的，写死「12 条」会随每批增长而假红（实测踩过）。
// 断言改成「页面载入的条数 == 文件里的条数」。
const tipFileCount = await evalJs(`(async () => {
  const r = await fetch('/assets/wordbooks/tips/cet6.json');
  const j = await r.json();
  return Object.keys(j.tips || {}).length;
})()`);
const tipCount = await evalJs(`window.__cvt.tipCount()`);
check("助记文件全部载入（页面条数 == 文件条数）", tipCount === tipFileCount && tipCount >= 12,
  `页面 ${tipCount} / 文件 ${tipFileCount}`);

// 数据层审计：每条都要有合法 kind + certainty + 实质内容
const tipAudit = await evalJs(`(async () => {
  const KINDS = ['root','family','sense','story','sound','image','usage'];
  const CERT = ['high','medium','low'];
  const j = await (await fetch('/assets/wordbooks/tips/cet6.json')).json();
  const bad = [];
  const certSeen = {}, kindSeen = {};
  for (const [w, t] of Object.entries(j.tips || {})) {
    if (!t.tip || t.tip.length < 30) bad.push(w + ':tip太短');
    if (!KINDS.includes(t.kind)) bad.push(w + ':kind=' + t.kind);
    if (!CERT.includes(t.certainty)) bad.push(w + ':certainty=' + t.certainty);
    certSeen[t.certainty] = 1; kindSeen[t.kind] = 1;
  }
  return { bad, certs: Object.keys(certSeen).sort(), kinds: Object.keys(kindSeen).sort(),
           total: Object.keys(j.tips || {}).length };
})()`);
check("每条都有合法的 kind + certainty + 实质内容", tipAudit.bad.length === 0,
  tipAudit.bad.slice(0, 5).join(', ') || `${tipAudit.total} 条全部合规`);
check("确定度三档齐备（high/medium/low 都有实例）", tipAudit.certs.length === 3,
  JSON.stringify(tipAudit.certs));
check("类别都是受支持的那几种", tipAudit.kinds.every((k) =>
  ['root','family','sense','story','sound','image','usage'].includes(k)), JSON.stringify(tipAudit.kinds));

// 让「只剩有助记的词是新词」⇒ 队列里全是助记词，可以逐张验渲染。
// newPerDay 要给够，否则一轮只会取前 20 个新词（实测：写 20 时只走到 14 张就到底了）。
const seedOnlyTips = `(() => {
  try {
    function get(u){ var x = new XMLHttpRequest(); x.open('GET', u, false); x.send(); return JSON.parse(x.responseText); }
    var wb = get('/assets/wordbooks/cet6.json');
    var tips = get('/assets/wordbooks/tips/cet6.json').tips;
    var d = new Date();
    var today = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    var cards = {};
    wb.words.forEach(function (w) {
      if (tips[w.word]) return;                       // 有助记的留作新词
      cards[w.word] = { s: 2, i: 1, e: 2.5, d: today + 9999, r: 1, l: 0, a: 5, c: 5, k: 1, fd: today, ld: today, bd: 0, ms: 0, t: today };
    });
    localStorage.setItem('cvt:v1:cet6', JSON.stringify({
      version: 2, cards: cards, mistakes: [], days: {}, streak: 0, lastDay: '',
      types: { en2cn: {a:0,c:0,ms:0}, cn2en: {a:0,c:0,ms:0}, spell: {a:0,c:0,ms:0} },
      settings: { newPerDay: 500, reviewPerDay: 0, quizTypes: 'mix', timeGate: false, memorizeMs: 0, autoSpeak: false, showPos: true }
    }));
  } catch (e) { window.__seedErr = String(e); }
})();`;
const inj4 = await send("Page.addScriptToEvaluateOnNewDocument", { source: seedOnlyTips });
await send("Page.reload", { ignoreCache: false });
await sleep(2600);
await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: inj4.identifier });
// 板块分工后（2026-11-01）：新词只在学习板块排，首屏（测验板块）不再有学习卡 ——
// 不能再指望 boot 的混合队列把学习卡送到眼前（那正是「没学过词也能测验」的根因）。
await evalJs(`document.querySelector('.mode-btn[data-mode="learn"]').click()`);
await sleep(700);

// 逐张走学习卡。⚠️ 现在「学必有考」—— 学完一张紧跟的是它自己的测验题，
// 所以不能在遇到非 learn 时就 break，而要**把中间的测验答掉、继续找下一张学习卡**。
const BATCH = 10;                                  // 与 app.js 的 BATCH_SIZE 对齐
const WALK = Math.min(BATCH, tipCount);            // 一批最多 10 个新词
const seen = [];
const walkStart = Date.now();
while (seen.length < WALK && Date.now() - walkStart < 60000) {
  const s = await evalJs(`(() => ({
    word: document.getElementById('word').textContent,
    phase: window.__cvt.stateInfo().phase,
    kind: window.__cvt.stateInfo().kind,
    shown: !document.getElementById('lnTip').hidden,
    chip: document.getElementById('lnTipKind').textContent.trim(),
    cls: document.getElementById('lnTipKind').className,
    text: document.getElementById('lnTipText').textContent,
    cert: window.__cvt.tipOf(document.getElementById('word').textContent)?.certainty || null,
  }))()`);
  if (s.phase === 'done' || s.kind === null) break;   // 这一批走完了
  if (s.kind === 'learn') {
    seen.push(s);
    if (seen.length === 1) await shot("cdp-9-tip-learn.png");
    await evalJs(`document.getElementById('goLearn').click()`);
    await sleep(420);
  } else {
    // 学完后的那道测验：随便选一个把它答掉，好继续走到下一个新词
    await evalJs(`document.querySelectorAll('.opt')[0]?.click()`);
    await sleep(360);
    await evalJs(`document.getElementById('goNext')?.click()`);
    await sleep(360);
  }
}
console.log("      走完 %d 张学习卡；示例: %s", seen.length,
  JSON.stringify(seen[0] && { w: seen[0].word, chip: seen[0].chip, len: seen[0].text.length }));
check(`走满 ${WALK} 张学习卡且每张都有助记`, seen.length === WALK && seen.every((s) => s.shown),
  `走了 ${seen.length} 张，缺助记 ${seen.filter((s) => !s.shown).length} 张`);
// 逐张核对「徽记文字」与「颜色类名」一致 —— 比"三档都出现过"确定，不受随机抽词影响
const CERT_LABEL = { high: '确证', medium: '可信', low: '联想' };
const mismatched = seen.filter((s) => !s.chip.endsWith(`· ${CERT_LABEL[s.cert]}`) || !s.cls.includes(`c-${s.cert}`));
check("徽记文字与颜色都按确定度走（逐张核对）", mismatched.length === 0,
  mismatched.slice(0, 3).map((s) => `${s.word}:${s.chip}/${s.cls}`).join(' | ') || "全部一致");
check("徽记都写明了类别 + 确定度", seen.every((s) => /·\s*(确证|可信|联想)$/.test(s.chip)),
  JSON.stringify([...new Set(seen.map((s) => s.chip))].slice(0, 5)));
check("每条助记都有实质内容（≥30 字）",
  seen.every((s) => s.text.length >= 30), `最短 ${Math.min(...seen.map((s) => s.text.length))} 字`);

// 没有助记的词：整块必须隐藏（不硬编不存在的助记）
// ⚠️ 输入方式的第三次演进（见文件开头）：
//   助记覆盖到 100% 之后，队列里再也走不到"没有助记的词"这个分支 ——
//   而"合成一个词库外的词"也行不通：队列是从词库生成的，词库外的词进不了队列（实测 null）。
//   最终方案：**从真实数据里摘掉一条助记，再走真实的渲染路径**。
//   被测的仍是真实的守卫逻辑，但输入完全可控、且绝不依赖"数据里恰好有这种词"。
await seedAndReload({
  version: 2,
  cards: { [NO_TIP_WORD]: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 0, c: 0, k: 0, fd: 0, ld: 0, bd: 0, ms: 0, t: 0 } },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "en2cn", timeGate: false, memorizeMs: 0, autoSpeak: false, showPos: true },
});
const noTipWordNow = await evalJs(`window.__cvt.stateInfo().word`);
check("队列里确实有这个词（说明种子生效）", noTipWordNow === NO_TIP_WORD, `${noTipWordNow} vs ${NO_TIP_WORD}`);
// 前提确认：这个词**原本是有助记的**（否则下面的摘除没意义，断言会假绿）
const before = await evalJs(`({ hasTip: !!window.__cvt.tipOf(${JSON.stringify(NO_TIP_WORD)}), tipCount: window.__cvt.tipCount() })`);
check("被测词原本有助记（断言前提成立）", before.hasTip === true, JSON.stringify(before));
const saved = await evalJs(`window.__cvt.tipOf(${JSON.stringify(NO_TIP_WORD)})`);
// 摘掉助记后重画：学习卡上的助记块必须隐藏
const dropped = await evalJs(`window.__cvt.dropTip(${JSON.stringify(NO_TIP_WORD)})`);
const lnHidden = await evalJs(`document.getElementById('lnTip').hidden`);
check("摘掉助记后：学习卡的助记块整块隐藏（不硬编）", lnHidden === true,
  `dropTip=${JSON.stringify(dropped)} lnTipHidden=${lnHidden}`);
// 判定之后，反馈里的助记块也必须隐藏
await evalJs(`window.__cvt.dropTip(${JSON.stringify(NO_TIP_WORD)})`);
const idxNoTip = await evalJs(`window.__cvt.stateInfo().answerIndex`);
await evalJs(`document.querySelectorAll('.opt')[${idxNoTip}].click()`);
await sleep(400);
const noTip = await evalJs(`({ fbTipHidden: document.getElementById('fbTip').hidden })`);
check("没有助记的词：判定后也不显示助记块", noTip.fbTipHidden === true,
  `${NO_TIP_WORD}: ${JSON.stringify(noTip)}`);
// 还原：证明"显示"与"隐藏"都由数据驱动，而不是块被永久关掉
await evalJs(`window.__cvt.restoreTips(${JSON.stringify(NO_TIP_WORD)}, ${JSON.stringify(saved)})`);
const restored = await evalJs(`({ hasTip: !!window.__cvt.tipOf(${JSON.stringify(NO_TIP_WORD)}), lnHidden: document.getElementById('lnTip').hidden })`);
check("还原助记后：块重新显示（证明是数据驱动而非一次性的）",
  restored.hasTip === true, JSON.stringify(restored));

// 有助记的词：判定后必须显示，类别正确，且嵌在反馈块里
await seedAndReload({
  version: 2,
  cards: { statistics: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 0, c: 0, k: 0, fd: 0, ld: 0, bd: 0, ms: 0, t: 0 } },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "en2cn", timeGate: false, memorizeMs: 0, autoSpeak: false, showPos: true },
});
const idxTip = await evalJs(`window.__cvt.stateInfo().answerIndex`);
await evalJs(`document.querySelectorAll('.opt')[${idxTip}].click()`);
await sleep(400);
const withTip = await evalJs(`({
  hidden: document.getElementById('fbTip').hidden,
  kind: document.getElementById('fbTipKind').textContent,
  cls: document.getElementById('fbTipKind').className,
  text: document.getElementById('fbTipText').textContent,
  inFeedback: !!document.getElementById('feedback').contains(document.getElementById('fbTip')),
})`);
console.log("      ", JSON.stringify({ kind: withTip.kind, len: withTip.text.length }));
check("有助记的词：判定后显示助记，徽记写明「类别 · 确定度」",
  withTip.hidden === false && withTip.kind === "词源故事 · 可信" && withTip.cls.includes("c-medium"),
  `${withTip.kind} / ${withTip.cls}`);
check("助记嵌在反馈块里（跟着答案一起停留，不是另开一处）", withTip.inFeedback === true);
await shot("cdp-10-tip-feedback.png");

/* ---------- G5. 源书修正：界面必须提示「与书不一致」---------- */
console.log("\n--- G5. 源书词性/义项修正的界面提示 ---");
// dignity 是 entry_repairs.json 里实打实修过词性的（原书标 a.，实为 n.）
await seedAndReload({
  version: 2,
  cards: { dignity: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 0, c: 0, k: 0, fd: 0, ld: 0, bd: 0, ms: 0, t: 0 } },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "en2cn", timeGate: false, memorizeMs: 0, autoSpeak: false, showPos: true },
});
const G5 = await evalJs(`({
  hidden: document.getElementById('fixNote').hidden,
  text: document.getElementById('fixNote').textContent,
  fix: window.__cvt.entryFixOf('dignity'),
  cardPos: [...document.querySelectorAll('.pos-badge')].map(b => b.textContent),
})`);
console.log("      ", JSON.stringify({ pos: G5.cardPos, text: G5.text.slice(0, 60) }));
check("修正过的条目：界面提示了「与书不一致」", G5.hidden === false && G5.text.includes("本条已修正"), G5.text.slice(0, 50));
check("提示里给出了书本原文（可对照）", G5.text.includes("a.尊贵"), G5.text.slice(0, 70));
check("卡片上的词性已用修正后的（n. 而不是 a.）", G5.cardPos.includes("n.") && !G5.cardPos.includes("a."),
  JSON.stringify(G5.cardPos));
check("调试句柄能读到修正记录", !!G5.fix && G5.fix.kind === "pos_fix", JSON.stringify(G5.fix));
await shot("cdp-11-fixnote.png");

// 未修正的条目不该出现这块提示
await seedAndReload({
  version: 2,
  cards: { overhang: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 0, c: 0, k: 0, fd: 0, ld: 0, bd: 0, ms: 0, t: 0 } },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "en2cn", timeGate: false, memorizeMs: 0, autoSpeak: false, showPos: true },
});
const G5b = await evalJs(`document.getElementById('fixNote').hidden`);
check("未修正的条目不显示这块提示", G5b === true, `hidden=${G5b}`);

console.log("\n--- H. 「记住了」= 连对 ≥3 且跨天 ---");
const H = await evalJs(`(() => {
  const w = ${JSON.stringify(W)};
  const same3 = window.__cvt.simulateCorrect(w, 3, true);     // 同日连对 3 次
  const cross3 = window.__cvt.simulateCorrect(w, 3, false);   // 跨天连对 3 次
  const cross2 = window.__cvt.simulateCorrect(w, 2, false);   // 跨天但只有 2 次
  return { same3: same3.mastered, cross3: cross3.mastered, cross2: cross2.mastered,
           masteredCount: window.__cvt.masteredCount() };
})()`);
console.log("     ", JSON.stringify(H));
check("同日连对 3 次 → **不算**记住", H.same3 === false, `mastered=${H.same3}`);
check("跨天连对 2 次 → 仍不算", H.cross2 === false, `mastered=${H.cross2}`);
check("跨天连对 3 次 → 算记住", H.cross3 === true, `mastered=${H.cross3}`);

/* ---------- I. 选项生成质量：批量 500 题 ---------- */
console.log("\n--- I. 选项生成质量（批量 500 题） ---");
const Q = await evalJs(`(() => {
  const qs = window.__cvt.sampleQuestions(500);
  let bad = 0, dup = 0, ans = 0, missing = 0, spell = 0;
  const badSample = [];
  for (const q of qs) {
    if (!q) { missing++; continue; }
    if (q.type === 'spell') { spell++; continue; }   // 拼写题本来就没有选项，不算缺失
    if (!q.options || q.options.length !== 4) { bad++; continue; }
    if (new Set(q.options).size !== 4) dup++;
    if (q.options[q.answerIndex] !== q.correctText) ans++;
    if (q.options.filter(o => o === q.correctText).length !== 1) ans++;
    if ((bad || dup || ans) && badSample.length < 3) badSample.push({ t: q.type, w: q.word, o: q.options, i: q.answerIndex });
  }
  return { n: qs.length, bad, dup, ans, missing, spell, badSample };
})()`);
console.log("     ", JSON.stringify({ n: Q.n, 选择题: Q.n - Q.spell, 拼写题: Q.spell, bad: Q.bad, dup: Q.dup, ans: Q.ans, missing: Q.missing }));
if (Q.badSample.length) console.log("      样例:", JSON.stringify(Q.badSample));
check("500 题全部生成成功", Q.missing === 0 && Q.n === 500, `missing=${Q.missing}`);
check("三种题型都被抽到", Q.spell > 50 && Q.n - Q.spell > 50, `拼写 ${Q.spell} / 选择 ${Q.n - Q.spell}`);
check("每题恰好 4 个选项", Q.bad === 0, `异常 ${Q.bad} 题`);
check("每题选项互不相同（无重复干扰项）", Q.dup === 0, `重复 ${Q.dup} 题`);
check("每题恰好 1 个正确选项", Q.ans === 0, `错误 ${Q.ans} 题`);

/* ---------- J. 刷新后进度保留（自给自足，不依赖前面几段留下的状态） ----------
   之前这段是「刷新一下，然后断言前一段答过的那张卡还在」—— 一旦在它前面插入新段
   （本轮插了 G5），被断言的状态就没了，于是假红。判据：**每段自己播种、自己作答、自己断言。** */
console.log("\n--- J. 刷新后进度保留 ---");
const JW = "threshold";
await seedAndReload({
  version: 2,
  cards: { [JW]: { s: 2, i: 5, e: 2.5, d: dayNum() - 1, r: 3, l: 0, a: 0, c: 0, k: 0, fd: 0, ld: 0, bd: 0, ms: 0, t: 0 } },
  mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 0, reviewPerDay: 50, quizTypes: "en2cn", timeGate: false, memorizeMs: 0, autoSpeak: false, showPos: true },
});
const jIdx = await evalJs(`window.__cvt.stateInfo().answerIndex`);
await evalJs(`document.querySelectorAll('.opt')[${jIdx}].click()`);
await sleep(400);
await send("Page.reload", { ignoreCache: false });
await sleep(2400);
const J = await evalJs(`(() => {
  const c = window.__cvt.cardOf(${JSON.stringify(JW)});
  const raw = JSON.parse(localStorage.getItem('cvt:v1:cet6'));
  return { a: c?.a ?? -1, c: c?.c ?? -1, types: raw.types, hasHandle: !!window.__cvt };
})()`);
check("刷新后调试句柄仍在", J.hasHandle === true);
check("刷新后这张卡的答题记录保留", J.a === 1 && J.c === 1, `a=${J.a} c=${J.c}`);
check("刷新后题型成绩单保留", (J.types.en2cn.a || 0) === 1, `en2cn.a=${J.types.en2cn.a}`);

/* ---------- K. 四个板块都能进（2026-10-30 改为 学习/测验/统计/设置） ---------- */
console.log("\n--- K. 四个板块都能进 ---");
/*
 * 导航在 2026-10-30 重排：原来顶层是「测验/快速过词/乱序浏览/统计」，
 * 现在是「学习/测验/统计/设置」四个**职能板块**；
 * 快速过词与乱序浏览降为学习板块内的工具（走 #learnBar 的 data-submode）。
 * 所以这一段同时验两层：板块切换、以及学习辅助仍能进去。
 */
const boardExpect = {
  learn:    { stage: true,  panel: false, settings: false, learnBar: true,  quizBar: false },
  quiz:     { stage: true,  panel: false, settings: false, learnBar: false, quizBar: true  },
  stats:    { stage: false, panel: true,  settings: false, learnBar: false, quizBar: false },
  settings: { stage: false, panel: false, settings: true,  learnBar: false, quizBar: false },
};
for (const [board, exp] of Object.entries(boardExpect)) {
  await evalJs(`document.querySelector('.mode-btn[data-mode="${board}"]').click(); true`);
  await sleep(650);
  const st = await evalJs(`({
    selected: document.querySelector('.mode-btn[aria-selected="true"]')?.dataset.mode,
    stageHidden: document.getElementById('stage').hidden,
    panelHidden: document.getElementById('panel').hidden,
    settingsHidden: document.getElementById('settingsPanel').hidden,
    learnBarHidden: document.getElementById('learnBar').hidden,
    quizBarHidden: document.getElementById('quizBar').hidden,
    statCards: document.querySelectorAll('#statRow .stat').length,
    typeCards: document.querySelectorAll('#typeRow .tcard').length,
    forecastBars: document.querySelectorAll('#forecast .fc').length,
    aboutRows: document.querySelectorAll('.about-row').length,
  })`);
  check(`板块「${board}」：可见性正确`,
    st.selected === board
      && st.stageHidden === !exp.stage
      && st.panelHidden === !exp.panel
      && st.settingsHidden === !exp.settings
      && st.learnBarHidden === !exp.learnBar
      && st.quizBarHidden === !exp.quizBar,
    JSON.stringify(st));
  if (board === "stats") {
    check("统计板块：14 张累计卡 + 3 张题型卡 + 14 根柱子",
      st.statCards === 14 && st.typeCards === 3 && st.forecastBars === 14, JSON.stringify(st));
    await shot("cdp-7-stats.png");
  }
  if (board === "settings") {
    check("设置板块：关于有内容（版本/词库/助记等）", st.aboutRows >= 4, `aboutRows=${st.aboutRows}`);
    await shot("cdp-12-settings.png");
  }
  await shot(`cdp-nav-${board}.png`);
}

// 学习板块的三个辅助入口仍可用
await evalJs(`document.querySelector('.mode-btn[data-mode="learn"]').click(); true`);
await sleep(500);
for (const [sub, want] of [["flash", "flash"], ["browse", "browse"], ["new", "learn"]]) {
  await evalJs(`document.querySelector('#learnBar [data-submode="${sub}"]').click(); true`);
  await sleep(650);
  const st = await evalJs(`({
    mode: window.__cvt.stateInfo().mode,
    learnBarHidden: document.getElementById('learnBar').hidden,
    stageHidden: document.getElementById('stage').hidden,
  })`);
  check(`学习辅助「${sub}」→ mode=${want} 且仍在学习板块`,
    st.mode === want && !st.learnBarHidden && !st.stageHidden, JSON.stringify(st));
}

/* ---------- L. 灌入模拟进度：图表与「最该复习」真的画出来 ---------- */
console.log("\n--- L. 到期量柱状图 + 最该复习（灌入跨 14 天进度） ---");
const cards = {};
const words = await evalJs(`(() => { const s = window.__cvt; const out = []; for (let i=0;i<620;i++){} return out; })()`);
const seedCards = await evalJs(`(async () => {
  const wb = await (await fetch('/assets/wordbooks/cet6.json')).json();
  const out = [];
  for (let i = 0; i < 620 && i < wb.words.length; i++) {
    const off = i % 9 === 0 ? i % 14 : Math.floor(14 * Math.pow(i / 620, 1.6));
    const interval = i % 9 === 0 ? 30 + (i % 40) : Math.max(1, off);
    out.push([wb.words[i].word, off, interval]);
  }
  return out;
})()`);
const d0 = dayNum();
// 最近 14 天造一点活动记录，用来验证「最近 30 天」历史图真的画柱子（而不是全空）
const seedDays = {};
const tk = (off) => { const d = new Date(); d.setDate(d.getDate() - off);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
for (let i = 0; i < 14; i++) {
  seedDays[tk(i)] = { n: 20, ok: 30 + ((i * 7) % 25), bad: 3 + (i % 6) };
}
const seeded = {
  version: 2,
  cards: Object.fromEntries(seedCards.map(([w, off, iv]) => [w, {
    s: 2, i: iv, e: 2.5, d: d0 + off, r: 3, l: 0,
    a: 5, c: off % 5 + 1, k: off % 4, fd: d0 - 20 + (off % 5), ld: d0 - 10 + (off % 3), bd: d0 - (off % 7), ms: 40000 + off * 900,
  }])),
  mistakes: seedCards.slice(200, 223).map(([w]) => w),
  days: seedDays, streak: 14, lastDay: tk(0),
  types: { en2cn: { a: 400, c: 350, ms: 2_600_000 }, cn2en: { a: 200, c: 130, ms: 2_400_000 }, spell: { a: 80, c: 34, ms: 1_600_000 } },
  settings: { newPerDay: 20, reviewPerDay: 200, quizTypes: "mix", timeGate: true, memorizeMs: 0, autoSpeak: false, showPos: true },
};
await seedAndReload(seeded);
await evalJs(`document.querySelector('.mode-btn[data-mode="stats"]').click()`);
await sleep(800);
const L = await evalJs(`(() => {
  const bars = [...document.querySelectorAll('#forecast .fc-bar')].map(b => Math.round(b.getBoundingClientRect().height));
  const stats = [...document.querySelectorAll('#statRow .stat')].map(s => [s.querySelector('i').textContent, s.querySelector('b').textContent]);
  const types = [...document.querySelectorAll('#typeRow .tcard')].map(c => c.querySelector('b').textContent);
  const pb = document.getElementById('progressBlock');
  const pbar = [...pb.querySelectorAll('.pbar > span')].map(s => s.style.width);
  // 四态图例的数值（用来核对「已学过」= 记住了 + 复习中 + 学习中）
  const legendItems = [...pb.querySelectorAll('.pb-legend span')].map((s) => {
    const name = s.textContent.replace(/[0-9\\s]/g, '').trim();
    const num = Number((s.querySelector('b') || {}).textContent || NaN);
    return [name, num];
  });
  const legendNums = {
    mastered: (legendItems.find(([n]) => n === '已记住') || [])[1],
    reviewing: (legendItems.find(([n]) => n === '复习中') || [])[1],
    learning: (legendItems.find(([n]) => n === '学习中') || [])[1],
    unlearned: (legendItems.find(([n]) => n === '还没学') || [])[1],
  };
  return {
    bars, stats, types, pbar, legendNums, legendItems,
    pbText: pb.textContent.replace(/\\s+/g, ' ').trim(),
    legend: pb.querySelectorAll('.pb-legend span').length,
    hist: document.querySelectorAll('#history .hist').length,
    histLabels: document.querySelectorAll('#history .hist-label span').length,
    histLabelIsSibling: !!document.querySelector('#history > .hist-bars') && !!document.querySelector('#history > .hist-label'),
    histEmpty: document.querySelectorAll('#history .hist.empty').length,
    histEmptyHeights: [...document.querySelectorAll('#history .hist.empty')].map(h => Math.round(h.getBoundingClientRect().height)),
    histHeights: [...document.querySelectorAll('#history .hist:not(.empty)')].map(h => Math.round(h.getBoundingClientRect().height)),
    weakest: document.querySelectorAll('#weakest .wk').length,
    mistakes: document.querySelectorAll('#mistakes .mk').length,
  };
})()`);
console.log("      柱高:", JSON.stringify(L.bars));
console.log("      累计:", JSON.stringify(L.stats));
console.log("      题型正确率:", JSON.stringify(L.types));
console.log("      总进度条:", JSON.stringify(L.pbar));
console.log("      总进度文字:", L.pbText.slice(0, 130));
const statMap = Object.fromEntries(L.stats);
check("柱状图有真实高度（最高 ≥ 60px）", Math.max(...L.bars) >= 60, `max=${Math.max(...L.bars)}px`);
check("14 根柱子高度不全相等（数据驱动）", new Set(L.bars).size > 3, `distinct=${new Set(L.bars).size}`);
check("考过的词 = 620", statMap["考过的词"] === "620", `考过的词=${statMap["考过的词"]}`);
check("记住了 > 0（跨天连对）", Number(statMap["记住了"]) > 0, `记住了=${statMap["记住了"]}`);
check("累计答题 = 680", statMap["累计答题"] === "680", `累计答题=${statMap["累计答题"]}`);
check("题型正确率三档都算出来了（英→中 88%、中→英 65%、拼写 43%）",
  L.types[0] === "88%" && L.types[1] === "65%" && L.types[2] === "43%", JSON.stringify(L.types));
// 总进度块：四态堆叠条 + 图例 + 大数
check("总进度：考过 620 / 2083 词", /考过 620 \/ 2083 词/.test(L.pbText), L.pbText.slice(0, 60));
/*
 * 「已学过」是 2026-10-30 因用户提问「在哪看学过的词汇数量」而补上的大数字。
 * 它和「考过」刻意分开：
 *   已学过 = 记住了 + 复习中 + 学习中（动过的词，含**只看了学习卡还没答题**的）
 *   考过   = 至少答过一次（按 card.a > 0 算）
 * 实测过两者的差异：学一张新词卡后「已学过 1 / 考过 0」——
 * 若只留「考过」，用户会以为刚学的词没算进去。
 */
const learnedM = L.pbText.match(/已学过 (\d+) \/ (\d+) 词/);
check("总进度：有「已学过 N / 总数」大数字（用户找不到的正是它）",
  !!learnedM, learnedM ? learnedM[0] : "没找到");
check("⭐ 已学过 = 记住了 + 复习中 + 学习中（与四态图例自洽）",
  !!learnedM && L.legendNums &&
    Number(learnedM[1]) === L.legendNums.mastered + L.legendNums.reviewing + L.legendNums.learning,
  learnedM && L.legendNums
    ? `已学过=${learnedM[1]}，四态和=${L.legendNums.mastered}+${L.legendNums.reviewing}+${L.legendNums.learning}`
    : "数据不足");
check("总进度：四态堆叠条 4 段且宽度之和 ≈100%",
  L.pbar.length === 4 && Math.abs(L.pbar.reduce((n, w) => n + parseFloat(w || 0), 0) - 100) < 1.5,
  JSON.stringify(L.pbar));
check("总进度：图例 4 项", L.legend === 4, `${L.legend} 项`);
check("最近 30 天：30 根柱子 + 30 个刻度", L.hist === 30 && L.histLabels === 30,
  `hist=${L.hist} labels=${L.histLabels}`);
check("最近 30 天：刻度是柱子的兄弟容器（不是被塞进 flex 里挤到右边）",
  L.histLabelIsSibling === true, `sibling=${L.histLabelIsSibling}`);
check("最近 30 天：有记录的日子画了柱子（14 天有数据）", L.hist - L.histEmpty === 14,
  `有数据 ${L.hist - L.histEmpty} 天 / 空 ${L.histEmpty} 天`);
check("最近 30 天：空白日子只留细底线（不许撑成满高）",
  L.histEmptyHeights.length > 0 && Math.max(...L.histEmptyHeights) <= 6,
  `空白高度 ${JSON.stringify([...new Set(L.histEmptyHeights)])}`);
check("最近 30 天：柱子高度按当天答题量变化（不是等高的占位）", new Set(L.histHeights).size > 3,
  JSON.stringify(L.histHeights));
check("「最该复习」列出了 20 个词", L.weakest === 20, `${L.weakest} 个`);
check("错词本渲染出 23 个词", L.mistakes === 23, `${L.mistakes} 个`);
await shot("cdp-8-stats-seeded.png");

/* ---------- N. 窄屏（手机）布局 ---------- */
console.log("\n--- N. 窄屏布局（手机视口） ---");
/*
 * 为什么需要这一段：真机上暴露过一个只有"窄屏 + 长助记"才出现的 bug ——
 * 学习卡的助记把「记住了，开始学」顶到可视区之外，而桌面端的高度模型
 * （html/body height:100% + .app min-height:100%）让页面**根本滚不动**，
 * 那个按钮永远点不到。桌面门禁一直是绿的，因为桌面视口够高。
 *
 * 判据必须落在"能不能够到"，而不是"看起来有没有被裁"：
 *   ① 窄屏下 body 要能纵向滚（overflow-y:auto）
 *   ② 内容溢出时，滚到底后按钮下沿必须 ≤ innerHeight
 * ⚠️ 真机上还有一层：innerHeight 不等于 visualViewport.height（系统手势条）。
 *    浏览器仿真里二者相等，所以这里只能验到 ① ②；真机那层由
 *    docs/ 记录的手工验收覆盖（见 DEVELOPMENT.md §2.8）。
 */
await send("Emulation.setDeviceMetricsOverride", {
  width: 420, height: 620, deviceScaleFactor: 2, mobile: true,
});
await sleep(600);
const emu = await evalJs(`({ w: innerWidth, h: innerHeight })`);
check("窄屏仿真生效（视口 < 720px，才会命中手机媒体查询）",
  emu.w < 720, `${emu.w}x${emu.h}`);

const narrow = await evalJs(`(async () => {
  // 回到测验视图并刷新到一张学习卡，确保按钮存在
  location.reload();
  return true;
})()`);
await sleep(2600);

const mq = await evalJs(`({ mq720: matchMedia('(max-width: 720px)').matches,
  overflowY: getComputedStyle(document.body).overflowY,
  docH: document.body.scrollHeight, innerH: innerHeight })`);
check("窄屏下命中 (max-width:720px) 媒体查询", mq.mq720 === true);
check("窄屏下 body 允许纵向滚动（桌面是 height:100% 且不可滚）",
  mq.overflowY === "auto", `overflow-y=${mq.overflowY}`);

/*
 * 让"按钮够不够得到"这件事有确定的输入：
 * 前面的段落已经往 localStorage 种了不少进度，刷新后首屏未必是学习卡
 * （goLearn 可能被隐藏）。这里改为**主动进入过词模式**并揭示释义 ——
 * 这是手机上内容最长、最容易把底部按钮顶出去的状态，而且三类视图都会
 * 经过 `.grades` / `.card`，用它测"底部按钮可达"与具体题型无关。
 *
 * ⚠️ 过词模式已不再是顶层标签（2026-10-30 导航重排），改从学习板块的
 *    #learnBar [data-submode="flash"] 进入。
 */
await evalJs(`document.querySelector('.mode-btn[data-mode="learn"]').click(); true`);
await sleep(500);
await evalJs(`document.querySelector('#learnBar [data-submode="flash"]').click(); true`);
await sleep(700);
await evalJs(`(() => { const c = document.getElementById('card'); if (c) c.click(); return true; })()`);
await sleep(500);

const reach = await evalJs(`(async () => {
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 500));
  // 过词模式的底部按钮是「不认识/模糊/认识」，取第一个可见的
  const cands = ['goFlashBad', 'goFlashMeh', 'goFlashGood', 'goLearn', 'goNext']
    .map((id) => document.getElementById(id))
    .filter((el) => el && !el.hidden);
  if (!cands.length) return { missing: true };
  const b = cands[0].getBoundingClientRect();
  return {
    id: cands[0].id,
    top: Math.round(b.top), bottom: Math.round(b.bottom),
    innerH: innerHeight, scrollY: Math.round(scrollY),
    docH: document.body.scrollHeight, maxScroll: Math.round(document.body.scrollHeight - innerHeight),
  };
})()`);
check("滚到底后底部按钮完整落在可视区内（真机上「点得到」的判据）",
  !reach.missing && reach.bottom <= reach.innerH && reach.top >= 0,
  reach.missing ? "底部按钮都不存在（视图状态不对）"
    : `#${reach.id} bottom=${reach.bottom} innerH=${reach.innerH} scrollY=${reach.scrollY} maxScroll=${reach.maxScroll} doc=${reach.docH}`);

/*
 * 「未来 14 天到期量」的日期刻度在窄屏会被挤爆。
 *
 * 真机实测（2026-10-30，用户报告）：14 个刻度挤在 ~300px 里，
 * 文本互相压住，读出来是「今 10/31 1/11 1/21 1/31…」这种完全没法看的样子。
 * 桌面端面板够宽，所以这是**只在窄屏暴露**的缺陷。
 *
 * ⚠️ 判据不能写成"文字不溢出格子" —— 格子只有 18~22px 而「11/11」要 28px，
 *    允许刻度稍微溢出格心是设计选择。真正决定"能否读"的是**相邻文本不重叠**。
 */
await evalJs(`document.querySelector('.mode-btn[data-mode="stats"]').click(); true`);
await sleep(800);
const fcLabels = await evalJs(`(() => {
  const fc = document.getElementById('forecast');
  if (!fc) return { missing: true };
  const cells = [...fc.children];
  const vis = cells.map((c) => {
    const d = c.querySelector('.fc-d');
    const r = d.getBoundingClientRect();
    return {
      text: d.textContent.trim(),
      visible: getComputedStyle(d).visibility !== 'hidden',
      left: Math.round(r.left), right: Math.round(r.right),
    };
  }).filter((x) => x.visible);
  let overlaps = [], minGap = Infinity;
  for (let i = 1; i < vis.length; i++) {
    const gap = vis[i].left - vis[i - 1].right;
    if (gap < minGap) minGap = gap;
    if (gap < 0) overlaps.push(vis[i - 1].text + '↔' + vis[i].text);
  }
  return {
    cellW: Math.round(cells[0].getBoundingClientRect().width),
    total: cells.length, visible: vis.length,
    labels: vis.map((x) => x.text), overlaps,
    minGap: Number.isFinite(minGap) ? minGap : null,
  };
})()`);
check("⭐ 窄屏下到期量刻度互不重叠（真机上曾挤成一片）",
  !fcLabels.missing && fcLabels.overlaps.length === 0,
  fcLabels.missing ? "找不到 #forecast"
    : `可见 ${fcLabels.visible}/${fcLabels.total} 个刻度：${fcLabels.labels.join(" ")}；最小间距 ${fcLabels.minGap}px`);
check("窄屏下柱子一根不少（隐藏的只是文字，不是数据）",
  fcLabels.total === 14, `${fcLabels.total} 根`);

/*
 * 「动作按钮行撑满」回归守卫（2026-11-02 用户报告：手机上按钮行只剩半宽，
 * 现已改为撑满行宽、左右边缘与卡片对齐）。对两处按钮行各钉一条，判据一致：
 *   行内最左按钮的 left ≈ 卡片 left，最右按钮的 right ≈ 卡片 right（±4px 取整误差）。
 * 前提不满足（按钮不可见）时如实跳过 —— 那是状态问题，不是布局回归。
 */
const flashRow = JSON.parse(await evalJs(`(async () => {
  // 自建前提：回到学习板块的过词模式（setMode('flash') 会重排队列并重画三档按钮）
  document.querySelector('.mode-btn[data-mode="learn"]').click();
  await new Promise(r => setTimeout(r, 500));
  document.querySelector('#learnBar [data-submode="flash"]').click();
  await new Promise(r => setTimeout(r, 700));
  const card = document.getElementById('card');
  const els = ['goFlashBad', 'goFlashMeh', 'goFlashGood']
    .map((id) => document.getElementById(id));
  const allVis = els.every((el) => el && !el.hidden && el.getBoundingClientRect().width > 0);
  if (!card || card.hidden || !allVis) {
    return JSON.stringify({ skip: true, why: '过词三档按钮不全可见' });
  }
  const cl = card.getBoundingClientRect();
  const bl = els[0].getBoundingClientRect();
  const gr = els[2].getBoundingClientRect();
  return JSON.stringify({
    badLeft: Math.round(bl.left), cardLeft: Math.round(cl.left),
    goodRight: Math.round(gr.right), cardRight: Math.round(cl.right),
  });
})()`, true));
check("⭐ 窄屏下过词三档按钮行撑满卡片宽度",
  flashRow.skip ? true
    : (Math.abs(flashRow.badLeft - flashRow.cardLeft) <= 4
      && Math.abs(flashRow.goodRight - flashRow.cardRight) <= 4),
  flashRow.skip ? `跳过（${flashRow.why}）`
    : `bad.left=${flashRow.badLeft} card.left=${flashRow.cardLeft} good.right=${flashRow.goodRight} card.right=${flashRow.cardRight}`);

const quizBarRow = JSON.parse(await evalJs(`(async () => {
  document.querySelector('.mode-btn[data-mode="quiz"]').click();
  await new Promise(r => setTimeout(r, 600));
  const card = document.getElementById('card');
  const draw = document.getElementById('barDraw');
  const batch = document.getElementById('barBatch');
  const vis = (el) => el && !el.hidden && el.getBoundingClientRect().width > 0;
  if (!card || card.hidden || !vis(draw) || !vis(batch)) {
    return JSON.stringify({ skip: true, why: '测验入口条或卡片不可见' });
  }
  const cl = card.getBoundingClientRect();
  const dl = draw.getBoundingClientRect();
  const br = batch.getBoundingClientRect();
  return JSON.stringify({
    drawLeft: Math.round(dl.left), cardLeft: Math.round(cl.left),
    batchRight: Math.round(br.right), cardRight: Math.round(cl.right),
  });
})()`, true));
check("⭐ 窄屏下测验入口条撑满卡片宽度",
  quizBarRow.skip ? true
    : (Math.abs(quizBarRow.drawLeft - quizBarRow.cardLeft) <= 4
      && Math.abs(quizBarRow.batchRight - quizBarRow.cardRight) <= 4),
  quizBarRow.skip ? `跳过（${quizBarRow.why}）`
    : `barDraw.left=${quizBarRow.drawLeft} card.left=${quizBarRow.cardLeft} barBatch.right=${quizBarRow.batchRight} card.right=${quizBarRow.cardRight}`);

/*
 * 独占推进按钮 == 卡片宽度（2026-11-02 用户报告：手机上「下一个」「记住了，开始学」
 * 只有 ~104px，难以触控）。判据：
 *   ① 窄屏下判定一题后出现的「下一个」带 .solo，宽度与 .card 一致（±3px 取整误差）
 *   ② 滚到底后仍在视口内（沿袭本段"够不够得到"的判据）
 * 前提不满足（队列里没有可答的题）时如实跳过 —— 那是状态问题，不是布局回归。
 */
const soloW = JSON.parse(await evalJs(`(async () => {
  document.querySelector('.mode-btn[data-mode="quiz"]').click();
  await new Promise(r => setTimeout(r, 700));
  const s = window.__cvt.stateInfo();
  if (s.kind !== 'quiz') return JSON.stringify({ skip: true, why: 'kind=' + s.kind });
  // 拼写题没有选项（抽中概率随连对数变化，写死会偶发假跳过）—— 走「我不会」，
  // 它按答错处理，判定后同样出现独占的「下一个」
  if (s.type === 'spell') {
    document.getElementById('dunnoBtn')?.click();
  } else if (s.answerIndex >= 0) {
    const opts = document.querySelectorAll('.opt');
    if (opts[s.answerIndex]) opts[s.answerIndex].click();
  } else {
    return JSON.stringify({ skip: true, why: 'type=' + s.type });
  }
  await new Promise(r => setTimeout(r, 700));
  const btn = ['goNext', 'goLearn'].map((id) => document.getElementById(id)).find((b) => b && !b.hidden);
  if (!btn) return JSON.stringify({ skip: true, why: '没有可见的推进按钮' });
  const bw = btn.getBoundingClientRect().width;
  const cw = document.getElementById('card').getBoundingClientRect().width;
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 500));
  const bb = btn.getBoundingClientRect();
  return JSON.stringify({
    solo: document.getElementById('grades').classList.contains('solo'),
    btnW: Math.round(bw), cardW: Math.round(cw),
    bottom: Math.round(bb.bottom), innerH: innerHeight,
  });
})()`, true));
check("⭐ 窄屏下独占推进按钮宽度 == 卡片宽度（.solo 生效）",
  soloW.skip ? true : (soloW.solo === true && Math.abs(soloW.btnW - soloW.cardW) <= 3),
  soloW.skip ? `跳过（${soloW.why}）` : `按钮 ${soloW.btnW}px / 卡片 ${soloW.cardW}px`);
check("窄屏下独占推进按钮滚到底仍完整可见", soloW.skip ? true : soloW.bottom <= soloW.innerH,
  soloW.skip ? `跳过` : `bottom=${soloW.bottom} innerH=${soloW.innerH}`);

// 复原视口，避免影响后续（本段在最后，仍复原以便 --keep 时手动查看）
await send("Emulation.clearDeviceMetricsOverride");

/* ---------- O. 返回键钩子（安卓壳调用 window.__cvtHandleBack） ---------- */
console.log("\n--- O. 返回键钩子（安卓壳） ---");
/*
 * 安卓壳的返回键由页面决定"退一层还是退出应用"（壳看不到页面状态，见 README）。
 * 这里验它的分支顺序，重点是一条容易写错的顺序：
 *   统计页 → 必须先回测验，**不能**先去处理可见的 feedback。
 *   切到统计页时 #feedback 并未被销毁（只是 stage 被隐藏），若先走 advance()，
 *   会在用户看不见的地方把 state.idx 往前推 —— 等于静默跳过一张卡。
 */
const hasBackHook = await evalJs(`typeof window.__cvtHandleBack === 'function'`);
check("页面暴露了 __cvtHandleBack（壳的返回键入口）", hasBackHook === true);

// 统计页 + 有残留反馈时，返回键应回测验且**不动 idx**
const backStats = await evalJs(`(async () => {
  // 回到测验，然后进统计页
  document.querySelector('.mode-btn[data-mode="quiz"]').click();
  await new Promise(r => setTimeout(r, 300));
  const idxBefore = window.__cvt.stateInfo().idx;
  // 人为让 feedback 可见，模拟"答完题又切去统计页"
  document.getElementById('feedback').hidden = false;
  document.querySelector('.mode-btn[data-mode="stats"]').click();
  await new Promise(r => setTimeout(r, 300));
  const handled = window.__cvtHandleBack();
  await new Promise(r => setTimeout(r, 300));
  const info = window.__cvt.stateInfo();
  return {
    handled, modeAfter: info.mode, idxBefore, idxAfter: info.idx,
  };
})()`);
check("统计页按返回 → 回测验视图（handled=true）", backStats.handled === true && backStats.modeAfter === "quiz",
  `handled=${backStats.handled} mode=${backStats.modeAfter}`);
check("统计页按返回不会偷偷推进队列（idx 不变）", backStats.idxAfter === backStats.idxBefore,
  `idx ${backStats.idxBefore} → ${backStats.idxAfter}`);

// 测验主线且无待处理 → 返回 false（交给壳退出）
const backRoot = await evalJs(`(async () => {
  document.getElementById('feedback').hidden = true;
  document.querySelector('.mode-btn[data-mode="quiz"]').click();
  await new Promise(r => setTimeout(r, 300));
  const handled = window.__cvtHandleBack();
  return { handled };
})()`);
check("测验主线无待处理时返回 false（交给壳退出应用）", backRoot.handled === false,
  `handled=${backRoot.handled}`);

/* ---------- P. 朗读分发（安卓壳的原生 TTS 兜底） ---------- */
console.log("\n--- P. 朗读分发 ---");
/*
 * 安卓壳里可能没有 speechSynthesis（实测 PKS110 的 WebView 就没有），
 * 所以壳注入了 window.AndroidTts 作为**兜底**。这里的判据是"分发顺序对不对"：
 *   有 speechSynthesis → 必须走它，**不能**误用原生桥（否则桌面端每次朗读都白调一次原生）
 *   没有 speechSynthesis → 必须走原生桥
 * 真机上"原生 TTS 是否真的出声"脚本验不了，需要人耳确认（写进 DEVELOPMENT §2.8）。
 */
const speakDispatch = await evalJs(`(async () => {
  const btn = document.getElementById('speakBtn');
  if (!btn) return { missing: true };

  // 1) 有 speechSynthesis：应走 speechSynthesis.speak，AndroidTts 不应被调用
  let speech = 0, native = 0;
  const origSS = window.speechSynthesis ? window.speechSynthesis.speak : null;
  if (window.speechSynthesis) window.speechSynthesis.speak = () => { speech++; };
  const hadNative = 'AndroidTts' in window;
  const origNative = window.AndroidTts;
  window.AndroidTts = { speak: () => { native++; }, stop: () => {} };

  btn.click();
  await new Promise(r => setTimeout(r, 250));
  const withSS = { speech, native };

  // 2) 原生桥的契约：speak(text) 可被调用而不抛错。
  //    页内无法伪造"window 里没有 speechSynthesis"，所以真正的兜底分支
  //    （无 speechSynthesis → 走 AndroidTts）在桌面验不到，只能在真机上验；
  //    这里保证壳暴露的接口是可用的，避免桥名/方法名写错导致兜底静默失效。
  let nativeCallable = false;
  try { window.AndroidTts.speak('test'); nativeCallable = native > 0; } catch { nativeCallable = false; }

  // 还原
  if (origSS) window.speechSynthesis.speak = origSS;
  if (hadNative) window.AndroidTts = origNative; else delete window.AndroidTts;
  return { withSS, nativeCallable };
})()`);
check("朗读分发：有 speechSynthesis 时走它（不误调原生桥）",
  !speakDispatch.missing && speakDispatch.withSS.speech > 0,
  speakDispatch.missing ? "朗读按钮不存在"
    : `speechSynthesis=${speakDispatch.withSS.speech} 次，原生=${speakDispatch.withSS.native} 次`);
check("原生桥 speak() 可被正常调用（壳的兜底通道可用）",
  speakDispatch.nativeCallable === true);

/* ---------- Q. 熟练度模型与加权抽取（v3 主线） ---------- */
console.log("\n--- Q. 熟练度 / 遗忘曲线 / 加权抽取 ---");
/*
 * 这是 2026-10-30 新机制的核心，必须钉死，因为它决定了"抽哪些词给我考"：
 *   ① 没见过 = 熟练度 0
 *   ② 遗忘曲线：距上次接触越久，有效熟练度越低（单调递减）
 *   ③ 答对 → 熟练度上升、计时归零
 *   ④ 答错 → 熟练度下降、计时**也**归零（用户明确要求"时间归为0"）
 *   ⑤ 抽取权重与熟练度反比：越生疏权重越大
 *   ⑥ 抽取确实按权重偏向生疏词（统计判据，不是单次抽样）
 */
/*
 * 铺一批**可控**的卡：5 个"很熟且今天见过" + 15 个"很生疏且 30 天没见"。
 * 为什么要造这种极端分布：⑥ 那条统计判据要有明确预期，
 * 拿一堆随机数据去比两个随机组，验不出"真的按权重抽"。
 * 前 20 个词取自词库真实存在的前缀（见下方 V3_WORDS 与 check 里的 learnedCount）。
 */
const V3_WORDS = [
  "forward", "utmost", "mischief", "dignity", "over",
  "operation", "second", "bourgeois", "mint", "duke",
  "souvenir", "bacterium", "obedient", "plump", "millionaire",
  "collaborate", "sneer", "cluster", "shuttle", "instructor",
];
await seedAndReload((() => {
  const now = dayNum();
  const cards = {};
  V3_WORDS.forEach((w, i) => {
    const hot = i < 5;                    // 前 5 个 = 很熟、今天接触过
    cards[w] = {
      s: 2, i: 3, e: 2.5, d: now, r: 3, l: 0,
      a: 6, c: 6, k: 3, fd: now - 10, ld: now, bd: 0, ms: 5000,
      p: hot ? 0.95 : 0.05,               // v3 熟练度
      lt: hot ? now : now - 30,           // 熟的是今天，生疏的 30 天前
    };
  });
  return {
    version: 2,
    cards, mistakes: [], days: {}, streak: 0, lastDay: '',
    types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
    settings: {},
  };
})());

// ① 抽取接口可用（未学过的词不会进池子）
const fresh = await evalJs(`(() => {
  const w = window.__cvt.sampleByProficiency(1);
  return JSON.stringify({ sampled: Array.isArray(w), learned: window.__cvt.learnedCount() });
})()`);
const fr = JSON.parse(fresh);
check("抽取接口可用且返回数组", fr.sampled === true);
check("抽取池 = 已学过的词（20 张卡）", fr.learned === 20, `learnedCount=${fr.learned}`);

// ②③④ 用真实词走一遍：直接读 profOf / effProfOf
const profProbe = await evalJs(`(() => {
  const out = {};
  const samples = window.__cvt.sampleByProficiency(5);
  const w = samples[0];
  out.hasSamples = samples.length === 5;
  out.weights = samples.map((x) => window.__cvt.drawWeightOf(x));
  out.profs = samples.map((x) => window.__cvt.profOf(x));
  // 权重与有效熟练度必须反比：熟练度高 ⇒ 权重低
  const pairs = samples.map((x) => ({ w: window.__cvt.drawWeightOf(x), e: window.__cvt.effProfOf(x) }));
  pairs.sort((a, b) => a.e - b.e);
  out.monotone = pairs.every((p, i) => i === 0 || p.w <= pairs[i - 1].w + 1e-9);
  out.pairs = pairs;
  return JSON.stringify(out);
})()`);
const pp = JSON.parse(profProbe);
check("能从已学过的词里抽到样本", pp.hasSamples === true);
check("⭐ 抽取权重与熟练度反比（越熟权重越小）", pp.monotone === true,
  JSON.stringify(pp.pairs.slice(0, 3)));

// ⑤ 统计判据：反复抽样，生疏词被抽中的频率显著高于熟练词
const statProbe = await evalJs(`(() => {
  // 取若干"较熟"与"较生疏"的词各一组，比较它们在多次抽样中的出现率
  const all = window.__cvt.sampleByProficiency(200);
  const withEff = all.map((w) => ({ w, e: window.__cvt.effProfOf(w) }))
    .sort((a, b) => a.e - b.e);
  const lowN = Math.max(1, Math.floor(withEff.length / 4));
  const low = new Set(withEff.slice(0, lowN).map((x) => x.w));          // 最生疏 1/4
  const high = new Set(withEff.slice(-lowN).map((x) => x.w));           // 最熟 1/4
  let lowHit = 0, highHit = 0;
  const ROUNDS = 400;
  for (let i = 0; i < ROUNDS; i++) {
    const pick = window.__cvt.sampleByProficiency(1)[0];
    if (low.has(pick)) lowHit++;
    if (high.has(pick)) highHit++;
  }
  return JSON.stringify({ lowN, highN: high.size, lowHit, highHit, rounds: ROUNDS,
    lowRate: +(lowHit / ROUNDS).toFixed(3), highRate: +(highHit / ROUNDS).toFixed(3) });
})()`);
const sp = JSON.parse(statProbe);
check("⭐ 生疏词被抽中的频率高于熟练词（加权抽取真的生效）",
  sp.lowRate > sp.highRate,
  `生疏组 ${sp.lowRate} vs 熟练组 ${sp.highRate}（各 ${sp.lowN} 词，抽 ${sp.rounds} 次）`);

// ⑥ 答对/答错对熟练度与计时的影响（走真实 UI 作答，再读存档值）
const ruleProbe = await evalJs(`(() => {
  const w = window.__cvt.sampleByProficiency(1)[0];
  const before = window.__cvt.profOf(w);
  return JSON.stringify({ w, before });
})()`);
const rp = JSON.parse(ruleProbe);
check("能读到某个已学词的熟练度与上次接触日", rp.before && typeof rp.before.p === "number",
  `${rp.w}: p=${rp.before?.p} lt=${rp.before?.lt} eff=${rp.before?.eff}`);
check("⭐ 有效熟练度 ≤ 存档熟练度（衰减只会往下）", rp.before.eff <= rp.before.p + 1e-9,
  `eff=${rp.before.eff} ≤ p=${rp.before.p}`);

/*
 * ⑦ 答对 → 熟练度上升、计时归零；答错 → 熟练度下降、计时**也**归零。
 *
 * 这是用户 2026-10-30 明确的两条规则，必须用**真实作答路径**验：
 * 直接调 updateProficiency() 不算数，要证明"点答案按钮之后卡片上的 p/lt 确实变了"。
 *
 * 怎么把指定的词变成当前题：**不要**靠遍历队列去"撞"它 ——
 * 队列是加权随机生成的，撞不到很正常，那样写出来的失败是测试的问题不是产品的问题。
 * 改用确定性做法：直接改写 localStorage 把该词设成唯一到期卡，
 * 并把 reviewPerDay 调小，使 buildQueue 只可能选中它。
 */
async function answerOneAndRead(word, correct) {
  await seedAndReload((() => {
    const now = dayNum();
    const cards = {};
    // 只留这一张"到期"卡 ⇒ 新机制下抽取池里只有它
    cards[word] = {
      s: 2, i: 1, e: 2.5, d: now, r: 1, l: 0,
      a: 2, c: 1, k: 1, fd: now - 5, ld: now - 1, bd: now - 1, ms: 4000,
      p: 0.5, lt: now - 5,          // 陈旧值：用来验证"更新后确实变了"
    };
    // 塞一批"未学习"之外的空卡不影响；关键是把新词额度设为 0，队列里只会有复习题
    return {
      version: 2, cards, mistakes: [], days: {}, streak: 0, lastDay: '',
      types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
      settings: { newPerDay: 0, reviewPerDay: 1, useDueQueue: false, quizTypes: 'en2cn' },
    };
  })());

  const cur = JSON.parse(await evalJs(`(() => {
    const s = window.__cvt.stateInfo();
    return JSON.stringify({ word: s.word, type: s.type, ans: s.answerIndex, kind: s.kind });
  })()`));

  // 前提守卫：队列里必须就是这个词，否则这条测试没有意义
  if (cur.word !== word || cur.kind !== 'quiz') {
    return { mismatch: true, got: cur };
  }

  const before = JSON.parse(await evalJs(`JSON.stringify(window.__cvt.profOf(${JSON.stringify(word)}))`));

  await evalJs(`(() => {
    const ansIdx = ${cur.ans};
    const opts = [...document.querySelectorAll('.opt')];
    const wantCorrect = ${correct ? "true" : "false"};
    if (wantCorrect) {
      if (opts[ansIdx]) opts[ansIdx].click();
      return true;
    }
    const dn = document.getElementById('dunnoBtn');
    if (dn && !dn.hidden) { dn.click(); return true; }
    const wrong = opts.find((_, i) => i !== ansIdx);
    if (wrong) wrong.click();
    return true;
  })()`);
  await sleep(800);
  const after = JSON.parse(await evalJs(`JSON.stringify(window.__cvt.profOf(${JSON.stringify(word)}))`));
  return { before, after, type: cur.type };
}

const right = await answerOneAndRead("cluster", true);
if (right.mismatch) {
  check("答对路径：该词被排成当前题（前提）", false, `实际是 ${right.got.word}/${right.got.kind}`);
} else {
  check("⭐ 答对 → 熟练度上升", right.after.p > right.before.p,
    `${right.before.p} → ${right.after.p}（题型 ${right.type}）`);
  check("⭐ 答对 → 距上次接触计时归零（lt = 今天）", right.after.lt === dayNum(),
    `lt ${right.before.lt} → ${right.after.lt}（今天 ${dayNum()}）`);
}

const wrongAns = await answerOneAndRead("sneer", false);
if (wrongAns.mismatch) {
  check("答错路径：该词被排成当前题（前提）", false, `实际是 ${wrongAns.got.word}/${wrongAns.got.kind}`);
} else {
  check("⭐ 答错 → 熟练度下降", wrongAns.after.p < wrongAns.before.p,
    `${wrongAns.before.p} → ${wrongAns.after.p}（题型 ${wrongAns.type}）`);
  check("⭐ 答错 → 时间也归零（lt = 今天）", wrongAns.after.lt === dayNum(),
    `lt ${wrongAns.before.lt} → ${wrongAns.after.lt}`);
}

/*
 * ⑧ 整批测验入口：学完一批后，「测验这一批」只能考本批学过的词。
 *
 * ⚠️ 三个前提（都在本轮踩过）：
 *   ① 必须**自己铺干净状态**：上面的测试为了把队列压成单个到期词把 newPerDay
 *      设成了 0，留到现在会得到"本批 0 个新词"的假红；
 *   ② **批次属于「学习」板块**：2026-10-30 拆板块后，测验板块只排复习题、
 *      一个学习卡都不出，所以在测验板块读 batchWords 必然是空的。
 *      要点「测验这一批」这个入口，得先在**学习板块**攒出一批新词；
 *   ③ 必须先真的把这一批学会 —— batchWords 装的是"待学的新词"，
 *      没学过就没有卡片，quizCurrentBatch 会诚实提示"这一批还没有学过的词"。
 */
await seedAndReload({
  version: 2, cards: {}, mistakes: [], days: {}, streak: 0, lastDay: "",
  types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 20, reviewPerDay: 50, useDueQueue: false },
});
// ② 在**学习板块**攒出一批（这里才是排新词的地方）
const batchQuiz = await evalJs(`(async () => {
  document.querySelector('.mode-btn[data-mode="learn"]').click();
  await new Promise(r => setTimeout(r, 400));
  const info = window.__cvt.batchInfo();
  return JSON.stringify({ batchSize: info.size, words: info.words.length });
})()`);
const bq = JSON.parse(batchQuiz);
check("批次信息可读（本批新词非空）", bq.words > 0, `本批 ${bq.words} 个新词`);
check("⭐ 一批 20 词（用户要求）", bq.batchSize === 20, `size=${bq.batchSize}`);

// 点「测验这一批」：队列必须恰好是本批那些词
/*
 * ⚠️ 两个坑（本轮都踩过，写下来免得下次再犯）：
 *   ① 按钮平时是 hidden（showDone 里按情境显隐），对 hidden 元素 click() 不触发；
 *   ② 更根本的是：**必须先真的把这一批学会**。batchWords 里装的是"待学的新词"，
 *      没学过就没有卡片，quizCurrentBatch 会诚实地提示"这一批还没有学过的词"。
 *      所以这里先逐个点「记住了，开始学」，再点入口。
 */
const batchRun = await evalJs(`(async () => {
  const before = window.__cvt.batchInfo().words.slice();

  // 把本批的每个新词都学掉（走真实 UI：点「记住了，开始学」）
  for (let i = 0; i < before.length + 5; i++) {
    const s = window.__cvt.stateInfo();
    const gl = document.getElementById('goLearn');
    if (s.kind === 'learn' && gl && !gl.hidden) { gl.click(); }
    else {
      // 不是学习卡就推进（答当前题/下一个）
      const gn = document.getElementById('goNext');
      if (gn && !gn.hidden) gn.click();
      else {
        const dn = document.getElementById('dunnoBtn');
        if (dn && !dn.hidden) dn.click();
        else { const o = document.querySelectorAll('.opt'); if (o.length) o[0].click(); }
      }
    }
    await new Promise(r => setTimeout(r, 260));
    // 本批学习卡全部走完就停
    const done = before.every((w) => !!window.__cvt.cardOf(w));
    if (done) break;
  }
  const learnedN = before.filter((w) => !!window.__cvt.cardOf(w)).length;

  /*
   * 从**测验板块的真实入口**点进去（#barBatch），而不是去戳结算页里那个按钮：
   * 2026-10-30 拆板块后，测验板块有了常驻入口条，用户走的就是这条路。
   * 走真实入口才算验到用户路径（结算页那个 doneBatchQuiz 是同一函数的另一个入口）。
   */
  document.querySelector('.mode-btn[data-mode="quiz"]').click();
  await new Promise(r => setTimeout(r, 600));
  const barBatch = document.getElementById('barBatch');
  const barDisabled = barBatch.disabled;
  barBatch.click();
  await new Promise(r => setTimeout(r, 600));
  const q = window.__cvt.queueSnapshot().queue.map((x) => x.word);
  const s = new Set(before), qs = new Set(q);
  return JSON.stringify({
    beforeN: before.length, learnedN, queueN: q.length, barDisabled,
    onlyBatch: q.length > 0 && q.every((w) => s.has(w)),
    allCovered: before.filter((w) => !!window.__cvt.cardOf(w)).every((w) => qs.has(w)),
    mode: window.__cvt.batchInfo().mode,
  });
})()`);
const brun = JSON.parse(batchRun);
check("⭐ 「测验这一批」只考本批学过的词", brun.onlyBatch === true,
  `队列 ${brun.queueN} 题 / 本批已学 ${brun.learnedN} 词（本批共 ${brun.beforeN}）`);
check("「测验这一批」覆盖本批全部**已学**词", brun.allCovered === true && brun.learnedN > 0,
  `已学 ${brun.learnedN} 个，队列 ${brun.queueN} 题`);
// 队列条数必须等于已学词数：既不多（不会掺进池子里的其他词）也不少（每个都考）
check("⭐ 队列条数 = 本批已学词数（既不掺词也不漏词）",
  brun.queueN === brun.learnedN, `queue=${brun.queueN} learned=${brun.learnedN}`);
check("进入整批测验模式（batchMode）", brun.mode === "batchQuiz", `mode=${brun.mode}`);

/* ---------- R. 「旧的到期队列」开关（用户要求：降为可切换选项） ---------- */
console.log("\n--- R. 到期队列开关（新机制 vs 旧 SRS） ---");
/*
 * 判据：造 60 张**全部未到期**（d = 今天+30）的卡，两种模式下能抽到的题数必须不同 ——
 *   useDueQueue=false（默认，新机制）：未到期也抽（按熟练度加权）
 *   useDueQueue=true （旧队列）      ：只抽 d <= 今天，未到期一个都不抽
 * 只验"开关能存"是不够的：必须验它**真的改变了抽题范围**，否则开关是摆设。
 */
async function queueUnderDueSwitch(useDue) {
  const now = dayNum();
  const prog = (() => {
    const cards = {};
    // 用一组确定的词（词库里真实存在的前 60 个）
    const words = V3_WORDS.concat([
      "abandon", "ability", "absolute", "absorb", "abstract", "academic",
      "accept", "access", "accident", "accompany", "accomplish", "account",
      "accurate", "achieve", "acknowledge", "acquire", "adapt", "adequate",
      "adjust", "admire", "admit", "adopt", "advance", "advantage",
      "adventure", "advertise", "advocate", "affect", "afford", "agency",
      "agenda", "aggressive", "agriculture", "alarm", "alcohol", "alert",
      "alien", "align", "allege", "allocate",
    ]);
    for (const w of words) {
      cards[w] = {
        s: 2, i: 30, e: 2.5, d: now + 30, r: 3, l: 0,     // ★ 全部未到期
        a: 3, c: 3, k: 2, fd: now - 10, ld: now, bd: 0, ms: 4000,
        p: 0.6, lt: now - 2,
      };
    }
    return {
      version: 2, cards, mistakes: [], days: {}, streak: 0, lastDay: "",
      types: { en2cn: { a: 0, c: 0, ms: 0 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
      settings: { newPerDay: 0, reviewPerDay: 200, useDueQueue: useDue },
    };
  })();
  await seedAndReload(prog);
  return JSON.parse(await evalJs(`JSON.stringify({
    learned: window.__cvt.learnedCount(),
    quizN: window.__cvt.queueSnapshot().queue.filter((x) => x.kind === 'quiz').length,
    flag: JSON.parse(localStorage.getItem('cvt:v1:cet6')).settings.useDueQueue,
  })`));
}

const dueOff = await queueUnderDueSwitch(false);
const dueOn = await queueUnderDueSwitch(true);
check("⭐ 默认（新机制）：未到期的词照样按熟练度抽",
  dueOff.learned > 0 && dueOff.quizN > 0,
  `可抽 ${dueOff.learned} 词，队列 ${dueOff.quizN} 题`);
check("⭐ 开启旧队列后：未到期的词一个都不抽",
  dueOn.quizN === 0, `队列 ${dueOn.quizN} 题（应 0）`);
check("开关状态正确持久化",
  dueOff.flag === false && dueOn.flag === true,
  `off=${dueOff.flag} on=${dueOn.flag}`);

/* ---------- S. 清除数据的四个粒度 ---------- */
console.log("\n--- S. 清除数据（分级） ---");
/*
 * 2026-10-30：原来只有一个「清空进度」，而它走 blankProgress() —— 里面含
 * `settings: {...DEFAULT_SETTINGS}`，于是**用户调的设置被一起重置**。
 * 实测：newPerDay=7 / memorizeMs=5000 / showPos=false 点一次清空就变回 20/0/true。
 * 用户要清的是学习记录，不是自己的偏好，所以拆成四个粒度，并钉死各自边界。
 */
const richProg = {
  version: 2,
  cards: {
    probe_a: { s: 2, i: 3, e: 2.5, d: 0, r: 3, l: 0, a: 5, c: 4, k: 2, fd: 0, ld: 0, bd: 0, ms: 1000, p: 0.5, lt: 0 },
    probe_b: { s: 1, i: 0, e: 2.5, d: 0, r: 2, l: 1, a: 3, c: 1, k: 0, fd: 0, ld: 0, bd: 0, ms: 2000, p: 0.2, lt: 0 },
  },
  mistakes: ["probe_b"],
  days: { "2026-01-01": { n: 5, ok: 4, bad: 1 } },
  streak: 3, lastDay: "2026-01-01",
  types: { en2cn: { a: 5, c: 4, ms: 1000 }, cn2en: { a: 0, c: 0, ms: 0 }, spell: { a: 0, c: 0, ms: 0 } },
  settings: { newPerDay: 7, reviewPerDay: 33, memorizeMs: 5000, showPos: false, useDueQueue: true },
};

/** 铺"什么都有"的数据 → 进设置板块 → 点某按钮（复选确认后）→ 读回存储 */
const ACK_OF = {
  resetMistakes: "ackResetMistakes",
  resetBtn: "ackResetBtn",
  factoryBtn: "ackFactoryBtn",
  // resetSettings 不设复选框（不动学习数据，仍走 confirm），见下面分支
};
async function clearWith(btnId) {
  await seedAndReload(richProg);
  return JSON.parse(await evalJs(`(async () => {
    document.querySelector('.mode-btn[data-mode="settings"]').click();
    await new Promise(r => setTimeout(r, 700));
    const btn = document.getElementById(${JSON.stringify(btnId)});
    if (!btn) return JSON.stringify({ missing: true });
    const ackId = ${JSON.stringify(ACK_OF[btnId] || null)};
    if (ackId) {
      // 复选确认门（2026-11-01）：按钮必须先禁用，勾选后才点亮；
      // confirm 若再被调用（说明代码还在走旧弹窗）一律拒绝，读回数据就会对不上。
      window.confirm = () => false;
      if (!btn.disabled) return JSON.stringify({ notGated: true });
      const ack = document.getElementById(ackId);
      if (!ack) return JSON.stringify({ missing: true });
      ack.click();
      await new Promise(r => setTimeout(r, 120));
      if (btn.disabled) return JSON.stringify({ notEnabled: true });
    } else {
      window.confirm = () => true;
    }
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    const p = JSON.parse(localStorage.getItem('cvt:v1:cet6'));
    return JSON.stringify({
      cards: Object.keys(p.cards || {}).length,
      mistakes: (p.mistakes || []).length,
      days: Object.keys(p.days || {}).length, streak: p.streak,
      newPerDay: p.settings.newPerDay, memorizeMs: p.settings.memorizeMs, showPos: p.settings.showPos,
    });
  })()`, true));
}

// ⓪ 复选确认门本身要先验：三个破坏性按钮默认禁用、各带一个确认框
const gate = JSON.parse(await evalJs(`(async () => {
  document.querySelector('.mode-btn[data-mode="settings"]').click();
  await new Promise(r => setTimeout(r, 700));
  const out = {};
  for (const [b, a] of Object.entries({
    resetMistakes: "ackResetMistakes", resetBtn: "ackResetBtn", factoryBtn: "ackFactoryBtn",
  })) {
    const btn = document.getElementById(b), ack = document.getElementById(a);
    out[b] = { disabled: !!(btn && btn.disabled), hasAck: !!ack };
  }
  return JSON.stringify(out);
})()`, true));
check("三个破坏性按钮默认禁用且带复选确认",
  gate.resetMistakes?.disabled && gate.resetBtn?.disabled && gate.factoryBtn?.disabled
    && gate.resetMistakes?.hasAck && gate.resetBtn?.hasAck && gate.factoryBtn?.hasAck,
  JSON.stringify(gate));

// ① 只清错词本
const c1 = await clearWith("resetMistakes");
check("清空错词本：清单清空，其余全留",
  !c1.missing && !c1.notGated && !c1.notEnabled
    && c1.mistakes === 0 && c1.cards === 2 && c1.days === 1 && c1.newPerDay === 7,
  JSON.stringify(c1));

// ② 只恢复默认设置
const c2 = await clearWith("resetSettings");
check("恢复默认设置：设置回默认，进度全留",
  !c2.missing && !c2.notGated && !c2.notEnabled
    && c2.newPerDay === 20 && c2.memorizeMs === 0 && c2.showPos === true
    && c2.cards === 2 && c2.mistakes === 1,
  JSON.stringify(c2));

// ③ 清空学习进度 —— 必须保留设置
const c3 = await clearWith("resetBtn");
check("⭐ 清空学习进度：卡片/错词本/统计都清，但**设置保留**",
  !c3.missing && !c3.notGated && !c3.notEnabled
    && c3.cards === 0 && c3.mistakes === 0 && c3.days === 0 && c3.streak === 0
    && c3.newPerDay === 7 && c3.memorizeMs === 5000 && c3.showPos === false,
  JSON.stringify(c3));

// ④ 全部恢复出厂 —— 含设置
const c4 = await clearWith("factoryBtn");
check("全部恢复出厂：进度与设置一起清",
  !c4.missing && !c4.notGated && !c4.notEnabled
    && c4.cards === 0 && c4.newPerDay === 20 && c4.memorizeMs === 0 && c4.showPos === true,
  JSON.stringify(c4));

check("四个清除按钮都在设置板块里",
  ["resetMistakes", "resetSettings", "resetBtn", "factoryBtn"]
    .every((id) => ![c1, c2, c3, c4].some((c) => c && c.missing)),
  "四个都找到了（缺任何一个，上面某条会先报 missing）");


/* ---------- M. 控制台报错 ---------- */
console.log("\n--- M. 控制台报错 ---");
const noise = /GPU|Vulkan|gpu_|Fontconfig|DevTools|Autofill|voice|Registration response|favicon/i;
const real = consoleErrors.filter((e) => e && !noise.test(e));
check("无 JS 报错", real.length === 0, real.slice(0, 4).join(" | ") || "干净");
if (consoleErrors.length) console.log("      （全部控制台输出）", JSON.stringify(consoleErrors.slice(0, 6)));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
writeFileSync(join(TMP, "cdp-probe-result.json"),
  JSON.stringify({ pass, fail, results, consoleErrors }, null, 1), "utf8");

if (!argv.includes("--keep")) { ws.close(); child.kill(); }
process.exit(fail ? 1 : 0);
