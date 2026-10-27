/* ============================================================
   四六级词汇刷词器 —— 应用逻辑（v2：客观判分）
   零依赖 ES 模块。进度存 localStorage。

   为什么改成客观判分
   ------------------
   v1 是「看英文 → 翻出中文 → 自己打分」。那是**再认**：看到答案才觉得
   "这个我会"。熟悉感不等于回忆，而且你没法证伪自己 —— 自评几乎永不失败。

   v2 的判分逻辑（本文件的核心，写在最前面以便审阅）
   ------------------------------------------------
   ① 档位判定（`gradeOf`）
        答错                        → 不认识(0)
        拼写题答对                  → 认识(2)   ← 能整词打对是硬证据，打字慢不算不会
        选择题答对，但本轮这个词答错过 → 模糊(1)   ← 防「刚看完答案就当自己会」
        选择题答对，但答得超时        → 模糊(1)   ← 防「犹豫着排除到最后一个」
        其余答对                    → 认识(2)
   ② 成绩单（卡片上的 a/c/k/fd/ld/ms）与排期**分开记**：排期管"什么时候再问"，
      成绩单管"给你看证据"。
   ③ 「记住了」是**硬判据**：连对 ≥3 次 **且** 这 3 次跨了至少两天。
      单次答对不算 —— 4 选 1 本来就有 25% 蒙对率。
   ④ 新词第一次只「教」不「考」：从没见过的词让你 4 选 1 是纯蒙，测不出东西。
   ============================================================ */

const DAY = 86400000;
const STORE_KEY = (wbId) => `cvt:v1:${wbId}`;   // v1 的 key 不变，内部做字段迁移
const PROGRESS_VERSION = 2;
const MAX_INTERVAL = 365;
const EASE_MIN = 1.3, EASE_MAX = 2.8;

const STATE = { NEW: 0, LEARNING: 1, REVIEW: 2 };
const STATE_LABEL = { 0: '新词', 1: '学习中', 2: '复习中' };
const STATE_CLASS = { 0: 'st-new', 1: 'st-learn', 2: 'st-rev' };

const QTYPES = ['en2cn', 'cn2en', 'spell'];
const QT_LABEL = { en2cn: '英 → 中', cn2en: '中 → 英', spell: '拼写' };
const QT_DESC = {
  en2cn: '看英文，选出正确的中文释义',
  cn2en: '看中文释义，选出正确的英文单词',
  spell: '看中文释义，把英文单词完整打出来',
};

/** 慢答阈值（只有选择题用；拼写题不打字速度分） */
const SLOW_MS = { en2cn: 10000, cn2en: 10000 };

/**
 * 助记技巧的类别标签。**必须显示出来** —— 这类功能最大的坑是把编造的词源
 * 当成事实教给学生；标了类别，学习者才知道哪条能用来推断别的词、哪条只是记音钩子。
 */
const TIP_KIND = {
  root: '词根词缀', family: '家族词', sense: '义项串联', story: '词源故事',
  sound: '谐音助记', image: '画面联想', usage: '搭配用法',
};

/**
 * 助记的确定度。**徽记的颜色由它决定，不由类别决定** ——
 * 用户真正要一眼看出的是「这条能不能信」，而不是「这是什么流派」。
 *   high   拆出来的成分在词里看得见，能担保含义（可拿去推同族词）
 *   medium 事实可靠但词形里看不见（历史演变/命名由来）
 *   low    纯联想（谐音/画面），只为帮你记住，不声称任何事实
 */
const TIP_CERT = { high: '确证', medium: '可信', low: '联想' };

/** 「记住了」的硬判据 */
const MASTER_STREAK = 3;

function localDayNum(d = new Date()) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}
function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayToLabel(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function shuffle(a, rng = Math.random) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
/** 拼写比较用：忽略大小写、空格、连字符、撇号，并允许多种合法写法 */
function spellForms(word) {
  const w = String(word).toLowerCase();
  const base = w.replace(/\([a-z]+\)/g, '');           // onward(s) → onward
  const set = new Set([w, base]);
  for (const v of [w, base]) {
    set.add(v.replace(/[^a-z]/g, ''));                 // second-hand / by-product
    set.add(v.replace(/[-']/g, ''));
  }
  return [...set].filter(Boolean);
}
function normTyped(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z]/g, '');
}

/* ---------------- 存储 ---------------- */
const DEFAULT_SETTINGS = {
  newPerDay: 20, reviewPerDay: 200,
  quizTypes: 'mix', timeGate: true,
  memorizeMs: 0,             // 答对后的记忆停顿；0 = 手动（等你按空格）
  autoSpeak: false, showPos: true,
};

function blankProgress() {
  return {
    version: PROGRESS_VERSION,
    cards: {},
    mistakes: [],
    days: {},                  // 'YYYY-MM-DD' -> { n, ok, bad }
    types: {                   // 题型成绩单
      en2cn: { a: 0, c: 0, ms: 0 },
      cn2en: { a: 0, c: 0, ms: 0 },
      spell: { a: 0, c: 0, ms: 0 },
    },
    streak: 0,
    lastDay: '',
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** 当前进度（boot 时按词库 id 载入） */
let progress = blankProgress();

function migrateCard(c) {
  // v1 的卡只有 s/i/e/d/r/l；补上客观成绩单字段（默认「还没考过」）
  c.a = c.a || 0; c.c = c.c || 0; c.k = c.k || 0;
  c.fd = c.fd || 0; c.ld = c.ld || 0; c.bd = c.bd || 0; c.ms = c.ms || 0;
  return c;
}

function loadProgress(wbId) {
  try {
    const raw = localStorage.getItem(STORE_KEY(wbId));
    if (!raw) return blankProgress();
    const p = JSON.parse(raw);
    const out = {
      ...blankProgress(), ...p,
      settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) },
      cards: p.cards || {},
      days: p.days || {},
      mistakes: Array.isArray(p.mistakes) ? p.mistakes : [],
      types: { ...blankProgress().types, ...(p.types || {}) },
    };
    // 旧 days 迁移：{ n, r, a } → { n, ok, bad }
    for (const k of Object.keys(out.days)) {
      const d = out.days[k] || {};
      out.days[k] = { n: d.n || 0, ok: d.ok ?? d.r ?? 0, bad: d.bad ?? d.a ?? 0 };
    }
    for (const k of Object.keys(out.cards)) migrateCard(out.cards[k]);
    // 旧 mistakes 若不在词库里也不清（保留用户痕迹），显示时再过滤
    out.version = PROGRESS_VERSION;
    return out;
  } catch (e) {
    console.warn('进度读取失败，已重置为空进度', e);
    return blankProgress();
  }
}

let saveTimer = null;
function saveProgress() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushProgress, 120);
}
function flushProgress() {
  try {
    localStorage.setItem(STORE_KEY(state.wbId), JSON.stringify(progress));
  } catch (e) {
    toast('进度保存失败：浏览器存储空间可能已满');
    console.error(e);
  }
}

function bumpDay(field, n = 1) {
  const k = todayKey();
  const rec = (progress.days[k] ||= { n: 0, ok: 0, bad: 0 });
  rec[field] = (rec[field] || 0) + n;
  if (progress.lastDay !== k) {
    const y = new Date(); y.setDate(y.getDate() - 1);
    progress.streak = progress.days[todayKey(y)] ? (progress.streak || 0) + 1 : 1;
    progress.lastDay = k;
  }
}

/* ---------------- 调度 ---------------- */
const getCard = (word) => progress.cards[word] || null;

/** 「记住了」的硬判据：连对 ≥3 次，且这几次跨了至少两天 */
function isMastered(card) {
  return !!card && (card.k || 0) >= MASTER_STREAK && (card.ld || 0) > (card.fd || 0);
}

/**
 * 按档位更新排期。g: 0=不认识 1=模糊 2=认识
 * ⚠️ 只改「什么时候再问」；客观成绩单由 recordAnswer 负责，两者刻意分开。
 */
function schedule(word, g) {
  const today = localDayNum();
  let c = getCard(word);
  const isNew = !c;
  if (isNew) c = progress.cards[word] = { s: STATE.NEW, i: 0, e: 2.5, d: today, r: 0, l: 0 };
  migrateCard(c);

  if (g === 0) {
    c.s = STATE.LEARNING;
    c.i = 0;
    c.d = today;
    c.l = (c.l || 0) + 1;
    c.e = clamp(c.e - 0.25, EASE_MIN, EASE_MAX);
    if (!progress.mistakes.includes(word)) progress.mistakes.push(word);
  } else if (g === 1) {
    c.s = STATE.REVIEW;
    c.i = c.i > 0 ? Math.max(1, Math.round(c.i * 1.2)) : 1;
    c.e = clamp(c.e - 0.15, EASE_MIN, EASE_MAX);
    c.d = today + c.i;
  } else {
    c.s = STATE.REVIEW;
    c.i = c.i > 0 ? clamp(Math.round(c.i * c.e), c.i + 1, MAX_INTERVAL) : 1;
    c.e = clamp(c.e + 0.05, EASE_MIN, EASE_MAX);
    c.d = today + c.i;
    const mi = progress.mistakes.indexOf(word);
    if (mi >= 0 && c.i >= 7) progress.mistakes.splice(mi, 1);
  }
  c.r = (c.r || 0) + 1;
  c.t = today;
  return c;
}

/** 新词首见：只排期 1 天，不写任何客观成绩（还没考过） */
function scheduleFirstLearn(word) {
  const today = localDayNum();
  const c = progress.cards[word];
  if (c) return c;
  const card = { s: STATE.REVIEW, i: 1, e: 2.5, d: today + 1, r: 1, l: 0, t: today };
  migrateCard(card);
  progress.cards[word] = card;
  return card;
}

/**
 * 把一次作答写进客观成绩单。
 * @param {'en2cn'|'cn2en'|'spell'} type
 */
function recordAnswer(word, type, correct, grade, elapsedMs) {
  const c = migrateCard(getCard(word) || (progress.cards[word] = {
    s: STATE.LEARNING, i: 0, e: 2.5, d: localDayNum(), r: 0, l: 0,
  }));
  const today = localDayNum();

  c.a = (c.a || 0) + 1;
  c.ms = (c.ms || 0) + Math.max(0, Math.min(elapsedMs || 0, 600000));
  if (correct) {
    c.c = (c.c || 0) + 1;
    c.ld = today;
    if (!c.fd) c.fd = today;
    if (grade === 2) c.k = (c.k || 0) + 1;   // 只有「一次答对且不犹豫」才算连对
    // grade===1（刚看过答案 / 犹豫）：连对既不增加也不清零 —— 犹豫不倒退，但也不给分
  } else {
    c.k = 0;
    c.bd = today;
  }

  const t = (progress.types[type] ||= { a: 0, c: 0, ms: 0 });
  t.a++; t.ms += Math.max(0, Math.min(elapsedMs || 0, 600000));
  if (correct) t.c++;
}

/** 档位判定 —— 见文件头 ① */
function gradeOf(correct, type, word, elapsedMs) {
  if (!correct) return 0;
  if (type === 'spell') return 2;                                   // 拼写对就是硬证据
  if (state.sessionWrong.has(word)) return 1;                       // 本轮刚看过答案
  if (progress.settings.timeGate && elapsedMs > (SLOW_MS[type] || 1e9)) return 1;
  return 2;
}

/* ---------------- 题目生成 ---------------- */
/**
 * 抽 3 个干扰项。要求：
 *  1. 选项文本**必须互不相同**，也不能与正确答案相同（否则有两个正确选项）
 *  2. 优先同词性、再优先长度接近 —— 让你不能靠"长度/词性"排除
 *  3. 从「最接近的一批」里随机取，避免长期固定搭配被记住
 */
function pickDistractors(entry, keyFn, n) {
  const target = keyFn(entry);
  const posSet = new Set(entry.pos || []);
  const seen = new Set([target]);
  const same = [], other = [];
  for (const e of state.wb.words) {
    if (e.word === entry.word) continue;
    const k = keyFn(e);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const item = { key: k, d: Math.abs(k.length - target.length) };
    ((e.pos || []).some((p) => posSet.has(p)) ? same : other).push(item);
  }
  const out = [];
  for (const bucket of [same, other]) {
    const pool = bucket.slice().sort((a, b) => a.d - b.d).slice(0, 40);
    while (out.length < n && pool.length) {
      out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0].key);
    }
    if (out.length >= n) break;
  }
  return out.slice(0, n);
}

function buildQuestion(word, type) {
  const entry = state.byWord.get(word);
  if (!entry) return null;
  if (type === 'spell') return { type, word, entry, options: null, answerIndex: -1 };
  const keyFn = type === 'en2cn' ? (e) => e.def : (e) => e.word;
  const correct = keyFn(entry);
  const options = shuffle([correct, ...pickDistractors(entry, keyFn, 3)]);
  return { type, word, entry, options, answerIndex: options.indexOf(correct) };
}

/** 智能选题型：新词先认读，连对越多越往「产出」走 */
function pickType(card) {
  const s = progress.settings.quizTypes;
  if (s !== 'mix') return s;
  if (!card || card.s !== STATE.REVIEW) return 'en2cn';
  const k = card.k || 0;
  if (k >= 2 && Math.random() < 0.34) return 'spell';
  if (k >= 1 && Math.random() < 0.45) return 'cn2en';
  return 'en2cn';
}

/* ---------------- 应用状态 ---------------- */
const state = {
  wbId: null, wb: null, byWord: new Map(),
  tips: new Map(),            // 首词 → { kind, tip }；词库与助记分开存（重新提取词库不会冲掉助记）
  mode: 'quiz',
  queue: [], idx: 0,
  phase: 'asking',            // asking | answered | learn
  question: null,
  questionStart: 0,
  picked: null,
  grade: null,
  sessionWrong: new Set(),
  requeued: new Map(),
  advanceToken: 0,
  autoTimer: null,
  flashRevealed: false,
  browse: { order: [], i: 0 },
  done: false,
  stats: { ok: 0, bad: 0 },   // 本轮计数
};

/* ---------------- 队列 ---------------- */
function buildQueue(opts = {}) {
  const today = localDayNum();
  const st = progress.settings;
  const all = state.wb.words.map((w) => w.word);
  const pool = opts.onlyMistakes
    ? all.filter((w) => progress.mistakes.includes(w))
    : all;

  const learning = [], review = [], fresh = [];
  for (const w of pool) {
    const c = getCard(w);
    if (!c) fresh.push(w);
    else if (c.s === STATE.LEARNING) learning.push(w);
    else if (c.d <= today) review.push(w);
  }

  const learnedToday = progress.days[todayKey()]?.n || 0;
  const newBudget = opts.onlyMistakes ? fresh.length : Math.max(0, st.newPerDay - learnedToday);
  const reviewBudget = opts.onlyMistakes ? learning.length + review.length : st.reviewPerDay;

  const chosenNew = shuffle(fresh).slice(0, newBudget);
  const chosenReview = shuffle([...learning, ...review]).slice(0, reviewBudget);

  const q = [];
  let a = 0, b = 0;
  while (a < chosenReview.length || b < chosenNew.length) {
    for (let k = 0; k < 3 && a < chosenReview.length; k++) {
      const w = chosenReview[a++];
      q.push({ word: w, kind: 'quiz', type: pickType(getCard(w)) });
    }
    if (b < chosenNew.length) q.push({ word: chosenNew[b++], kind: 'learn' });
  }

  state.queue = q;
  state.idx = 0;
  state.sessionWrong = new Set();
  state.requeued = new Map();
  state.stats = { ok: 0, bad: 0 };
  state.done = false;
  return { ...summarizePool(pool), q };
}

function summarizePool(pool) {
  const today = localDayNum();
  let fresh = 0, learning = 0, review = 0;
  for (const w of pool) {
    const c = getCard(w);
    if (!c) fresh++;
    else if (c.s === STATE.LEARNING) learning++;
    else if (c.d <= today) review++;
  }
  return { fresh, learning, review };
}

/* ---------------- 渲染 ---------------- */
function currentItem() {
  if (state.mode === 'browse') {
    const w = state.browse.order[state.browse.i];
    return w ? { word: w, kind: 'browse' } : null;
  }
  return state.queue[state.idx] || null;
}

function setTypeBadge(text, cls) {
  const el = $('typeBadge');
  el.textContent = text;
  el.className = `type-badge ${cls || ''}`;
}

function renderCard() {
  const item = currentItem();
  const card = $('card');
  if (!item) { showDone(); return; }
  $('done').hidden = true;
  card.hidden = false;

  clearTimeout(state.autoTimer);
  const meta = state.byWord.get(item.word) || { word: item.word, def: '', pos: [], page: null };
  const rec = getCard(item.word);

  // 每张卡都重置一次可见块
  const isLearn = item.kind === 'learn';
  const isBrowse = item.kind === 'browse';
  const isFlash = state.mode === 'flash';
  state.phase = isLearn ? 'learn' : 'asking';
  state.question = null;
  state.picked = null;
  state.grade = null;
  state.flashRevealed = false;

  $('word').textContent = meta.word;
  const w = $('word');
  w.style.animation = 'none'; void w.offsetWidth; w.style.animation = '';
  $('promptCn').hidden = true;
  $('learnNote').hidden = true;
  $('options').hidden = true;
  $('options').innerHTML = '';
  $('spellBox').hidden = true;
  $('dunnoRow').hidden = true;
  $('feedback').hidden = true;
  $('feedback').className = 'feedback';
  $('fbNote').innerHTML = '';
  $('fbHold').innerHTML = '';
  $('lnTip').hidden = true;
  $('fbTip').hidden = true;
  $('spellInput').value = '';
  $('spellInput').disabled = false;
  $('spellInput').className = '';
  $('spellSubmit').disabled = false;
  $('goNext').hidden = true;
  $('goFlashBad').hidden = true;
  $('goFlashMeh').hidden = true;
  $('goFlashGood').hidden = true;

  const badges = $('posBadges');
  badges.innerHTML = '';
  if (progress.settings.showPos) {
    for (const p of meta.pos || []) {
      const s = document.createElement('span');
      s.className = 'pos-badge'; s.textContent = p;
      badges.appendChild(s);
    }
  }

  setStateLabel(rec, isLearn);
  $('cardPage').textContent = meta.page ? `原书 p.${meta.page}` : '';
  $('cardReps').textContent = rec
    ? `答过 ${rec.a || 0} 次 · 对 ${rec.c || 0} · 连对 ${rec.k || 0}${isMastered(rec) ? ' · 已记住' : ''}`
    : '首次接触';

  // 源书词性标错 / 漏收义项时，明确告诉你「应用与书不一致」，并给出书本原文
  const fixEl = $('fixNote');
  if (meta.entry_fix) {
    fixEl.hidden = false;
    fixEl.innerHTML = `⚠ 本条已修正：原书写作「${escapeHtml(meta.source_def || '')}」` +
      `${(meta.source_pos || []).length ? `（词性 ${escapeHtml((meta.source_pos || []).join('/'))}）` : ''}` +
      ` —— 词性或常用义项不全，这里已补齐。`;
  } else {
    fixEl.hidden = true;
  }

  if (isLearn) {
    // ---- 新词首见：只教不考 ----
    setTypeBadge('新词 · 先看一遍', 't-learn');
    $('learnNote').hidden = false;
    $('learnNote').dataset.hidden = '0';
    $('lnTitle').textContent = '这是新词，先看一遍';
    $('lnDef').textContent = meta.def || '（此条无释义）';
    $('lnSub').innerHTML = '看完点「记住了，开始学」—— 明天它才会作为测验题出现。<br>' +
      '从没见过的词让你 4 选 1 是纯蒙，测不出东西，所以第一次只教不考。';
    fillTip('ln', item.word);
    $('goLearn').hidden = false;
    if (progress.settings.autoSpeak) speak(meta.word);
  } else if (isFlash || isBrowse) {
    // ---- 过词 / 浏览：自评，不计成绩 ----
    setTypeBadge(isFlash ? '快速过词 · 不计成绩' : '乱序浏览', isFlash ? 't-flash' : 't-flash');
    $('learnNote').hidden = false;
    $('learnNote').dataset.hidden = '1';
    $('lnTitle').textContent = '释义（按空格揭示）';
    $('lnDef').textContent = meta.def || '（此条无释义）';
    $('lnSub').textContent = isFlash
      ? '过词模式只标记错词，不改排期、不进成绩单。想真正验证记住了没有，请用「测验」。'
      : '浏览模式只用来过一遍词表，标记的错词会进错词本。';
    fillTip('ln', item.word);
    if (isFlash) {
      $('goFlashBad').hidden = false;
      $('goFlashMeh').hidden = false;
      $('goFlashGood').hidden = false;
    }
    updateBrowseMark();
  } else {
    // ---- 测验：客观判分 ----
    const q = buildQuestion(item.word, item.type || 'en2cn');
    state.question = q;
    state.questionStart = performance.now();
    setTypeBadge(`${QT_LABEL[q.type]} · ${QT_DESC[q.type]}`, `t-${q.type}`);
    if (q.type === 'en2cn') {
      renderOptions(q);
    } else if (q.type === 'cn2en') {
      $('word').hidden = true;
      $('promptCn').hidden = false;
      // 释义本身已含词性（`n.调皮，捣蛋`），不再重复挂词性徽记
      $('promptCn').textContent = meta.def;
      renderOptions(q);
    } else {
      $('word').hidden = true;
      $('promptCn').hidden = false;
      $('promptCn').textContent = meta.def;
      $('spellBox').hidden = false;
      setTimeout(() => $('spellInput').focus(), 60);
    }
    // 「我不会」：不让你被迫瞎蒙（三种题型共用这一个入口）
    $('dunnoRow').hidden = false;
  }
  // 只有「英→中」把英文词当题干；其余两种题型由中文释义当题干
  $('word').hidden = !!(state.question && state.question.type !== 'en2cn');

  // 底部按钮
  $('grades').hidden = false;
  if (isFlash || isBrowse) {
    $('grades').classList.remove('locked');
  } else {
    $('goNext').hidden = true;
  }
  $('browseNav').hidden = !isBrowse;
  $('hint').textContent = hintText(item);
  $('kbdHint').innerHTML = kbdHintHtml(item);
  updateRail();
  updateCounters();
}

function setStateLabel(rec, isLearn) {
  const el = $('cardState');
  // 学习卡的题型徽记已经写着「新词 · 先看一遍」，这里不再重复
  if (isLearn) { el.textContent = ''; el.className = 'card-state'; return; }
  const c = rec;
  if (isMastered(c)) { el.textContent = '已记住'; el.className = 'card-state st-rev'; return; }
  const s = c ? c.s : STATE.NEW;
  el.textContent = c && c.s === STATE.REVIEW && c.i >= 21 ? '复习中 · 长间隔'
    : c && c.s === STATE.REVIEW ? `复习中 · ${c.i}天`
    : STATE_LABEL[s];
  el.className = `card-state ${STATE_CLASS[s]}`;
}

/** 快捷键提示随模式与阶段变化，避免显示当前按了没用的键 */
function kbdHintHtml(item) {
  if (!item) return '';
  if (item.kind === 'learn') return '<kbd>空格</kbd> 记住了，开始学 · <kbd>S</kbd> 朗读';
  if (state.mode === 'flash') {
    return state.flashRevealed
      ? '<kbd>1</kbd> 不认识 · <kbd>2</kbd> 模糊 · <kbd>3</kbd> 认识 · <kbd>S</kbd> 朗读'
      : '<kbd>空格</kbd> 揭示释义 · <kbd>S</kbd> 朗读';
  }
  if (state.mode === 'browse') return '<kbd>空格</kbd> 显示释义 · <kbd>←</kbd> <kbd>→</kbd> 翻页 · <kbd>S</kbd> 朗读';
  if (state.phase === 'answered') return '<kbd>空格</kbd> 下一个（答案会一直留着）· <kbd>S</kbd> 再听一遍';
  const q = state.question;
  if (!q) return '';
  if (q.type === 'spell') return '打完按 <kbd>回车</kbd> 提交 · <kbd>0</kbd> 我不会 · <kbd>S</kbd> 朗读';
  return `<kbd>1</kbd>~<kbd>4</kbd> 或 <kbd>A</kbd>~<kbd>D</kbd> 选答案 · <kbd>0</kbd> 我不会 · <kbd>S</kbd> 朗读`;
}

function hintText(item) {
  if (item.kind === 'learn') return '看完点下面的按钮（或按空格）→ 明天它才会作为测验题出现';
  if (state.mode === 'flash') return state.flashRevealed ? '自评一下（仅记错词，不计成绩）' : '空格 / 点按卡片  揭示释义';
  if (item.kind === 'browse') return state.flashRevealed ? '按 → 继续' : '空格 / 点按卡片  显示释义';
  if (state.phase === 'answered') return '答案会停在这里，看够了再继续 —— 这一步本身就是记忆';
  const q = state.question;
  if (!q) return '';
  if (q.type === 'spell') return '打出英文单词，回车提交；不会就按「我不会」';
  return `选出正确的${q.type === 'en2cn' ? '中文释义' : '英文单词'}（键盘 1~4）；不会就按 0`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 渲染一条助记技巧。没有助记时整块隐藏（**不硬编** ——
 * 抽象词给一条生造的联想，比不给更糟）。
 */
function fillTip(prefix, word) {
  const box = $(`${prefix}Tip`);
  const t = state.tips.get(word);
  if (!t || !t.tip) { box.hidden = true; return false; }
  box.hidden = false;
  // 缺 certainty 的一律按 low 处理（宁可按"联想"示人，也不冒充确证）
  const cert = TIP_CERT[t.certainty] ? t.certainty : 'low';
  const kindEl = $(`${prefix}TipKind`);
  kindEl.textContent = `${TIP_KIND[t.kind] || '助记'} · ${TIP_CERT[cert]}`;
  kindEl.className = `tip-kind c-${cert}`;
  $(`${prefix}TipText`).textContent = t.tip;
  return true;
}

function renderOptions(q) {
  const box = $('options');
  box.hidden = false;
  box.innerHTML = '';
  const keys = ['A', 'B', 'C', 'D'];
  q.options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.className = 'opt';
    b.dataset.i = String(i);
    b.innerHTML = `<span class="k">${keys[i]}</span><span class="t">${escapeHtml(opt)}</span>`;
    b.addEventListener('click', () => submitChoice(i));
    box.appendChild(b);
  });
}

function updateBrowseMark() {
  const item = currentItem();
  const btn = document.querySelector('.bnav-mark');
  if (!btn || !item) return;
  const marked = progress.mistakes.includes(item.word);
  btn.classList.toggle('on', marked);
  btn.textContent = marked ? '已在错词本' : '标记「不认识」';
}

function updateRail() {
  const total = state.mode === 'browse' ? state.browse.order.length : state.queue.length;
  const pos = state.mode === 'browse' ? state.browse.i + 1 : state.idx + 1;
  $('railFill').style.height = total ? `${Math.min(100, (pos / total) * 100)}%` : '0';
  $('railLabel').textContent = `${pos}/${total}`;
}

function countAll() {
  const today = localDayNum();
  let fresh = 0, learning = 0, due = 0, mastered = 0, asked = 0;
  for (const w of state.wb.words) {
    const c = getCard(w.word);
    if (!c || (!c.a && c.s === STATE.NEW)) { fresh++; continue; }
    if (c.a) asked++;
    if (c.s === STATE.LEARNING) learning++;
    else if (c.d <= today) due++;
    if (isMastered(c)) mastered++;
  }
  return { fresh, learning, due, mastered, asked, total: state.wb.words.length };
}

function updateCounters() {
  const s = countAll();
  const d = progress.days[todayKey()] || { n: 0, ok: 0, bad: 0 };
  setCtr('ctrDue', s.due + s.learning);
  setCtr('ctrNew', s.fresh);
  setCtr('ctrToday', (d.ok || 0) + (d.bad || 0));
  setCtr('ctrKnown', s.mastered);
}
function setCtr(id, v) {
  const el = $(id);
  if (el.textContent === String(v)) return;
  el.textContent = String(v);
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

function showStamp(cls, label) {
  const el = $('stamp');
  $('stampText').textContent = label;
  el.className = `stamp ${cls}`;
  void el.offsetWidth;
  el.classList.add('show');
}

/* ---------------- 作答 ---------------- */
function submitChoice(i) {
  if (state.phase !== 'asking' || !state.question) return;
  const q = state.question;
  if (q.type === 'spell') return;
  submitAnswer(i === q.answerIndex, { pickedIndex: i });
}

function submitSpell() {
  if (state.phase !== 'asking' || !state.question || state.question.type !== 'spell') return;
  const typed = $('spellInput').value;
  if (!typed.trim()) return;
  const forms = spellForms(state.question.word);
  const ok = forms.includes(normTyped(typed));
  submitAnswer(ok, { typed });
}

function submitDunno() {
  if (state.phase !== 'asking' || !state.question) return;
  // 「我不会」按答错处理：它是最诚实的信号，不该被当成蒙对的机会
  const typed = state.question.type === 'spell' ? ($('spellInput').value || '') : '';
  submitAnswer(false, { typed, dunno: true });
}

/** 判定 + 落盘 + 反馈 */
function submitAnswer(correct, extra = {}) {
  const item = currentItem();
  if (!item || !state.question) return;
  const q = state.question;
  const elapsed = performance.now() - state.questionStart;

  const grade = gradeOf(correct, q.type, item.word, elapsed);
  state.grade = grade;
  state.picked = extra.pickedIndex ?? extra.typed ?? null;
  state.phase = 'answered';

  recordAnswer(item.word, q.type, correct, grade, elapsed);
  schedule(item.word, grade);
  bumpDay(correct ? 'ok' : 'bad');
  if (!correct) {
    state.sessionWrong.add(item.word);
    state.stats.bad++;
  } else {
    state.stats.ok++;
  }
  flushProgress();

  if (correct) showStamp(grade === 1 ? 'g1' : 'g2', grade === 1 ? '慢' : '对');
  else showStamp('g0', '错');

  renderFeedback(q, correct, grade, extra);

  // 答错 → 本轮稍后再来（最多 2 次，防死循环）
  if (!correct) {
    const times = state.requeued.get(item.word) || 0;
    if (times < 2) {
      state.requeued.set(item.word, times + 1);
      const at = Math.min(state.queue.length, state.idx + 1 + 6);
      state.queue.splice(at, 0, { word: item.word, kind: 'quiz', type: pickType(getCard(item.word)) });
    }
  }

  // 判定完先朗读一遍（答对答错都读）——「让我记一下」的一半是「让我听一遍」
  if (correct && progress.settings.autoSpeak) speak(q.entry.word);

  showNextControls();
  $('kbdHint').innerHTML = kbdHintHtml(item);
  updateCounters();

  // ⚠️ 这里刻意**不**自动翻页：刷词的意义在于答案停在眼前那几秒。
  // 想自动走的话由 settings.memorizeMs 控制，且只对答对生效（答错必须自己读完）。
  if (correct && progress.settings.memorizeMs > 0) {
    const secs = Math.round(progress.settings.memorizeMs / 1000);
    $('fbHold').innerHTML = `<span class="dot"></span> ${secs} 秒后自动继续 · 想多看一会儿就按 <kbd>空格</kbd> 立刻走`;
    const token = ++state.advanceToken;
    state.autoTimer = setTimeout(() => { if (token === state.advanceToken) advance(); }, progress.settings.memorizeMs);
  } else if (correct) {
    $('fbHold').innerHTML = `<span class="dot"></span> 看够了按 <kbd>空格</kbd> 继续 —— 停留时间由你定`;
  } else {
    $('fbHold').innerHTML = `看清正确答案再按 <kbd>空格</kbd> —— 这个词本轮还会再问你一次`;
  }
}

/** 判定后显示「下一个」，并收起作答控件 */
function showNextControls() {
  $('goNext').hidden = false;
  $('goLearn').hidden = true;
  $('dunnoRow').hidden = true;
}

function renderFeedback(q, correct, grade, extra) {
  const fb = $('feedback');
  fb.hidden = false;
  fb.className = `feedback ${correct ? (grade === 1 ? 'meh' : 'ok') : 'no'}`;

  const entry = q.entry;
  if (extra.dunno) {
    $('fbVerdict').textContent = '标了「我不会」';
  } else {
    $('fbVerdict').textContent = correct
      ? (grade === 1 ? '答对了，但只能算「模糊」' : '答对了')
      : '答错了';
  }

  // 答案行：词 + 内联朗读 + 释义（这是要你记住的那一行，所以给足字号）
  const answerHtml = `<span class="word">${escapeHtml(entry.word)}</span>` +
    `<button class="speak-inline" data-speak="${escapeHtml(entry.word)}" title="朗读 (S)">🔊</button>` +
    `<span class="fb-def">${escapeHtml(entry.def)}</span>`;

  if (q.type === 'spell') {
    const typed = (extra.typed || '').trim();
    $('fbAnswer').innerHTML = answerHtml;
    if (extra.dunno) {
      $('fbNote').textContent = '标了「我不会」按答错算 —— 这比瞎蒙一个更诚实，排期也会更早再问你。';
    } else if (!correct && typed) {
      $('fbNote').innerHTML = `你写的是 ${diffHtml(typed, entry.word)} —— ` +
        `标出来的那一处就是错在哪。正确答案是 <b>${escapeHtml(entry.word)}</b>。`;
    } else {
      $('fbNote').textContent = '能整词打对，是比 4 选 1 强得多的证据。';
    }
  } else {
    $('fbAnswer').innerHTML = answerHtml;
    $('fbNote').innerHTML = correct && grade === 1
      ? (state.sessionWrong.has(entry.word)
        ? '<b>本轮你已经答错过这个词</b>，刚看过答案再选对不算真会，所以记「模糊」。'
        : '答得偏慢（超过 10 秒），多半是在排除，记「模糊」。')
      : '';
  }

  // 助记技巧放在最后、紧挨着「停留提示」—— 判定后到按空格之间那几秒，
  // 正是读这一段的时刻（见 ERROR.md E14：反馈停留时长是学习的一部分）
  fillTip('fb', entry.word);

  // 选择题：标出对错选项
  if (q.type !== 'spell') {
    const opts = [...document.querySelectorAll('.opt')];
    opts.forEach((el, i) => {
      el.disabled = true;
      if (i === q.answerIndex) el.classList.add('correct');
      else if (i === state.picked) el.classList.add('wrong');
      else el.classList.add('dim');
    });
  } else {
    const inp = $('spellInput');
    inp.disabled = true;
    inp.classList.add(correct ? 'ok' : 'no');
    $('spellSubmit').disabled = true;
  }
}

/**
 * 标出拼错的位置：按「公共前/后缀」取中间段。
 * ⚠️ 后缀长度必须满足 `s < a.length - p`，否则前后缀会重叠 ——
 * 实测 mishief→mischief 会算成 s=4 > a.length-p=3，渲染出 `mis∅hief` 这种鬼东西。
 */
function diffHtml(typed, answer) {
  const a = typed.toLowerCase(), b = answer.toLowerCase();
  if (a === b) return `<span class="sp-diff">${escapeHtml(typed)}</span>`;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p &&
         a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const head = escapeHtml(typed.slice(0, p));
  const tail = escapeHtml(s ? typed.slice(typed.length - s) : "");
  const aMid = typed.slice(p, typed.length - s);
  const bMid = answer.slice(p, answer.length - s);

  let mark;
  if (!aMid && bMid) mark = `<span class="miss">⟦漏了 ${escapeHtml(bMid)}⟧</span>`;
  else if (aMid && !bMid) mark = `<span class="bad">${escapeHtml(aMid)}</span><span class="miss">⟦多了⟧</span>`;
  else mark = `<span class="bad">${escapeHtml(aMid)}</span><span class="miss">→${escapeHtml(bMid)}</span>`;

  return `<span class="sp-diff">${head}${mark}${tail}</span>`;
}

function advance() {
  clearTimeout(state.autoTimer);
  state.advanceToken++;
  if (state.mode === 'browse') { moveBrowse(1); return; }
  state.idx++;
  state.phase = 'asking';
  if (state.idx >= state.queue.length) showDone();
  else renderCard();
}

/* ---------------- 学习卡 / 过词 / 浏览 ---------------- */
function confirmLearn() {
  const item = currentItem();
  if (!item || item.kind !== 'learn') return;
  scheduleFirstLearn(item.word);
  bumpDay('n');
  flushProgress();
  showStamp('g2', '学过');
  setTimeout(advance, 260);
}

function flashReveal() {
  state.flashRevealed = true;
  $('learnNote').dataset.hidden = '0';
  $('hint').textContent = hintText(currentItem());
}

/** 过词/浏览的自评：只动错词本，不碰排期与成绩单 */
function flashGrade(g) {
  const item = currentItem();
  if (!item) return;
  if (!state.flashRevealed) { flashReveal(); return; }
  const label = ['不认识', '模糊', '认识'][g];
  showStamp(g === 0 ? 'g0' : g === 1 ? 'g1' : 'g2', label);
  if (g === 0) {
    if (!progress.mistakes.includes(item.word)) {
      progress.mistakes.push(item.word);
      toast(`已加入错词本：${item.word}`);
    }
  } else if (g === 2) {
    const i = progress.mistakes.indexOf(item.word);
    if (i >= 0) { progress.mistakes.splice(i, 1); toast(`已移出错词本：${item.word}`); }
  }
  flushProgress();
  updateCounters();
  setTimeout(advance, 200);
}

function moveBrowse(d) {
  const n = state.browse.order.length;
  if (!n) return;
  state.browse.i = (state.browse.i + d + n) % n;
  state.flashRevealed = false;
  renderCard();
}

function markBrowse() {
  const item = currentItem();
  if (!item) return;
  if (!state.flashRevealed) { flashReveal(); return; }
  const i = progress.mistakes.indexOf(item.word);
  if (i >= 0) progress.mistakes.splice(i, 1);
  else progress.mistakes.push(item.word);
  flushProgress();
  updateBrowseMark();
}

/* ---------------- 结束页 ---------------- */
function showDone() {
  state.done = true;
  $('done').hidden = false;
  $('card').hidden = true;
  $('grades').hidden = true;
  $('browseNav').hidden = true;
  $('kbdHint').hidden = true;
  $('railFill').style.height = '100%';

  const s = countAll();
  const d = progress.days[todayKey()] || { n: 0, ok: 0, bad: 0 };
  const total = state.stats.ok + state.stats.bad;

  if (state.mode === 'flash') {
    $('doneTitle').textContent = '过完一遍了';
    $('doneText').textContent = '过词不计成绩、不改排期。要验证记住了没有，去「测验」。';
  } else if (total === 0) {
    $('doneTitle').textContent = s.fresh === 0 && s.due + s.learning === 0 ? '这本词库已经刷完了' : '今天没有到期的任务';
    $('doneText').textContent = s.fresh > 0
      ? `还有 ${s.fresh} 个新词没学。可以调高「每日新词上限」，或去「快速过词」先过一遍。`
      : '所有词都排到未来的复习计划里了。明天见。';
  } else {
    const acc = Math.round((state.stats.ok / total) * 100);
    $('doneTitle').textContent = '这一轮做完了';
    $('doneText').textContent = `本轮答 ${total} 题 · 答对 ${state.stats.ok} · 正确率 ${acc}%`;
  }

  $('doneGrid').innerHTML = `
    <div><b>${state.stats.ok}</b><i>答对</i></div>
    <div><b>${state.stats.bad}</b><i>答错</i></div>
    <div><b>${(d.ok || 0) + (d.bad || 0)}</b><i>今日已答</i></div>
    <div><b>${s.mastered}</b><i>记住了</i></div>
    <div><b>${progress.streak || 0}</b><i>连续天数</i></div>`;
  $('doneMore').textContent = total === 0 ? '开始一轮' : '再来一轮';
  updateCounters();
}

/* ---------------- 模式切换 ---------------- */
function setMode(mode) {
  const isStats = mode === 'stats';
  state.mode = mode;
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  }
  $('stage').hidden = isStats;
  $('panel').hidden = !isStats;
  $('card').hidden = false;
  $('kbdHint').hidden = false;
  $('goNext').hidden = true;

  if (isStats) { renderStats(); return; }

  if (mode === 'browse') {
    state.browse.order = shuffle(state.wb.words.map((w) => w.word));
    state.browse.i = 0;
    $('grades').hidden = true;
  } else if (mode === 'flash') {
    // 过词：全书随机过一遍，不走额度、不改排期
    state.queue = shuffle(state.wb.words.map((w) => w.word)).map((w) => ({ word: w, kind: 'flash' }));
    state.idx = 0;
    state.stats = { ok: 0, bad: 0 };
    $('grades').hidden = false;
  } else {
    buildQueue();
    $('grades').hidden = false;
  }
  renderCard();
}

/* ---------------- 统计 ---------------- */
/** 四种状态的词数：未学 / 学习中 / 复习中 / 已记住 */
function breakdown() {
  const today = localDayNum();
  let unlearned = 0, learning = 0, reviewing = 0, mastered = 0;
  for (const w of state.wb.words) {
    const c = getCard(w.word);
    if (!c || (!c.a && c.s === STATE.NEW)) { unlearned++; continue; }
    if (isMastered(c)) { mastered++; continue; }
    if (c.s === STATE.LEARNING) learning++;
    else reviewing++;                       // 含未到期的复习中
    void today;
  }
  return { unlearned, learning, reviewing, mastered, total: state.wb.words.length };
}

/** 从 days 记录里算最长连续天数（不额外存字段，避免两个来源打架） */
function bestStreak() {
  const keys = Object.keys(progress.days).sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    const t = Date.parse(`${k}T00:00:00`);
    if (Number.isNaN(t)) continue;
    run = (prev !== null && Math.round((t - prev) / DAY) === 1) ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

function renderStats() {
  const s = countAll();
  const d = progress.days[todayKey()] || { n: 0, ok: 0, bad: 0 };
  const allT = progress.types;
  const totA = QTYPES.reduce((n, t) => n + (allT[t]?.a || 0), 0);
  const totC = QTYPES.reduce((n, t) => n + (allT[t]?.c || 0), 0);
  const acc = totA ? Math.round((totC / totA) * 100) : 0;
  const bd = breakdown();

  // ---- 总进度：四态堆叠条 + 两个大数 ----
  const pct = (n) => (bd.total ? (n / bd.total) * 100 : 0);
  $('progressBlock').innerHTML = `
    <div class="pb-head">
      <div class="pb-big">${totA ? Math.round((s.asked / bd.total) * 100) : 0}%<small>考过 ${s.asked} / ${bd.total} 词</small></div>
      <div class="pb-big">${Math.round((bd.mastered / bd.total) * 100)}%<small>记住了 ${bd.mastered} / ${bd.total} 词</small></div>
      <div class="pb-sub">客观正确率 <b>${totA ? acc + '%' : '—'}</b> · 累计答题 <b>${totA}</b> 次 · 学习 <b>${Object.keys(progress.days).length}</b> 天 · 最长连续 <b>${bestStreak()}</b> 天</div>
    </div>
    <div class="pbar">
      <span class="s3" style="width:${pct(bd.mastered)}%"></span>
      <span class="s2" style="width:${pct(bd.reviewing)}%"></span>
      <span class="s1" style="width:${pct(bd.learning)}%"></span>
      <span class="s0" style="width:${pct(bd.unlearned)}%"></span>
    </div>
    <div class="pb-legend">
      <span><i class="s3" style="background:var(--jade)"></i>已记住 <b>${bd.mastered}</b></span>
      <span><i class="s2" style="background:var(--ink-3)"></i>复习中 <b>${bd.reviewing}</b></span>
      <span><i class="s1" style="background:var(--amber)"></i>学习中 <b>${bd.learning}</b></span>
      <span><i class="s0" style="background:rgba(190,176,148,.7)"></i>还没学 <b>${bd.unlearned}</b></span>
    </div>`;

  // ---- 最近 30 天：柱高 = 当天答题数，绿色是答对的部分 ----
  const histDays = [];
  for (let i = 29; i >= 0; i--) {
    const dd = new Date(); dd.setDate(dd.getDate() - i);
    const k = todayKey(dd);
    const rec = progress.days[k] || { n: 0, ok: 0, bad: 0 };
    histDays.push({ k, label: `${dd.getMonth() + 1}/${dd.getDate()}`, ...rec });
  }
  const hMax = Math.max(1, ...histDays.map((x) => (x.ok || 0) + (x.bad || 0)));
  const barsHtml = histDays.map((x) => {
    const tot = (x.ok || 0) + (x.bad || 0);
    // ⚠️ 没记录的日子只能用「细底线」表示，高度必须显式收掉 ——
    // 否则它会继承 .hist 的 height:100% 撑成满高（实测踩过）
    if (!tot) return `<div class="hist empty" title="${x.label}：没有记录"></div>`;
    const h = Math.max(3, Math.round((tot / hMax) * 100));
    const okPct = Math.round(((x.ok || 0) / tot) * 100);
    return `<div class="hist" style="height:${h}%" title="${x.label}：答 ${tot} 题，对 ${x.ok || 0}，错 ${x.bad || 0}">
      <div class="h-ok" style="flex:${okPct}"></div>
      <div class="h-bad" style="flex:${100 - okPct}"></div>
    </div>`;
  }).join("");
  // 柱子与刻度分成两个兄弟容器 —— innerHTML 里闭合父元素是无效的
  $('history').innerHTML =
    `<div class="hist-bars">${barsHtml}</div>` +
    `<div class="hist-label">${histDays.map((x, i) => `<span>${i % 5 === 0 ? x.label : ''}</span>`).join("")}</div>`;

  $('statRow').innerHTML = `
    <div class="stat"><i>累计答题</i><b>${totA}</b></div>
    <div class="stat"><i>累计答对</i><b>${totC}</b></div>
    <div class="stat"><i>累计答错</i><b>${totA - totC}</b></div>
    <div class="stat"><i>客观正确率</i><b>${totA ? acc + '%' : '—'}</b></div>
    <div class="stat"><i>考过的词</i><b>${s.asked}</b></div>
    <div class="stat"><i>记住了</i><b>${s.mastered}</b></div>
    <div class="stat"><i>学习中</i><b>${s.learning}</b></div>
    <div class="stat"><i>今日到期</i><b>${s.due}</b></div>
    <div class="stat"><i>今日新学</i><b>${d.n || 0}</b></div>
    <div class="stat"><i>今日答对</i><b>${d.ok || 0}</b></div>
    <div class="stat"><i>今日答错</i><b>${d.bad || 0}</b></div>
    <div class="stat"><i>学习天数</i><b>${Object.keys(progress.days).length}</b></div>
    <div class="stat"><i>当前连续</i><b>${progress.streak || 0}</b></div>
    <div class="stat"><i>最长连续</i><b>${bestStreak()}</b></div>`;

  // 题型正确率
  $('typeRow').innerHTML = QTYPES.map((t) => {
    const st = allT[t] || { a: 0, c: 0, ms: 0 };
    const pct = st.a ? Math.round((st.c / st.a) * 100) : 0;
    const sec = st.a ? (st.ms / st.a / 1000).toFixed(1) : '—';
    return `<div class="tcard">
      <i>${QT_LABEL[t]}</i>
      <b>${st.a ? pct + '%' : '—'}</b><span>${st.c}/${st.a} 题 · 均 ${sec}s</span>
      <div class="tmeter"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');

  // 未来 14 天到期量
  const tn = localDayNum();
  const buckets = new Array(14).fill(0);
  for (const w of state.wb.words) {
    const c = getCard(w.word);
    if (!c || !c.a && c.s === STATE.NEW) continue;
    const off = c.d - tn;
    if (off < 0) buckets[0]++;
    else if (off < 14) buckets[off]++;
  }
  const max = Math.max(1, ...buckets);
  $('forecast').innerHTML = buckets.map((n, i) => `
    <div class="fc ${i === 0 ? 'today' : ''}">
      <span class="fc-n">${n || ''}</span>
      <div class="fc-bar" style="height:${Math.round((n / max) * 100)}%"></div>
      <span class="fc-d">${i === 0 ? '今' : dayToLabel(i)}</span>
    </div>`).join('');

  // 最该复习的 20 个词（按客观正确率，只统计答过 ≥2 次的）
  const weak = [];
  for (const w of state.wb.words) {
    const c = getCard(w.word);
    if (!c || (c.a || 0) < 2) continue;
    weak.push({ word: w.word, def: w.def, a: c.a, c: c.c || 0, acc: (c.c || 0) / c.a, k: c.k || 0 });
  }
  weak.sort((x, y) => x.acc - y.acc || y.a - x.a);
  const box = $('weakest');
  if (!weak.length) {
    box.innerHTML = '<span class="wk-empty">还没有答够 2 次的词。考几轮之后这里会按正确率排出来。</span>';
  } else {
    box.innerHTML = '';
    for (const it of weak.slice(0, 20)) {
      const b = document.createElement('button');
      b.className = 'wk';
      b.innerHTML = `<span class="wk-word">${escapeHtml(it.word)}</span>` +
        `<span class="wk-def">${escapeHtml(it.def)}</span>` +
        `<span class="wk-acc">${Math.round(it.acc * 100)}% (${it.c}/${it.a})</span>`;
      b.title = '点一下听发音';
      b.onclick = () => speak(it.word);
      box.appendChild(b);
    }
  }

  // 错词本
  const valid = progress.mistakes.filter((w) => state.byWord.has(w));
  $('mistakeCount').textContent = `共 ${valid.length} 个`;
  const mbox = $('mistakes');
  if (!valid.length) {
    mbox.innerHTML = '<span class="mk-empty">还没有错词。测验答错的词会自动进这里。</span>';
  } else {
    mbox.innerHTML = '';
    for (const w of valid.slice(0, 400)) {
      const b = document.createElement('button');
      b.className = 'mk';
      b.textContent = w;
      b.title = state.byWord.get(w)?.def || '';
      b.onclick = () => speak(w);
      mbox.appendChild(b);
    }
  }

  $('setNew').value = progress.settings.newPerDay;
  $('setReview').value = progress.settings.reviewPerDay;
  $('setTypes').value = progress.settings.quizTypes;
  $('setMemorize').value = String(progress.settings.memorizeMs);
  $('setTimeGate').checked = progress.settings.timeGate;
  $('setSpeak').checked = progress.settings.autoSpeak;
  $('setPos').checked = progress.settings.showPos;
}

/* ---------------- 朗读 / 提示 ---------------- */
let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => /en[-_]US/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 0.88;
    if (voice) u.voice = voice;
    const btn = $('speakBtn');
    btn.classList.add('playing');
    u.onend = u.onerror = () => btn.classList.remove('playing');
    speechSynthesis.speak(u);
  } catch { /* 没语音引擎不影响刷词 */ }
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 300);
  }, 1900);
}

/* ---------------- 事件 ---------------- */
function wireEvents() {
  $('modes').addEventListener('click', (e) => {
    const b = e.target.closest('.mode-btn');
    if (b) setMode(b.dataset.mode);
  });

  $('card').addEventListener('click', (e) => {
    if (e.target.closest('.opt') || e.target.closest('.spell-box') || e.target.closest('.speak')) return;
    if (state.phase === 'learn' || state.mode === 'flash' || state.mode === 'browse') {
      if (!state.flashRevealed && state.phase !== 'learn') flashReveal();
    }
  });

  $('options').addEventListener('click', (e) => {
    const b = e.target.closest('.opt');
    if (b && !b.disabled) submitChoice(Number(b.dataset.i));
  });

  $('spellSubmit').addEventListener('click', submitSpell);
  $('dunnoBtn').addEventListener('click', submitDunno);
  $('spellInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitSpell(); }
  });

  // 反馈里的内联朗读按钮（答完马上听一遍，帮助记忆）
  $('feedback').addEventListener('click', (e) => {
    const b = e.target.closest('[data-speak]');
    if (b) speak(b.dataset.speak);
  });

  // 顶栏计数器点一下就进统计 —— 用户找不到统计入口时最自然的去处
  $('counters').addEventListener('click', () => setMode('stats'));
  $('counters').title = '点这里看全部统计与总进度';

  $('speakBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    speak(state.byWord.get(currentItem()?.word)?.word || '');
  });

  $('goLearn').addEventListener('click', confirmLearn);
  $('goNext').addEventListener('click', advance);
  $('goFlashBad').addEventListener('click', () => flashGrade(0));
  $('goFlashMeh').addEventListener('click', () => flashGrade(1));
  $('goFlashGood').addEventListener('click', () => flashGrade(2));

  $('browseNav').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) moveBrowse(Number(nav.dataset.nav));
    if (e.target.closest('[data-mark]')) markBrowse();
  });

  $('doneMore').addEventListener('click', () => {
    if (state.mode !== 'quiz') { setMode('quiz'); return; }
    const built = buildQueue();
    if (!built.q.length) {
      toast(progress.settings.newPerDay === 0
        ? '每日新词上限是 0，先到「统计 → 设置」里调高'
        : '今天的新词额度和复习都清空了，明天再来（或调高每日上限）');
      showDone();
      return;
    }
    $('card').hidden = false;
    $('grades').hidden = false;
    renderCard();
  });
  $('doneMistakes').addEventListener('click', () => {
    if (!progress.mistakes.length) { toast('错词本是空的'); return; }
    state.mode = 'quiz';
    for (const b of document.querySelectorAll('.mode-btn')) b.setAttribute('aria-selected', String(b.dataset.mode === 'quiz'));
    $('stage').hidden = false; $('panel').hidden = true;
    $('card').hidden = false; $('grades').hidden = false;
    buildQueue({ onlyMistakes: true });
    renderCard();
  });
  $('doneStats').addEventListener('click', () => setMode('stats'));

  const num = (id, key, lo, hi) => $(id).addEventListener('change', (e) => {
    progress.settings[key] = clamp(Number(e.target.value) || 0, lo, hi);
    e.target.value = progress.settings[key];
    saveProgress(); toast('已保存');
  });
  num('setNew', 'newPerDay', 0, 200);
  num('setReview', 'reviewPerDay', 0, 1000);
  $('setTypes').addEventListener('change', (e) => {
    progress.settings.quizTypes = e.target.value; saveProgress();
    toast('已改题型，下一张生效');
  });
  $('setMemorize').addEventListener('change', (e) => {
    progress.settings.memorizeMs = clamp(Number(e.target.value) || 0, 0, 60000);
    saveProgress();
    toast(progress.settings.memorizeMs
      ? `答对后会停 ${Math.round(progress.settings.memorizeMs / 1000)} 秒再继续`
      : '答对后等你按空格再继续');
  });
  const chk = (id, key, after) => $(id).addEventListener('change', (e) => {
    progress.settings[key] = e.target.checked; saveProgress();
    if (after) after(e.target.checked);
  });
  chk('setTimeGate', 'timeGate');
  chk('setSpeak', 'autoSpeak', (on) => { if (on) speak(currentItem()?.word); });
  chk('setPos', 'showPos', () => renderCard());

  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importBackup);
  $('resetBtn').addEventListener('click', resetProgress);

  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', flushProgress);
}

function onKey(e) {
  if (e.target instanceof HTMLInputElement) {
    if (e.key === 'Escape') e.target.blur();
    return;                      // 拼写输入框里的按键交给输入框自己
  }
  if (state.mode === 'stats') return;
  const k = e.key;

  if (k === ' ') {
    e.preventDefault();
    const item = currentItem();
    if (!item) return;
    if (state.phase === 'learn') { confirmLearn(); return; }   // 学习卡：空格 = 记住了，开始学
    if (state.phase === 'answered') { advance(); return; }     // 判定后：空格 = 下一个
    if (state.mode === 'flash' || state.mode === 'browse') { flashReveal(); return; }
    return;                                                    // 测验答题中：必须选一个
  }
  if (k === 's' || k === 'S') { speak(state.byWord.get(currentItem()?.word)?.word || ''); return; }

  if (state.mode === 'browse') {
    if (k === 'ArrowRight') { moveBrowse(1); return; }
    if (k === 'ArrowLeft') { moveBrowse(-1); return; }
    return;
  }
  if (state.mode === 'flash') {
    if (['1', '2', '3'].includes(k)) { e.preventDefault(); flashGrade(Number(k) - 1); }
    return;
  }

  // 测验
  if (k === '0') { e.preventDefault(); submitDunno(); return; }
  if (state.phase === 'asking' && state.question && state.question.type !== 'spell') {
    const map = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3, A: 0, B: 1, C: 2, D: 3 };
    if (k in map && map[k] < (state.question.options?.length || 0)) { e.preventDefault(); submitChoice(map[k]); }
  }
}
function k_advanceable() {
  return state.phase === 'answered';
}

/* ---------------- 备份 ---------------- */
function exportBackup() {
  flushProgress();
  const blob = new Blob([JSON.stringify({
    app: 'cet-vocab-trainer', version: PROGRESS_VERSION,
    wordbook: state.wbId, exportedAt: new Date().toISOString(), progress,
  }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `刷词进度-${state.wbId}-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已导出备份文件');
}

function importBackup(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(String(r.result));
      const p = data.progress || data;
      if (!p || typeof p !== 'object' || !p.cards) throw new Error('格式不对');
      progress = {
        ...blankProgress(), ...p,
        settings: { ...DEFAULT_SETTINGS, ...(p.settings || {}) },
        types: { ...blankProgress().types, ...(p.types || {}) },
      };
      for (const k of Object.keys(progress.cards)) migrateCard(progress.cards[k]);
      flushProgress();
      renderStats();
      toast(`已导入 ${Object.keys(progress.cards).length} 张卡的进度`);
    } catch (err) {
      toast('导入失败：不是本应用导出的备份文件');
      console.error(err);
    }
    e.target.value = '';
  };
  r.readAsText(f, 'utf-8');
}

function resetProgress() {
  if (!confirm('确定清空这本词库的全部学习进度？此操作不可撤销（建议先导出备份）。')) return;
  progress = blankProgress();
  flushProgress();
  renderStats();
  setMode('quiz');
  toast('进度已清空');
}

/* ---------------- 只读调试句柄（供门禁探针断言内部状态，不提供写入口） ---------------- */
function installDebugHandle() {
  window.__cvt = Object.freeze({
    version: PROGRESS_VERSION,
    wordCount: () => state.wb?.words.length || 0,
    stateInfo: () => ({
      mode: state.mode, phase: state.phase, idx: state.idx,
      queueLen: state.queue.length, wbId: state.wbId,
      type: state.question?.type || null,
      answerIndex: state.question?.answerIndex ?? -1,
      optionCount: state.question?.options?.length ?? 0,
      word: currentItem()?.word || null,
    }),
    cardOf: (w) => {
      const c = getCard(w);
      return c ? { ...c, mastered: isMastered(c) } : null;
    },
    /** 本条是否被 entry_repairs 改过（界面要据此提示「与书不一致」） */
    entryFixOf: (w) => {
      const e = state.byWord.get(w);
      return e && e.entry_fix ? { kind: e.entry_fix, sourceDef: e.source_def, sourcePos: e.source_pos } : null;
    },
    tipOf: (w) => state.tips.get(w) || null,
    tipCount: () => state.tips.size,
    masteredCount: () => countAll().mastered,
    isMastered: (w) => isMastered(getCard(w)),
    buildQuestion: (w, t) => {
      const q = buildQuestion(w, t);
      return q ? { type: q.type, word: q.word, options: q.options, answerIndex: q.answerIndex } : null;
    },
    /** 批量抽题做质量断言：每题必须 4 个互不相同的选项、且恰好 1 个正确 */
    sampleQuestions: (n) => {
      const out = [];
      const ws = state.wb.words;
      for (let i = 0; i < n; i++) {
        const e = ws[Math.floor(Math.random() * ws.length)];
        const t = QTYPES[Math.floor(Math.random() * QTYPES.length)];
        const q = buildQuestion(e.word, t);
        out.push(q && {
          type: t, word: q.word, options: q.options,
          answerIndex: q.answerIndex,
          correctText: t === 'en2cn' ? e.def : e.word,
        });
      }
      return out;
    },
    /**
     * 造一张「已经连对 n 次」的卡，用于断言「记住了」判据。
     * sameDay=true 表示这 n 次都发生在同一天（不该算记住）；false 表示跨天。
     */
    simulateCorrect: (w, n, sameDay = false) => {
      const c = migrateCard(getCard(w) || (progress.cards[w] = {
        s: STATE.LEARNING, i: 0, e: 2.5, d: localDayNum(), r: 0, l: 0,
      }));
      const base = localDayNum();
      c.a = (c.a || 0) + n;
      c.c = (c.c || 0) + n;
      c.k = n;
      c.fd = base;
      c.ld = sameDay ? base : base + Math.max(0, n - 1);
      c.s = STATE.REVIEW; c.i = 8;
      return { ...c, mastered: isMastered(c) };
    },
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  wireEvents();
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  let manifest = { wordbooks: [] };
  try { manifest = await (await fetch('/api/wordbooks')).json(); } catch { /* 用空清单兜底 */ }

  const first = manifest.wordbooks?.[0];
  if (!first) {
    $('wbName').textContent = '没有找到词库';
    $('hint').textContent = 'assets/wordbooks/ 下没有词库文件。';
    return;
  }

  const wb = await (await fetch(`/assets/wordbooks/${first.file}`)).json();
  state.wbId = wb.id || first.id;
  state.wb = wb;
  state.byWord = new Map(wb.words.map((w) => [w.word, w]));

  // 助记技巧是**可选**的独立文件：没有也能正常刷词（不硬编不存在的助记）
  state.tips = new Map();
  try {
    const r = await fetch(`/assets/wordbooks/tips/${state.wbId}.json`);
    if (r.ok) {
      const tipsDoc = await r.json();
      for (const [k, v] of Object.entries(tipsDoc.tips || {})) {
        if (v && v.tip) state.tips.set(k, v);
      }
    }
  } catch { /* 没有助记文件就跳过 */ }

  progress = loadProgress(state.wbId);

  $('wbName').textContent = `${wb.name} · ${wb.count} 词`;
  $('footInfo').textContent = `来源：${wb.source || '—'} · 进度存在本机浏览器` +
    (state.tips.size ? ` · 助记 ${state.tips.size}/${wb.count}` : '');

  buildQueue();
  installDebugHandle();
  renderCard();
}

boot();
