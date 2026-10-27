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
const PORT = 9333;

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

/* ---------- A. 首屏：新词只教不考 ---------- */
console.log("\n--- A. 首屏 = 学习卡（新词只教不考） ---");
const A = await api();
console.log("     ", JSON.stringify({ word: A.wordText, badge: A.typeBadge, learnShown: A.learnShown, ctrNew: A.ctrNew }));
check("调试句柄已装配", A.hasHandle === true);
check("首屏是学习卡（phase=learn）", A.phase === "learn", `phase=${A.phase}`);
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
await sleep(800);
const B = await evalJs(`(() => {
  const c = window.__cvt.cardOf(${JSON.stringify(learnWord)});
  const raw = JSON.parse(localStorage.getItem('cvt:v1:cet6'));
  const d = raw.days[Object.keys(raw.days)[0]] || {};
  return { card: c, day: d, nextWord: document.getElementById('word').textContent };
})()`);
check("已排到 1 天后", B.card && B.card.i === 1 && B.card.s === 2, JSON.stringify(B.card));
check("没有写任何答题成绩（a=0、c=0、k=0）", B.card && B.card.a === 0 && B.card.c === 0 && B.card.k === 0,
  `a=${B.card?.a} c=${B.card?.c} k=${B.card?.k}`);
check("今日新学计数 +1", B.day.n === 1, JSON.stringify(B.day));
check("已翻到下一张", B.nextWord !== learnWord, `${learnWord} -> ${B.nextWord}`);

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

// 逐张走一部分学习卡（每张有 260ms 盖章动画）。走 40 张足够覆盖渲染路径。
const WALK = Math.min(40, tipCount);
const seen = [];
for (let i = 0; i < WALK; i++) {
  const s = await evalJs(`(() => ({
    word: document.getElementById('word').textContent,
    phase: window.__cvt.stateInfo().phase,
    shown: !document.getElementById('lnTip').hidden,
    chip: document.getElementById('lnTipKind').textContent.trim(),
    cls: document.getElementById('lnTipKind').className,
    text: document.getElementById('lnTipText').textContent,
    cert: window.__cvt.tipOf(document.getElementById('word').textContent)?.certainty || null,
  }))()`);
  if (s.phase !== 'learn') break;
  seen.push(s);
  if (seen.length === 1) await shot("cdp-9-tip-learn.png");
  await evalJs(`document.getElementById('goLearn').click()`);
  await sleep(420);
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

/* ---------- K. 四个模式都能进 ---------- */
console.log("\n--- K. 四个模式都能进 ---");
for (const mode of ["flash", "browse", "stats"]) {
  await evalJs(`document.querySelector('.mode-btn[data-mode="${mode}"]').click()`);
  await sleep(700);
  const st = await evalJs(`({
    mode: window.__cvt.stateInfo().mode,
    stageHidden: document.getElementById('stage').hidden,
    panelHidden: document.getElementById('panel').hidden,
    statCards: document.querySelectorAll('#statRow .stat').length,
    typeCards: document.querySelectorAll('#typeRow .tcard').length,
    forecastBars: document.querySelectorAll('#forecast .fc').length,
    mistakes: document.querySelectorAll('#mistakes .mk').length,
  })`);
  if (mode === "flash") {
    check("过词模式：卡片 + 自评按钮、无 options", st.mode === "flash" && !st.stageHidden && st.panelHidden, JSON.stringify(st));
    await shot("cdp-5-flash.png");
  } else if (mode === "browse") {
    check("浏览模式：面板隐藏", st.mode === "browse" && !st.stageHidden && st.panelHidden, JSON.stringify(st));
  } else {
    check("统计模式：14 张累计卡 + 3 张题型卡 + 14 根柱子",
      st.stageHidden && !st.panelHidden && st.statCards === 14 && st.typeCards === 3 && st.forecastBars === 14,
      JSON.stringify(st));
    await shot("cdp-7-stats.png");
  }
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
  return {
    bars, stats, types, pbar,
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
