/**
 * 批量提交：**先过门禁，绿了才 commit**。
 *
 * 为什么要有这个工具：本轮实测犯过一次「门禁报红，但我仍然 commit 了」
 * —— 因为我把"跑门禁"和"提交"当成了两个独立的手工步骤，而**手工步骤会在忙的时候被跳过**。
 * 判据：提交这个动作必须由门禁的退出码驱动，不能由我"记得去看"驱动。
 *
 * 用法：node tools/batch_commit.mjs "<提交信息>"
 *   · 先跑 validate_tips + check_wordbook + check_launcher（本地秒级三道）
 *   · 全绿才 git add -A && git commit
 *   · 任何一道红 → 打印失败原因、**不提交**、退出码 1
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const msg = process.argv[2];
if (!msg) {
  console.error('用法：node tools/batch_commit.mjs "<提交信息>"');
  process.exit(2);
}

const GATES = ["check_launcher.mjs", "check_wordbook.mjs", "validate_tips.mjs"];

// 先重建派生数据，再跑门禁。
// ⚠️ 为什么必须有这一步：`cet6.json` 是 `build_wordbook.py` 的**产物**，
// 但它同时又是**入库的文件**。改了 `entry_repairs.json` 而没重跑 build，
// 库里就还是旧词条 —— 本轮实测踩过：门禁报「库 22 / 表 25」，
// 我盯着修正表找了半天，因为**错的是那道没跑的工序**。
// 判据：**派生文件与源表之间不许存在"只有人记得同步"的状态。**
console.log("— 重建派生数据（build_wordbook.py，应用 entry_repairs / headword_repairs）—");
const build = spawnSync("python", [join(HERE, "build_wordbook.py")], { cwd: ROOT, stdio: "inherit" });
if (build.status !== 0) {
  console.error(`\n[构建失败] build_wordbook.py 退出码 ${build.status} —— 拒绝提交。`);
  process.exit(1);
}

let allGreen = true;

for (const g of GATES) {
  const r = spawnSync(process.execPath, [join(HERE, g)], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    allGreen = false;
    console.error(`\n[门禁红] ${g} 退出码 ${r.status}`);
  }
}

if (!allGreen) {
  console.error("\n⛔ 门禁未全绿 —— 拒绝提交。先修好上面报红的项，再跑一次。");
  process.exit(1);
}

const run = (args) => spawnSync("git", args, { cwd: ROOT, stdio: "inherit" });
if (run(["add", "-A"]).status !== 0) process.exit(1);
if (run(["commit", "-q", "-m", msg]).status !== 0) process.exit(1);

const show = spawnSync("git", ["log", "--oneline", "-1"], { cwd: ROOT, encoding: "utf8" });
console.log("\n✅ 门禁全绿，已提交：" + (show.stdout || "").trim());
