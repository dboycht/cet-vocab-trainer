package com.dboycht.cetvocab

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.AssetManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import java.util.Locale

/**
 * The whole Android port: a WebView shell around the existing offline web app.
 *
 * Design notes (why it is built this way)
 * ---------------------------------------
 * ① The page is served from https://appassets.androidplatform.net/ via
 *    [WebViewAssetLoader], NOT from file://. Under file:// the page gets a
 *    "null" origin and localStorage behaviour varies by WebView version - and
 *    localStorage is where all learning progress lives. The asset-loader origin
 *    is a *secure origin*, so the web app keeps the exact storage semantics it
 *    has in a desktop browser.
 *
 * ② The web app is bundled verbatim (`web/` and `assets/` are copied into the
 *    APK by a Gradle task in app/build.gradle.kts). There is deliberately no
 *    forked copy of the UI: one source of truth, so a fix on the desktop page
 *    cannot miss the phone.
 *
 * ③ Reading words aloud goes through [TtsBridge] only when the WebView's own
 *    speech synthesis is unavailable. Some Android WebView builds ship without
 *    a working `speechSynthesis`, so relying on it alone would leave the 🔊
 *    button dead on exactly the devices this port targets.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        with(webView.settings) {
            javaScriptEnabled = true
            // Both are required for localStorage to persist across launches.
            domStorageEnabled = true
            databaseEnabled = true
            // The page is already sized for phones; a fixed text zoom keeps the
            // "铅字卡片盒" layout from being rescaled by system font settings.
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }

        webView.addJavascriptInterface(TtsBridge(), "AndroidTts")

        val assetLoader = WebViewAssetLoader.Builder()
            // The web app lives under assets/web/ and the wordbook data under
            // assets/assets/ (the copy is a Gradle task - see build.gradle.kts).
            //
            // ⚠️ The page asks for its data with a path RELATIVE TO ITSELF
            // (`./wordbooks/...`), and the page sits at /web/index.html, so the
            // request arrives as `/web/wordbooks/...`. That is why the data mount
            // is nested UNDER /web/ rather than at the origin root: mounting it
            // at `/wordbooks/` leaves every fetch 404-ing, which the UI can only
            // report as "没有找到词库" - a misleading symptom for a path mismatch.
            .addPathHandler("/web/wordbooks/", SubdirAssetsHandler(this, "assets/wordbooks"))
            .addPathHandler("/web/", SubdirAssetsHandler(this, "web"))
            // Kept for the desktop server's absolute form, harmless in the app.
            .addPathHandler("/assets/", SubdirAssetsHandler(this, "assets"))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val resp = assetLoader.shouldInterceptRequest(request.url)
                android.util.Log.d("CVT_ASSET", "INTERCEPT ${request.url} -> ${if (resp == null) "null" else "ok ${resp.mimeType}(${resp.encoding})"}")
                return resp
            }

            /** Keep everything in-app; there is no legitimate outbound link. */
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = true
        }

        // System WebView TTS is used when present; this native engine is the
        // fallback the JS calls into when `speechSynthesis` is missing.
        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (!ttsReady) tts = null
        }

        // Back button: leave the answer/feedback state or step back a view
        // instead of killing the app mid-session. The web app exposes a boolean
        // hook (`window.__cvtHandleBack`) so the *page* decides - the shell must
        // not guess at app state.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function(){try{return window.__cvtHandleBack&&window.__cvtHandleBack();}catch(e){return false;}})()"
                ) { result ->
                    if (result != "true") finish()
                }
            }
        })

        if (savedInstanceState == null) {
            webView.loadUrl("https://appassets.androidplatform.net/web/index.html")
        } else {
            webView.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }

    /**
     * Native TTS, reachable from the page as `window.AndroidTts.speak(text)`.
     *
     * 为什么失败时要 Toast 而不是静默 return：实测本机（PKS110 / Android 16）
     * `settings get secure tts_default_synth` 返回 **null** —— 系统里根本没有设置
     * 默认 TTS 引擎，于是 `TextToSpeech(...)` 初始化失败。此时网页侧完全看不出
     * 异常（按钮照样高亮），用户只会觉得"点了没反应"。**静默失败是最差的失败**：
     * 必须明确告诉他"系统缺语音引擎、去哪儿装"。
     */
    inner class TtsBridge {
        private var warned = false

        private fun warnOnce(msg: String) {
            if (warned) return
            warned = true
            Toast.makeText(this@MainActivity, msg, Toast.LENGTH_LONG).show()
        }

        @JavascriptInterface
        fun speak(text: String) {
            if (text.isBlank()) return
            runOnUiThread {
                val engine = tts
                if (engine == null || !ttsReady) {
                    warnOnce("系统没有可用的语音引擎，朗读不可用。\n可在「设置 → 无障碍 → 文字转语音」安装并启用一个引擎。")
                    return@runOnUiThread
                }
                val res = engine.setLanguage(Locale.US)
                if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                    warnOnce("系统未安装英文语音包，朗读不可用。\n可在「设置 → 无障碍 → 文字转语音」里安装英文数据。")
                    return@runOnUiThread
                }
                engine.setSpeechRate(0.88f)
                engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "cvt-word")
            }
        }

        /** 供网页查询朗读是否真的可用（避免按钮高亮了却不出声）。 */
        @JavascriptInterface
        fun isAvailable(): Boolean = ttsReady && tts != null

        @JavascriptInterface
        fun stop() {
            runOnUiThread { tts?.stop() }
        }
    }
}

/**
 * Serves files from a subdirectory of the APK's `assets/`.
 *
 * `WebViewAssetLoader.AssetsPathHandler` can only serve from the asset *root*,
 * but this app keeps the web UI under `assets/web/` and the wordbooks under
 * `assets/assets/` (see app/build.gradle.kts). Without this handler the page
 * 404s on everything and the only visible symptom is a blank view.
 *
 * Path safety: the requested path is normalised and rejected if it escapes the
 * subdirectory, so a stray `../` in the page cannot read other assets.
 */
private class SubdirAssetsHandler(
    private val context: Context,
    private val subdir: String,
) : WebViewAssetLoader.PathHandler {

    private val prefix = subdir.trimEnd('/') + "/"

    override fun handle(path: String): WebResourceResponse? {
        // `path` arrives with a leading slash, e.g. "/index.html".
        val rel = path.removePrefix("/")
        val full = "$prefix$rel"
        android.util.Log.d("CVT_ASSET", "subdir=$subdir path=$path -> full=$full")
        // Reject traversal: normalise and require the result to stay under prefix.
        val normalized = try {
            java.nio.file.Paths.get(full).normalize().toString().replace('\\', '/')
        } catch (_: Exception) {
            return null
        }
        if (!normalized.startsWith(prefix)) return null

        return try {
            val stream = context.assets.open(normalized, AssetManager.ACCESS_STREAMING)
            android.util.Log.d("CVT_ASSET", "OPEN OK $normalized")
            WebResourceResponse(mimeOf(normalized), charsetOf(normalized), stream).apply {
                // The app is fully offline and updated only by reinstalling, so
                // caching in the WebView is safe and makes relaunch instant.
                responseHeaders = mapOf("Cache-Control" to "max-age=86400")
            }
        } catch (e: java.io.IOException) {
            android.util.Log.e("CVT_ASSET", "OPEN FAIL $normalized :: ${e.message}")
            null // let the default (404) handling take over
        }
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "html", "htm" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "woff2" -> "font/woff2"
        else -> "application/octet-stream"
    }

    private fun charsetOf(name: String): String? = when (name.substringAfterLast('.', "").lowercase()) {
        "html", "htm", "js", "mjs", "css", "json", "svg" -> "utf-8"
        else -> null
    }
}
