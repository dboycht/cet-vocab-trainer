# ---------------------------------------------------------------------------
# WebView 的 JS 桥接方法必须保留（2026-10-31 定版 1.0.2 时加入）
#
# ⚠️ 本文件原来的注释写着"没有基于反射的序列化，默认规则就够" —— **那是错的**。
#    `@JavascriptInterface` 标注的方法是由网页里的 JS **按字符串名字反射调用**的
#    （见 MainActivity.kt 的 TtsBridge：speak / isAvailable / stop）。
#    ProGuard 只看 Java 字节码里的调用点，看不到"网页会按名字调它"，
#    于是 release（isMinifyEnabled = true）会把这些方法判为无用**直接删掉**。
#    后果：debug 版一切正常，release 版朗读**静默失效** —— 点朗读没反应、
#    也没有任何报错。这类"只在 release 复现"的缺陷最难查，所以用规则钉死。
# ---------------------------------------------------------------------------
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
# 整个桥接类也保留：方法若与类一同被删就无从调用
-keep class com.dboycht.cetvocab.MainActivity$TtsBridge { *; }

# WebViewClient / WebChromeClient 的回调同样靠系统反射调用
-keepclassmembers class * extends android.webkit.WebViewClient {
    public void *(android.webkit.WebView, java.lang.String, android.graphics.Bitmap);
    public boolean *(android.webkit.WebView, java.lang.String);
}
-keepclassmembers class * extends android.webkit.WebChromeClient {
    public void *(android.webkit.WebView, java.lang.String);
}

# 本项目没有其它反射式序列化，其余沿用默认优化规则。
# 保留本文件是因为 app/build.gradle.kts 引用了它。
