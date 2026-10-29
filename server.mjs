/**
 * 四六级词汇刷词器 —— 零依赖本地服务
 *
 * 为什么需要一个本地服务而不是直接双击 HTML：
 *   浏览器在 file:// 下会给页面一个 "null" 来源，localStorage/IndexedDB 的行为
 *   各浏览器不一致（清缓存、隐私模式下会丢），学习进度是不能丢的数据。
 *   起一个 127.0.0.1 的小服务，来源就稳定了。
 *
 * 用法：
 *   node server.mjs                # 绑 127.0.0.1，自动开浏览器
 *   node server.mjs --lan          # 绑 0.0.0.0，手机连同一 WiFi 也能刷
 *   node server.mjs --port 9000    # 指定端口
 *   node server.mjs --no-open      # 不开浏览器
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const WEB_DIR = join(ROOT, "web");
const ASSETS_DIR = join(ROOT, "assets");

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const LAN = has("--lan");
const NO_OPEN = has("--no-open");
const HOST = LAN ? "0.0.0.0" : "127.0.0.1";
const START_PORT = Number(valOf("--port", "8710")) || 8710;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/** 把 URL 路径安全地映射到磁盘路径，挡掉 ../ 穿越。 */
function safeJoin(baseDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, "");
  const full = join(baseDir, rel);
  const baseWithSep = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (full !== baseDir && !full.startsWith(baseWithSep)) return null;
  return full;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": statSync(filePath).size,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

/** 词库清单：扫 assets/wordbooks/*.json，readme 里的 index.json 另行处理。 */
function wordbookManifest() {
  const dir = join(ASSETS_DIR, "wordbooks");
  const indexPath = join(dir, "index.json");
  if (existsSync(indexPath)) {
    try {
      return JSON.parse(readFileSync(indexPath, "utf8"));
    } catch {
      /* 落到下面兜底 */
    }
  }
  return { wordbooks: [] };
}

/**
 * 页面取数据的路径是**相对页面**的（`./wordbooks/...`），所以两侧都必须把
 * `/wordbooks/` 这一层挂到 `assets/wordbooks/` 上：
 *   - 桌面：页面在 `/`（由 web/index.html 提供）⇒ 相对路径解析成 `/wordbooks/...`
 *   - 安卓壳：页面在 `/web/index.html` ⇒ 解析成 `/web/wordbooks/...`
 *     （见 MainActivity.kt 的 WebViewAssetLoader 挂载）
 *
 * 为什么不让前端写 `/assets/wordbooks/...` 这种绝对路径：同一份前端要跑在两种宿主里，
 * 绝对路径在其中一种必然 404，而症状只是「没有找到词库」，很难查出真因。
 * 让**每个宿主**各自承担自己的路径映射，前端只管「和我同级的 wordbooks/」。
 */
const WORD_BOOKS_DIR = join(ASSETS_DIR, "wordbooks");

/** 把 `<prefix>` 之后的相对路径安全地映射到词库目录下。 */
function serveWordbook(res, url, prefix) {
  const full = safeJoin(WORD_BOOKS_DIR, url.slice(prefix.length - 1));
  if (!full || !existsSync(full) || !statSync(full).isFile()) {
    return send(res, 404, "not found");
  }
  return sendFile(res, full);
}

const server = createServer((req, res) => {
  const url = req.url || "/";

  if (url === "/api/wordbooks") {
    return send(res, 200, JSON.stringify(wordbookManifest()), {
      "Content-Type": MIME[".json"],
    });
  }

  // 桌面宿主：页面在 / ⇒ 相对路径落到 /wordbooks/**
  if (url.startsWith("/wordbooks/")) return serveWordbook(res, url, "/wordbooks/");
  // 安卓壳的页面布局（/web/index.html）：同一个挂载点在 /web/ 下也成立，
  // 这样才能让探针用同一套相对路径去验壳里的页面。
  if (url.startsWith("/web/wordbooks/")) return serveWordbook(res, url, "/web/wordbooks/");

  // 兼容旧路径（README / 外部书签可能仍在用绝对形式）
  if (url.startsWith("/assets/")) {
    const full = safeJoin(ASSETS_DIR, url.slice("/assets".length));
    if (!full || !existsSync(full) || !statSync(full).isFile()) {
      return send(res, 404, "not found");
    }
    return sendFile(res, full);
  }

  // 静态页面
  let full = safeJoin(WEB_DIR, url === "/" ? "/index.html" : url);
  if (!full) return send(res, 403, "forbidden");
  if (!existsSync(full) || statSync(full).isDirectory()) {
    // 只有「无扩展名的路径」才回退到单页应用；带扩展名却找不到的资源直接 404，
    // 否则 fetch 一个不存在的 .json 会拿到一段 HTML，报出让人看不懂的解析错误。
    if (extname(url.split("?")[0])) return send(res, 404, "not found");
    full = join(WEB_DIR, "index.html");
    if (!existsSync(full)) return send(res, 404, "not found");
  }
  return sendFile(res, full);
});

/** 端口被占就顺延，最多试 12 个。 */
function listen(port, attemptsLeft = 12) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error("[FAIL] 无法监听端口:", err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const local = `http://127.0.0.1:${port}/`;
    console.log("");
    console.log("  四六级词汇刷词器 已启动");
    console.log("  ----------------------------------------");
    console.log(`  本机访问 : ${local}`);
    if (LAN) {
      for (const [name, addrs] of Object.entries(networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === "IPv4" && !a.internal) {
            console.log(`  手机访问 : http://${a.address}:${port}/   (${name})`);
          }
        }
      }
    }
    console.log("  停止服务 : 在本窗口按 Ctrl+C");
    console.log("");
    if (!NO_OPEN) openBrowser(local);
  });
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.log("  (没能自动打开浏览器，请手动复制上面的地址)");
  }
}

listen(START_PORT);
