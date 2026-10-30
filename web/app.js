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

/**
 * 应用版本号 —— **显示用**，真源是 `package.json` 的 `version`。
 *
 * 为什么不 fetch('../../package.json')：安卓壳只把 web/ 与 assets/ 打进 APK，
 * package.json 不在其中，fetch 必然 404。所以这里留一份副本，
 * 由人负责与 package.json 同步（`npm run verify` 的门禁会比对，见 check_launcher）。
 */
const APP_VERSION = '1.0.2';

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

/**
 * 一批多少个新词。
 * 用户 2026-10-30 明确要求 **20 词一批**：看一遍新词后可以立马过一遍这一批，
 * 再按熟练度抽取做整体测验。
 */
const BATCH_SIZE = 20;

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
  // 触屏设备是否出拼写题：'auto'（触屏关、桌面开）/ 'on' / 'off'。
  // 手机上拼写要弹软键盘，见 spellAllowed() 的说明。
  spellOnTouch: 'auto',
  // v3（2026-10-30）：是否用旧的「到期队列」组织复习。
  //   false（默认）= 新机制：从已学过的词里按 熟练度×遗忘 加权随机抽
  //   true         = 经典 SRS：只抽 d <= 今天 的到期词
  useDueQueue: false,
  // 每日新词上限默认 20（= 一批的量），让"一批"和"一天"对齐
  newPerDay: 20,
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
  // v3：熟练度模型。`p` = 0~1 的熟练度（没见过 = 0），`lt` = 上次接触的天号。
  // 老卡没有这两个字段时，用已有成绩**推一个合理初值**，而不是一律抹成 0 ——
  // 否则老用户升级后，明明背了几百个词却全部显示"生疏"，会被吓一跳。
  if (typeof c.p !== 'number') c.p = estimateProfFromLegacy(c);
  if (typeof c.lt !== 'number') c.lt = c.t || c.ld || 0;
  return c;
}

/**
 * 老卡（没有 p 字段）→ 熟练度初值。
 * 依据手上的客观成绩单：连对次数 k 是最直接的证据，答对率做次要修正。
 * 这是**一次性迁移**，之后一律走 p 的正常更新规则。
 */
function estimateProfFromLegacy(c) {
  if (!c.a) return 0;                       // 没考过 = 生疏
  const acc = c.c / c.a;
  const byStreak = Math.min(c.k || 0, 4) / 4 * 0.6;   // 连对最多给 0.6
  const byAcc = acc * 0.4;                            // 正确率最多给 0.4
  return clamp(Number((byStreak + byAcc).toFixed(3)), 0, 1);
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

/* ---------------- 熟练度与遗忘曲线（v3 主线） ---------------- */
/*
 * 为什么另起一套「熟练度」而不是继续用间隔天数：
 *   间隔天数回答的是"什么时候再问"，是**排期**；而"我到底还记得多少"是个 0~1 的量，
 *   它应该随时间连续衰减（遗忘曲线），并且直接决定**被抽中的概率**。
 *   两者混在一个字段里，就没法表达"很久没见但当时很熟"这种状态。
 *
 * 因此：`p`（熟练度）管"有多熟"，`lt`（上次接触日）管"多久没见"，
 *       旧的 s/i/e/d 降为"到期队列"这一可选模式使用（见 settings.useDueQueue）。
 */

/**
 * 遗忘曲线：距上次接触 dt 天后，熟练度还剩的比例。R = 0.5^(dt/HALF_LIFE)
 *
 * 半衰期 5 天（用户 2026-10-30 选定）：背过的东西 5 天后记忆剩一半。
 * 实测对比（4 组 × 40 词，按 eff 分段算每词被抽中的相对概率）：
 *   HL=3（初值）  → 几乎忘光组 1.23×、较熟组 0.73×   （区分度偏弱）
 *   HL=5, P=2.5  → 几乎忘光组 1.58×、较熟组 0.67×   ← 当前
 *   HL=7, P=3.0  → 几乎忘光组 1.86×、较熟组 0.48×   （旧词占比过高）
 * 选 5 天是因为它落在常见遗忘研究给出的区间内，且不至于让"半年前背过的词"
 * 天天霸屏。
 */
const HALF_LIFE_DAYS = 5;

/** 有效熟练度 = 存档熟练度 × 遗忘衰减。这是"现在到底还记得多少"的估计。 */
function effProf(card, today = localDayNum()) {
  if (!card) return 0;
  const p = clamp(card.p || 0, 0, 1);
  const dt = Math.max(0, today - (card.lt || today));
  return clamp(p * Math.pow(0.5, dt / HALF_LIFE_DAYS), 0, 1);
}

/** 答对后的熟练度增量：越生疏涨得越多（同一条曲线对谁都收敛，而不是线性加） */
const PROF_GAIN = 0.34;
/** 答对的最小增量：保证熟练度**严格上升**（哪怕已经很熟也不例外） */
const PROF_GAIN_MIN = 0.02;
/** 答错后的熟练度惩罚（乘性，保证不会跌成负数） */
const PROF_PENALTY = 0.55;

/**
 * 按一条作答结果更新熟练度与计时。
 *
 * 规则（用户 2026-10-30 明确）：
 *   - 答对：熟练度增加，**距上次接触时间重置为 0**（lt = 今天）
 *   - 答错：**时间归零**（lt = 今天），同时熟练度下降
 *   - 没见过：熟练度 = 0
 *
 * ⚠️ 两个容易写错、都是有实测依据的点：
 *
 * ① **更新基于「有效熟练度」（含衰减）**，不是存档值。
 *    否则"一个月前背到 1.0、之后再没见"会被当成 1.0 继续往上加，
 *    等于假设他从未遗忘 —— 那正是遗忘曲线要修的东西。
 *
 * ② **答对时存档值不许下降**（取 max(旧存档, 新值)）。
 *    实测踩过：一张 p=0.5、5 天没见的卡，eff 已衰减到 0.157，
 *    答对后按公式算出 0.157 + (1-0.157)×0.34 ≈ 0.44 **低于存档的 0.5**，
 *    于是"答对了，熟练度反而掉了"—— 数学上自洽，但违反最基本的直觉，
 *    用户会认为这是 bug（这次正是被门禁抓到的）。
 *    正确语义：衰减只作用于**"现在还记得多少"的估计**（影响抽中概率），
 *    不该抹掉已经挣得的熟练度；答对只会让它更高。
 *
 * @param {number} g 档位：0=不认识 1=模糊 2=认识（见 gradeOf）
 */
function updateProficiency(card, g) {
  if (!card) return 0;
  migrateCard(card);                                 // 保证 p/lt 存在（老卡或新建卡）
  const today = localDayNum();
  const eff = effProf(card, today);
  const stored = clamp(card.p || 0, 0, 1);
  if (g === 0) {
    card.p = clamp(eff * PROF_PENALTY, 0, 1);        // 答错：掉，但不归零（留一点底）
  } else if (g === 1) {
    // 模糊：不奖励也不惩罚 —— 保住衰减后的值（比 attach 前低是正常的"最近确实不熟"）
    card.p = clamp(eff, 0, 1);
  } else {
    /*
     * 答对：**在存档值之上**加，保证严格上升（用户规则："回答正确，熟练度增加"）。
     *
     * 为什么不是"基于 feff 向 1 收敛"：那样的增量会被衰减吃掉 ——
     * 实测一张 p=0.5、5 天没见的卡算出 0.44，比原来还低，
     * 被门禁判为"答对反而不涨"（数学自洽但违反直觉，用户会认定是 bug）。
     * 现在的语义分得很清楚：
     *   - `p`     = 已经挣得的熟练度（答对只增不减，答错才降）
     *   - `eff`   = 折算到今天的"还记得多少"（衰减生效，只用于抽中概率）
     * 答对时增量按"当前有效值越低、涨得越多"给，所以生疏词涨得快、熟词涨得慢，
     * 但仍保证 p 严格上升 —— 两头都符合直觉。
     */
    const gain = PROF_GAIN * (1 - eff) + PROF_GAIN_MIN;
    card.p = clamp(Math.max(stored + gain, stored + 0.01), 0, 1);
  }
  card.lt = today;                                   // 答对答错都算"接触过" ⇒ 计时归零
  return card.p;
}

/** 熟练度 → 中文档位（界面上给人看的说法） */
function profLabel(p) {
  if (p >= 0.8) return '很熟';
  if (p >= 0.55) return '较熟';
  if (p >= 0.3) return '半熟';
  if (p > 0) return '生疏';
  return '没学过';
}

/**
 * 抽中权重：熟练度越低越容易被抽中（与熟练度反比），并随"久未接触"继续放大。
 *
 * 形式：w = (1 - eff)^POWER + FLOOR
 *   - eff=0（陌生）权重 ≈ 1；eff=1（很熟）权重 ≈ FLOOR（仍留一点，不是永不被抽）
 *   - POWER > 1 让"很生疏"和"有点生疏"拉开差距
 * 不用 exp 而用幂次：幂次在 eff→1 时行为更可控，且不依赖浮点指数。
 *
 * 参数取 POWER=2.5 / FLOOR=0.03（用户 2026-10-30 选定）：
 * 实测生疏组抽中率约是熟词的 2.4 倍（1.58× vs 0.67×），
 * 既保证复习重点，又不至于把熟词饿死（FLOOR 保证它们仍有 3% 的底权重）。
 * 初值是 POWER=1.6 / FLOOR=0.06，区分度只有 1.23× —— 太均匀，"忘了的词抽不到"。
 */
const DRAW_POWER = 2.5;
const DRAW_FLOOR = 0.03;

function drawWeight(card, today = localDayNum()) {
  const eff = effProf(card, today);
  return Math.pow(1 - eff, DRAW_POWER) + DRAW_FLOOR;
}

/**
 * 按权重随机抽 n 个（不放回）。
 * @param {string[]} words 候选词
 * @param {number} n 抽几个
 * @returns {string[]} 抽中的词（顺序即抽取顺序）
 */
function weightedSample(words, n, today = localDayNum()) {
  const pool = words.map((w) => ({ w, weight: drawWeight(getCard(w), today) }));
  const out = [];
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    let total = 0;
    for (const it of pool) total += it.weight;
    if (total <= 0) break;
    let r = Math.random() * total;
    let hit = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].weight;
      if (r <= 0) { hit = j; break; }
    }
    out.push(pool[hit].w);
    pool.splice(hit, 1);          // 不放回：一次测验里同一个词不出两次
  }
  return out;
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

/**
 * 触屏设备（手机/平板/安卓壳）判定。
 * 判据用 pointer:coarse 而不是宽度：桌面窗口也能很窄，但窄≠触屏；
 * 反过来 iPad 横屏很宽却仍是触屏、拼写会弹输入法。
 */
const IS_TOUCH = (() => {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
})();

/**
 * 手机端是否出拼写题。
 *
 * 为什么需要这个开关：拼写题在手机上要弹软键盘，键盘一顶，选项区被推走、
 * 手点「提交」前还得先收键盘——体验是从桌面直接搬过来才暴露的。但拼写又是
 * 三类题里**检索强度最高**的一种，直接砍掉等于削弱学习效果，所以做成"默认关、
 * 可手动打开"，由用户自己权衡，而不是替用户一刀切。
 *
 * 取值：'auto'（默认，触屏关/桌面开）/ 'on' / 'off'
 */
function spellAllowed() {
  const s = progress.settings.spellOnTouch || 'auto';
  if (s === 'on') return true;
  if (s === 'off') return false;
  return !IS_TOUCH;
}

/** 智能选题型：新词先认读，连对越多越往「产出」走 */
function pickType(card) {
  const s = progress.settings.quizTypes;
  // 用户显式指定了单一题型（含「只考拼写」）就照办 —— 那是明确的意图，
  // 不该被"触屏默认不出拼写"这条默认值悄悄推翻。
  if (s !== 'mix') return s;
  if (!card || card.s !== STATE.REVIEW) return 'en2cn';
  const k = card.k || 0;
  if (k >= 2 && spellAllowed() && Math.random() < 0.34) return 'spell';
  if (k >= 1 && Math.random() < 0.45) return 'cn2en';
  return 'en2cn';
}

/* ---------------- 应用状态 ---------------- */
const state = {
  wbId: null, wb: null, byWord: new Map(),
  tips: new Map(),            // 首词 → { kind, tip }；词库与助记分开存（重新提取词库不会冲掉助记）
  mode: 'quiz',
  queue: [], idx: 0,
  batch: null,                // { size, index }：本批计划多少个新词、已学几个（一批一批来）
  batchWords: [],             // 本批抽中的新词（学完可就地整批测验）
  batchMode: null,            // null=默认队列 | 'batchQuiz'（考本批）| 'draw'（按熟练度抽）
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
/**
 * 已学过的词 = 有卡、且不在「学习中」状态。
 * 这是新测验机制的抽取范围（用户 2026-10-30：从已学过的词里随机抽一部分）。
 * 「学习中」指答错过、还没重新掌握的词 —— 它们由本轮重排负责，不参与抽取，
 * 否则会把"刚答错的词"立刻又抽出来，变成原地打转。
 */
function learnedWords(pool) {
  return pool.filter((w) => {
    const c = getCard(w);
    return !!c && c.s !== STATE.LEARNING;
  });
}

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
  /*
   * 两个板块各只做自己的事（2026-10-30 拆板块时加的）：
   *   学习板块（opts.only === 'new'） → 只排新词（学习卡 + 紧跟的测验）
   *   测验板块（opts.only === 'review'）→ 只排复习题，一个学习卡都不出
   * 之前的默认行为是"两样混在一起"，那在学习板块里会让"我要学新词"变成
   * "先做一堆复习题才轮到一个新词"，与板块名字不符。
   * 不带 only 时保持混排（供"再来一批/再来一轮"等旧入口使用）。
   */
  const onlyNew = opts.only === 'new';
  const onlyReview = opts.only === 'review';

  const newBudget = opts.onlyMistakes ? fresh.length
    : (onlyReview ? 0 : Math.max(0, st.newPerDay - learnedToday));
  const reviewBudget = opts.onlyMistakes ? learning.length + review.length
    : (onlyNew ? 0 : st.reviewPerDay);

  // ---- 一批一批来 ----
  // 每批固定 BATCH_SIZE 个新词，学完立刻就地考一遍，一批走完就停下看成绩。
  const batchNew = Math.min(BATCH_SIZE, newBudget);
  const chosenNew = shuffle(fresh).slice(0, batchNew);

  /*
   * 复习部分的两种来源（用户 2026-10-30 确认：旧的降为可在设置里切换）：
   *   - 新模式（默认）：从**已学过的词**里按 熟练度×遗忘 加权随机抽
   *   - 旧模式：按到期日 d <= 今天 抽（经典 SRS 队列）
   * 两者都只决定"抽哪些"；具体题型仍由 pickType 决定。
   */
  let chosenReview;
  if (st.useDueQueue) {
    chosenReview = shuffle([...learning, ...review]).slice(0, reviewBudget);
  } else {
    const learned = learnedWords(pool).filter((w) => !learning.includes(w));
    // 「只刷错词」时不按权重抽，直接把错词全排上（否则"只刷错词"会被抽成随机子集）
    chosenReview = opts.onlyMistakes
      ? [...learning, ...review].slice(0, reviewBudget)
      : weightedSample(learned, Math.min(reviewBudget, learned.length), today);
  }

  const q = [];
  let a = 0, b = 0;
  while (a < chosenReview.length || b < chosenNew.length) {
    // 每轮：至多 3 道复习题 + 1 组「学 + 立刻考」
    for (let k = 0; k < 3 && a < chosenReview.length; k++) {
      const w = chosenReview[a++];
      q.push({ word: w, kind: 'quiz', type: pickType(getCard(w)) });
    }
    if (b < chosenNew.length) {
      const w = chosenNew[b++];
      // ⭐ 学必有考：新词的学习卡后面**在排队阶段就直接跟着它自己的测验**。
      //    原来只在 confirmLearn 里临时 splice 插入，导致"计划队列"快照里全是学习卡，
      //    既没法验证，也让"学完一批要考一批"的节奏不可见。
      q.push({ word: w, kind: 'learn' });
      q.push({ word: w, kind: 'quiz', type: pickType(getCard(w)), afterLearn: true });
    }
  }
  /*
   * ⚠️ 只有**排了新词**的那次组队才有资格定义"本批"。
   *
   * 拆板块后（2026-10-30）踩过：切到测验板块也会调 buildQueue({only:'review'})，
   * 那时 chosenNew 恒为空 —— 若无条件赋值，会把刚学的那一批**抹成空**
   * （batch 归零、batchWords 清空），于是「测验这一批」永远提示
   * "这一批还没有学过的词"。这是跨板块的状态丢失，必须靠条件赋值避免。
   */
  if (chosenNew.length) {
    state.batch = { size: batchNew, index: 0 };
    state.batchWords = chosenNew.slice();   // 本批新词（学完可就地整批测验）
    state.batchMode = null;
  }

  state.queue = q;
  state.idx = 0;
  state.sessionWrong = new Set();
  state.requeued = new Map();
  state.stats = { ok: 0, bad: 0 };
  state.done = false;
  return { ...summarizePool(pool), q };
}

/**
 * 把界面切到「测验」视图，但**不重建队列**。
 *
 * 为什么要单独有这个函数：setMode('quiz') 会调用 buildQueue() 重新组队 ——
 * 对"测验这一批"和"按熟练度抽一轮"来说，那会把刚精心抽好的队列**直接冲掉**
 * （实测：batchMode 被重置成 null、队列变回普通队列，入口看起来"点了没反应"）。
 */
function enterQuizView(queue, batchMode) {
  state.mode = 'quiz';
  state.queue = queue;
  state.idx = 0;
  state.sessionWrong = new Set();
  state.requeued = new Map();
  state.stats = { ok: 0, bad: 0 };
  state.done = false;
  state.batchMode = batchMode;
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.setAttribute('aria-selected', String(b.dataset.mode === 'quiz'));
  }
  $('stage').hidden = false;
  $('panel').hidden = true;
  $('done').hidden = true;
  $('card').hidden = false;
  $('grades').hidden = false;
  $('kbdHint').hidden = false;
  renderCard();
}

/**
 * 「学完这一批，马上考这一批」。
 *
 * 为什么单独有这个入口：用户要的是"看一遍新词后可以**立马**过一遍新词" ——
 * 这是一个**主动动作**，不该混在自动排队里。它只考本批学过的词，
 * 且不管熟练度（刚学完，抽全部才是"过一遍"）。
 */
function quizCurrentBatch() {
  const words = (state.batchWords || []).filter((w) => getCard(w));
  if (!words.length) { toast('这一批还没有学过的词'); return; }
  const queue = shuffle(words).map((w) => ({
    word: w, kind: 'quiz', type: pickType(getCard(w)),
  }));
  enterQuizView(queue, 'batchQuiz');
  toast(`开始测验这一批 ${queue.length} 个词`);
}

/**
 * 「按熟练度抽取」：从全部已学过的词里加权抽一轮。
 * 这是新机制的主线入口 —— 不按到期日，按"现在有多可能忘了"。
 */
function quizByProficiency() {
  const all = state.wb.words.map((w) => w.word);
  const learned = learnedWords(all);
  if (!learned.length) { toast('还没有学过的词'); return; }
  const n = Math.min(progress.settings.reviewPerDay, learned.length);
  const picked = weightedSample(learned, n);
  const queue = picked.map((w) => ({ word: w, kind: 'quiz', type: pickType(getCard(w)) }));
  enterQuizView(queue, 'draw');
  toast(`按熟练度抽了 ${picked.length} 个词`);
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
  // ⚠️ 必须重置：学完一张后「记住了，开始学」按钮会留在屏幕上，
  //    下一张若是测验题，底部就会残留一个不该有的按钮（实测截图暴露）。
  $('goLearn').hidden = true;
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
    // 手机上只留题型名（「中 → 英」）；完整说明太长会把这一行挤爆，
    // 具体怎么答题下面 #hint 里已经写了（2026-10-30 真机截图发现徽记被切掉）。
    const compact = window.matchMedia('(max-width: 720px)').matches;
    setTypeBadge(compact ? QT_LABEL[q.type] : `${QT_LABEL[q.type]} · ${QT_DESC[q.type]}`, `t-${q.type}`);
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
  // 卡片上方的「第 N 张 · 本批 x/20」—— 批次进度放这里，别挤在竖条旁
  // ⚠️ 手机上这一行还要放题型徽记和状态，全放长文本会把它们挤成竖排
  //    （2026-10-30 真机截图发现）。所以窄屏时只留「N/total」的紧凑形式。
  const b = state.batch;
  const short = window.matchMedia('(max-width: 720px)').matches;
  $('cardIndex').textContent = state.mode === 'browse'
    ? `第 ${state.browse.i + 1} 张`
    : (b && b.size > 0
        ? (short
            ? `本批 ${Math.min(b.index, b.size)}/${b.size}`
            : `第 ${state.idx + 1} 张 · 本批 ${Math.min(b.index, b.size)}/${b.size} 个新词`)
        : `第 ${state.idx + 1} 张`);
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
  // ⚠️ 这里只放「第几张/共几张」—— 竖条旁边太窄，批次进度改放卡片上方的 cardIndex。
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
  // 熟练度主线：与 schedule() 分开维护 —— 前者管"现在还记得多少"（决定抽中概率），
  // 后者管"什么时候再问"（旧到期队列用，可选）。
  updateProficiency(getCard(item.word), grade);
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
  // ⭐ 学完**立刻就地考一道**。
  //    正常路径下，排队时已经把这个新词的测验排在它后面了（见 buildQueue 的「学必有考」），
  //    所以这里**只在缺失时才补**——幂等，避免同一词被排两道测验。
  const next = state.queue[state.idx + 1];
  const paired = next && next.kind === 'quiz' && next.word === item.word;
  if (!paired) {
    state.queue.splice(state.idx + 1, 0, { word: item.word, kind: 'quiz', type: pickType(getCard(item.word)) });
  }
  if (state.batch) state.batch.index++;
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
    // 一批一批来：明确告诉用户"这是这一批走完了"，而不是"今天全做完了"
    const bs = state.batch?.size || 0;
    if (bs > 0 && total > 0) {
      $('doneTitle').textContent = `这一批做完了 · ${bs} 个新词`;
      const more = s.fresh > 0
        ? `还剩 ${s.fresh} 个新词。歇一会儿再点「再来一批」，下一批还是 ${Math.min(BATCH_SIZE, s.fresh)} 个。`
        : '词库里的新词已经学完了。';
      $('doneText').textContent = `本批答 ${total} 题 · 答对 ${state.stats.ok} · 正确率 ${acc}%。${more}`;
    } else {
      $('doneTitle').textContent = '这一轮做完了';
      $('doneText').textContent = `本轮答 ${total} 题 · 答对 ${state.stats.ok} · 正确率 ${acc}%`;
    }
  }

  $('doneGrid').innerHTML = `
    <div><b>${state.stats.ok}</b><i>答对</i></div>
    <div><b>${state.stats.bad}</b><i>答错</i></div>
    <div><b>${(d.ok || 0) + (d.bad || 0)}</b><i>今日已答</i></div>
    <div><b>${s.mastered}</b><i>记住了</i></div>
    <div><b>${progress.streak || 0}</b><i>连续天数</i></div>`;
  $('doneMore').textContent = total === 0 ? '开始一轮' : (state.batch?.size > 0 ? '再来一批' : '再来一轮');

  // 新机制的两个入口按情境显示（不是一直摊着，避免按钮墙）：
  //   「测验这一批」—— 只在刚学完一批新词后有意义
  //   「按熟练度抽一轮」—— 只要有学过的词就能用
  const batchN = (state.batchWords || []).filter((w) => getCard(w)).length;
  const learnedN = learnedWords(state.wb ? state.wb.words.map((w) => w.word) : []).length;
  const inBatchQuiz = state.batchMode === 'batchQuiz';
  $('doneBatchQuiz').hidden = !(batchN > 0 && !inBatchQuiz);
  $('doneBatchQuiz').textContent = `测验这一批（${batchN} 词）`;
  $('doneDraw').hidden = learnedN === 0;
  $('doneDraw').textContent = `按熟练度抽一轮（已学 ${learnedN} 词）`;

  updateCounters();
}

/* ---------------- 板块切换 ---------------- */
/*
 * 四个板块各管一件事（2026-10-30 用户要求重排导航）：
 *   learn    学新词（内含快速过词 / 乱序浏览作为辅助）
 *   quiz     考已学过的词（按熟练度抽、或整批测验）
 *   stats    看数据
 *   settings 调设置 + 学习记录管理 + 关于
 *
 * `state.mode` 仍然是"卡片舞台怎么渲染"的唯一开关，取值比板块更细：
 *   learn | quiz | flash | browse   —— 前两个是主线，后两个是学习辅助
 * 所以板块与 mode 是两层：learn 板块下的 flash/browse 也算 learn 板块。
 */
/** 某个 mode 归属哪个板块 */
function boardOf(mode) {
  if (mode === 'stats') return 'stats';
  if (mode === 'settings') return 'settings';
  if (mode === 'flash' || mode === 'browse') return 'learn';
  return mode === 'learn' ? 'learn' : 'quiz';
}

function setMode(mode) {
  state.mode = mode;
  const board = boardOf(mode);
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.setAttribute('aria-selected', String(b.dataset.mode === board));
  }
  const isPanel = board === 'stats' || board === 'settings';
  $('stage').hidden = isPanel;
  $('panel').hidden = board !== 'stats';
  $('settingsPanel').hidden = board !== 'settings';
  $('card').hidden = false;
  $('kbdHint').hidden = false;
  $('goNext').hidden = true;
  // 学习辅助条只在学习板块出现；测验入口只在测验板块出现
  $('learnBar').hidden = board !== 'learn';
  $('quizBar').hidden = board !== 'quiz';

  if (board === 'stats') { renderStats(); return; }
  if (board === 'settings') { renderSettings(); return; }

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
    /*
     * learn / quiz 都走 buildQueue，但**各自只排自己那一半**：
     *   学习板块 → 只有新词（学习卡 + 紧跟的测验）
     *   测验板块 → 只有复习题
     * 两者共用同一套排期逻辑（"学必有考"的成对关系不能断），
     * 差别只在入口给它的 only 参数。
     */
    buildQueue({ only: mode === 'learn' ? 'new' : 'review' });
    $('grades').hidden = false;
  }
  updateQuizBar();
  renderCard();
}

/** 测验板块那两个入口的可用状态与副标题 */
function updateQuizBar() {
  if (!state.wb) return;
  const all = state.wb.words.map((w) => w.word);
  const learnedN = learnedWords(all).length;
  const batchN = (state.batchWords || []).filter((w) => getCard(w)).length;
  $('barDrawHint').textContent = learnedN ? `已学 ${learnedN} 词` : '还没有学过的词';
  $('barDraw').disabled = learnedN === 0;
  $('barBatchHint').textContent = batchN ? `本批已学 ${batchN} 词` : '本批还没学过';
  $('barBatch').disabled = batchN === 0;
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

  // ---- 总进度：四态堆叠条 + 三个大数 ----
  /*
   * 「已学过」= 已记住 + 复习中 + 学习中，也就是"有卡片、动过"的词。
   *
   * 为什么要单独放一个大数字（2026-10-30 用户问"在哪看学过的词汇数量"）：
   * 原来只有「考过」「记住了」两个大数，而「考过」按 a>0 算 ——
   * **只看了学习卡、还没答过题的新词不算在内**（实测：学一张卡后
   * 考过的词仍是 0，但"还没学"已经少了 1）。
   * 用户心里的"学过的词"显然包含刚学的那些，所以必须有个显式的数字，
   * 而不是让人去四态图例里自己加。
   */
  const learnedN = bd.mastered + bd.reviewing + bd.learning;
  const pct = (n) => (bd.total ? (n / bd.total) * 100 : 0);
  $('progressBlock').innerHTML = `
    <div class="pb-head">
      <div class="pb-big">${Math.round((learnedN / bd.total) * 100)}%<small>已学过 ${learnedN} / ${bd.total} 词</small></div>
      <div class="pb-big">${totA ? Math.round((s.asked / bd.total) * 100) : 0}%<small>考过 ${s.asked} / ${bd.total} 词</small></div>
      <div class="pb-big">${Math.round((bd.mastered / bd.total) * 100)}%<small>记住了 ${bd.mastered} / ${bd.total} 词</small></div>
      <div class="pb-sub">已学过 = 记住了 + 复习中 + 学习中（动过的词）；考过 = 至少答过一次 ·
        客观正确率 <b>${totA ? acc + '%' : '—'}</b> · 累计答题 <b>${totA}</b> 次 · 学习 <b>${Object.keys(progress.days).length}</b> 天 · 最长连续 <b>${bestStreak()}</b> 天</div>
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
}

/* ---------------- 设置板块 ---------------- */
/**
 * 渲染「设置」板块：把控件值同步成当前设置，并填「关于」。
 *
 * 为什么设置控件要在每次进入板块时重设一遍值：设置项是**受控的**，
 * 而导出/导入/清空都会替换整个 progress 对象 —— 不重设的话，
 * 导入一份备份后界面上还是旧值，用户会以为没生效。
 */
function renderSettings() {
  const st = progress.settings;
  $('setNew').value = st.newPerDay;
  $('setReview').value = st.reviewPerDay;
  $('setTypes').value = st.quizTypes;
  $('setMemorize').value = String(st.memorizeMs);
  $('setTimeGate').checked = !!st.timeGate;
  $('setSpeak').checked = !!st.autoSpeak;
  $('setPos').checked = !!st.showPos;
  $('setDueQueue').checked = !!st.useDueQueue;
  $('setSpell').value = st.spellOnTouch || 'auto';

  // ---- 关于 ----
  const cards = Object.keys(progress.cards || {}).length;
  const days = Object.keys(progress.days || {}).length;
  const firstUse = Object.keys(progress.days || {}).sort()[0] || '—';
  const wb = state.wb;
  $('aboutBox').innerHTML = `
    <div class="about-row"><span>版本</span><b>${APP_VERSION}</b></div>
    <div class="about-row"><span>词库</span><b>${wb ? `${wb.name} · ${wb.count} 词` : '—'}</b></div>
    <div class="about-row"><span>词库来源</span><b>${wb?.source || '—'}</b></div>
    <div class="about-row"><span>助记</span><b>${state.tips.size} / ${wb?.count ?? 0} 条</b></div>
    <div class="about-row"><span>学习记录</span><b>${cards} 张卡 · ${days} 天${firstUse !== '—' ? `（最早 ${firstUse}）` : ''}</b></div>
    <p class="muted small">
      进度只存在本机（浏览器 localStorage / 手机应用内），不上传任何服务器。
      应用完全离线可用：词库与助记都随安装包一起提供，运行时不联网。
    </p>`;
}

/* ---------------- 朗读 / 提示 ---------------- */
/** 安卓壳注入的原生 TTS（见 android/.../MainActivity.kt 的 TtsBridge） */
function nativeTts() {
  return (typeof window !== 'undefined' && window.AndroidTts) || null;
}

let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => /en[-_]US/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
}
function speak(text) {
  if (!text) return;
  const btn = $('speakBtn');

  // 安卓 WebView 不一定带可用的 speechSynthesis（部分机型上 `'speechSynthesis' in
  // window` 为真但发不出声），所以壳里注入了原生 TTS 作为**兜底**：网页引擎优先，
  // 没有才走原生。判据是「能不能发出声」，不是「对象存不存在」。
  if (!('speechSynthesis' in window)) {
    const n = nativeTts();
    if (n && typeof n.speak === 'function') {
      // 壳提供 isAvailable()：系统没有 TTS 引擎时它返回 false。
      // 实测 PKS110 的 tts_default_synth 是 null（没设默认引擎），
      // 此时**不要**把按钮点亮 —— 点亮了却不出声，用户只会以为"坏了"。
      // 具体原因由壳自己 Toast 出来（含"去哪儿装引擎"的指引）。
      let ok = true;
      try { if (typeof n.isAvailable === 'function') ok = n.isAvailable(); } catch { ok = true; }
      try {
        n.speak(String(text));
        if (ok) {
          btn.classList.add('playing');
          setTimeout(() => btn.classList.remove('playing'), 900);
        }
      } catch { /* 朗读失败不影响刷词 */ }
    }
    return;
  }

  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US'; u.rate = 0.88;
    if (voice) u.voice = voice;
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

  // 学习板块的辅助入口（快速过词 / 乱序浏览 / 回到学新词）
  $('learnBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-submode]');
    if (!b) return;
    const sub = b.dataset.submode;
    setMode(sub === 'new' ? 'learn' : sub);
  });

  // 测验板块的两个主动入口
  $('barDraw').addEventListener('click', quizByProficiency);
  $('barBatch').addEventListener('click', quizCurrentBatch);

  $('doneMore').addEventListener('click', () => {
    // 「再来一批/再来一轮」跟着当前板块走，不要固定回测验
    const m = boardOf(state.mode);
    if (m === 'stats' || m === 'settings') { setMode('learn'); return; }
    const built = buildQueue(m === 'learn' ? { only: 'new' } : { only: 'review' });
    if (!built.q.length) {
      toast(m === 'learn'
        ? (progress.settings.newPerDay === 0
            ? '每日新词上限是 0，先到「设置」里调高'
            : '今天的新词学完了，明天再来（或调高每日上限）')
        : '暂时没有可复习的词 —— 先去「学习」学一批吧');
      showDone();
      return;
    }
    $('card').hidden = false;
    $('grades').hidden = false;
    updateQuizBar();
    renderCard();
  });
  $('doneBatchQuiz').addEventListener('click', quizCurrentBatch);
  $('doneDraw').addEventListener('click', quizByProficiency);
  $('doneMistakes').addEventListener('click', () => {
    if (!progress.mistakes.length) { toast('错词本是空的'); return; }
    state.mode = 'quiz';
    for (const b of document.querySelectorAll('.mode-btn')) {
      b.setAttribute('aria-selected', String(b.dataset.mode === 'quiz'));
    }
    $('stage').hidden = false; $('panel').hidden = true; $('settingsPanel').hidden = true;
    $('learnBar').hidden = true; $('quizBar').hidden = false;
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
  $('setSpell').addEventListener('change', (e) => {
    progress.settings.spellOnTouch = e.target.value; saveProgress();
    toast('已改拼写题设置，下一张生效');
  });
  const chk = (id, key, after) => $(id).addEventListener('change', (e) => {
    progress.settings[key] = e.target.checked; saveProgress();
    if (after) after(e.target.checked);
  });
  chk('setTimeGate', 'timeGate');
  chk('setSpeak', 'autoSpeak', (on) => { if (on) speak(currentItem()?.word); });
  chk('setPos', 'showPos', () => renderCard());
  chk('setDueQueue', 'useDueQueue', (on) => {
    toast(on ? '复习改为「到期队列」（经典 SRS）' : '复习改为「按熟练度抽取」');
  });

  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', importBackup);
  // 清除数据：四个粒度各接各的处理函数（见各自的注释说明差异）
  $('resetMistakes').addEventListener('click', resetMistakes);
  $('resetSettings').addEventListener('click', resetSettings);
  $('resetBtn').addEventListener('click', resetProgress);
  $('factoryBtn').addEventListener('click', factoryReset);

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

/**
 * 清空学习进度。
 *
 * ⚠️ **保留 settings**（2026-10-30 修）。
 * 原来走 `progress = blankProgress()`，而 blankProgress() 里含
 * `settings: {...DEFAULT_SETTINGS}` —— 实测用户设的 newPerDay=7 / reviewPerDay=33 /
 * memorizeMs=5000 / showPos=false，点一次「清空进度」全被悄悄重置回默认。
 * 用户要清的是**学习记录**，不是**自己的偏好**，两者不该绑在一起。
 */
function resetProgress() {
  if (!confirm('确定清空这本词库的全部学习进度？\n（卡片、错词本、统计都会清掉；你的设置会保留）\n此操作不可撤销，建议先导出备份。')) return;
  const keepSettings = { ...progress.settings };
  progress = blankProgress();
  progress.settings = keepSettings;
  flushProgress();
  renderSettings();
  renderStats();
  toast('学习进度已清空（设置已保留）');
}

/**
 * 只清错词本。
 * 为什么单独给一个：错词本是"待巩固清单"，用户可能想让它重新开始积累，
 * 但不想丢掉已经学会的进度 —— 全清代价太大，不给这个入口就只能全清。
 */
function resetMistakes() {
  const n = progress.mistakes.length;
  if (!n) { toast('错词本已经是空的'); return; }
  if (!confirm(`确定清空错词本？\n（共 ${n} 个词；卡片与统计不受影响）`)) return;
  progress.mistakes = [];
  flushProgress();
  renderSettings();
  renderStats();
  toast(`已清空错词本（${n} 个词）`);
}

/**
 * 只把设置恢复默认。
 * 与"清空进度"互补：想重置偏好但保留学习记录时用这个。
 */
function resetSettings() {
  if (!confirm('确定把设置恢复成默认值？\n（学习进度不受影响）')) return;
  progress.settings = { ...DEFAULT_SETTINGS };
  flushProgress();
  renderSettings();
  toast('设置已恢复默认');
}

/**
 * 全部恢复出厂：进度 + 设置一起清。
 * 单独留着是因为"我想从头再来一遍"是真实需求，但它必须与
 * 「清空学习进度」（保留设置）明确区分开 —— 用户点之前就该知道区别。
 */
function factoryReset() {
  if (!confirm('确定全部恢复出厂？\n\n这会清掉：卡片、错词本、统计、以及你的全部设置。\n等于刚安装好的状态。此操作不可撤销，建议先导出备份。')) return;
  progress = blankProgress();
  flushProgress();
  renderSettings();
  renderStats();
  toast('已恢复出厂设置');
}

/* ---------------- 安卓壳的返回键 ---------------- */
/**
 * 安卓返回键的处理入口，由壳（MainActivity.kt）通过 evaluateJavascript 调用。
 *
 * 为什么由**页面**决定、而不是壳里自己判断：返回键该做什么完全取决于应用状态
 * （是否在统计页、是否已揭示答案、是否在看判定反馈）。壳里看不到这些状态，
 * 硬要猜就会做出「按返回直接退出、学习进度还在半途」这种行为。
 *
 * 约定：返回 true = 页面已处理（壳什么都不做）；false = 页面无事可做（壳退出应用）。
 * 这与浏览器「返回」的直觉一致：一层一层往回退，退到底才离开。
 */
function handleBack() {
  // 0) 参数/统计板块优先：切过去时答案/反馈并未被销毁，只是整个 stage 被隐藏，
  //    `#feedback` 可能仍是 visible。若不先处理这一层，下面的 `advance()` 会在
  //    用户看不见的地方把 state.idx 往前推——等于**静默跳过一张卡**。
  if (state.mode === 'stats' || state.mode === 'settings') { setMode('quiz'); return true; }

  // 1) 判定反馈还开着 → 先收起，等于"继续下一张"
  if (!$('feedback').hidden) { advance(); return true; }

  // 2) 过词/浏览模式已揭示释义 → 先收起来，别直接跳走
  //    （`flashRevealed` 是这两个模式共用的揭示标志，见 flashReveal()）
  if ((state.mode === 'flash' || state.mode === 'browse') && state.flashRevealed) {
    state.flashRevealed = false;
    renderCard();
    return true;
  }

  // 3) 过词 / 浏览（都属于学习板块的辅助）→ 回到「学新词」主线
  if (state.mode === 'flash' || state.mode === 'browse') { setMode('learn'); return true; }

  // 4) 已在主线且无待处理状态 → 交给壳退出应用
  return false;
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
      kind: currentItem()?.kind || null,
      batch: state.batch ? { ...state.batch } : null,
    }),
    /** 队列快照：用于验证「学必有考」的编排（每张学习卡后面必须紧跟它自己的测验） */
    queueSnapshot: () => ({
      queue: state.queue.map((x) => ({ word: x.word, kind: x.kind, type: x.type || null })),
      idx: state.idx,
      batch: state.batch ? { ...state.batch } : null,
    }),
    cardOf: (w) => {
      const c = getCard(w);
      return c ? { ...c, mastered: isMastered(c), effProf: +effProf(c).toFixed(4) } : null;
    },
    /** v3 熟练度模型：只读暴露，供门禁断言衰减与更新规则 */
    profOf: (w) => {
      const c = getCard(w);
      return c ? { p: +(c.p || 0).toFixed(4), lt: c.lt || 0, eff: +effProf(c).toFixed(4) } : null;
    },
    effProfOf: (w) => +effProf(getCard(w)).toFixed(4),
    drawWeightOf: (w) => +drawWeight(getCard(w)).toFixed(4),
    /** 抽 n 个词（只读仿真用；不改任何状态） */
    sampleByProficiency: (n) => weightedSample(
      learnedWords(state.wb ? state.wb.words.map((x) => x.word) : []), n,
    ),
    learnedCount: () => learnedWords(state.wb ? state.wb.words.map((x) => x.word) : []).length,
    batchInfo: () => ({
      size: state.batch?.size ?? 0,
      index: state.batch?.index ?? 0,
      words: (state.batchWords || []).slice(),
      mode: state.batchMode,
    }),
    /** 本条是否被 entry_repairs 改过（界面要据此提示「与书不一致」） */
    entryFixOf: (w) => {
      const e = state.byWord.get(w);
      return e && e.entry_fix ? { kind: e.entry_fix, sourceDef: e.source_def, sourcePos: e.source_pos } : null;
    },
    tipOf: (w) => state.tips.get(w) || null,
    tipCount: () => state.tips.size,
    /**
     * 测试专用：临时把某个词的助记从内存里摘掉，并**走真实的渲染路径**重画当前卡。
     *
     * 为什么需要它：助记覆盖到 100% 之后，队列里**再也走不到"没有助记的词"**这个分支，
     * 而那条守卫（没有助记就整块隐藏、不硬编）仍然必须被验证。合成一个词库外的词
     * 行不通 —— 队列是从词库生成的，词库外的词根本进不了队列（实测走不通）。
     * 所以改成"从真实数据里摘掉一条"：**被测的仍是真实的 fillTip 守卫，输入却可控**。
     *
     * 只动内存，不写 localStorage、不碰磁盘；用完请调 restoreTips() 还原。
     */
    dropTip: (w) => {
      const had = state.tips.get(w) || null;
      state.tips.delete(w);
      renderCard();
      return { hadTip: !!had, tipCount: state.tips.size };
    },
    restoreTips: (w, tip) => { if (tip) state.tips.set(w, tip); renderCard(); return state.tips.size; },
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

  // 词库路径**相对页面**取（`./` 前缀），不写绝对路径 —— 因为同一份前端要跑在
  // 两种宿主里：桌面用 server.mjs（绝对路径 /api/... 与 /assets/...），安卓壳用
  // WebViewAssetLoader（页面在 /web/index.html，数据挂在 /wordbooks/...）。
  // 写死绝对路径会让其中一种宿主 404，且错误只表现为「没有找到词库」。
  let manifest = { wordbooks: [] };
  try { manifest = await (await fetch('./wordbooks/index.json')).json(); } catch { /* 用空清单兜底 */ }

  const first = manifest.wordbooks?.[0];
  if (!first) {
    $('wbName').textContent = '没有找到词库';
    $('hint').textContent = 'assets/wordbooks/ 下没有词库文件。';
    return;
  }

  const wb = await (await fetch(`./wordbooks/${first.file}`)).json();
  state.wbId = wb.id || first.id;
  state.wb = wb;
  state.byWord = new Map(wb.words.map((w) => [w.word, w]));

  // 助记技巧是**可选**的独立文件：没有也能正常刷词（不硬编不存在的助记）
  state.tips = new Map();
  try {
    const r = await fetch(`./wordbooks/tips/${state.wbId}.json`);
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
  // 安卓壳的返回键入口（桌面浏览器上没人调用它，留着无害）
  window.__cvtHandleBack = handleBack;
  renderCard();
}

boot();
