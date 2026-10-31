import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

/*
 * Release 签名（2026-10-31 定版 1.0.2 时加入）。
 *
 * ⚠️ 凭据从 `android/keystore.properties` 读，该文件与 .jks 都已被 .gitignore 排除
 *    —— 绝不入库、绝不上传（密钥泄漏等于任何人都能冒充你发布升级包）。
 * ⚠️ 文件缺失时**不能让构建失败**：CI/别人 clone 下来只跑 debug 也得能过。
 *    所以下面用 exists() 守卫，缺失时 signingConfig 为 null，
 *    release 会产出未签名包（此时 assembleRelease 仍可用，只是装不上）。
 * ⚠️ **密钥丢了就没法再升级已发布的版本** —— Android 只认"同一把密钥的更高
 *    versionCode"，换钥匙的老用户必须卸载重装。请把 keystore.properties 与
 *    cvt-release.jks 一起备份到安全的地方。
 */
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "com.dboycht.cetvocab"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dboycht.cetvocab"
        // API 26 covers the WebViewAssetLoader + modern WebView baseline without
        // compat shims. WebView itself is updated through the Play Store on any
        // device this app realistically runs on.
        minSdk = 26
        targetSdk = 36

        versionCode = 2
        // Single source of truth stays the web app's package.json; this mirrors
        // it. The web UI shows its own version, so the two must not drift.
        // 1.0.1 = tag；1.0.2 = 熟练度×遗忘曲线新机制这一轮（安卓端同步移植）。
        versionName = "1.0.2"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
            // The debug build installs ALONGSIDE the real one while testing.
            // Two identical icons named 刷词器 would be a trap, so it says what
            // it is (same convention as the sibling projects).
            resValue("string", "app_name", "刷词器·调试")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // 正式名（不带「·调试」后缀）；debug 那条 resValue 只在 debug 生效，
            // 所以这里用默认的 strings.xml 里的 app_name 即可。
            if (keystorePropsFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// ---------------------------------------------------------------------------
// Bundle the web app into the APK.
//
// The web UI is copied in, never forked: `web/` and `assets/wordbooks/` are the
// single source of truth, so a fix made for the desktop page cannot silently
// miss the phone. The copy is a Gradle task rather than checked-in duplicates
// for exactly that reason.
//
// Layout inside the APK (must match MainActivity's WebViewAssetLoader mounts):
//   assets/web/...     <- ../../web/...
//   assets/assets/...  <- ../../assets/...
//
// `assets/assets/` looks odd but is what keeps the page's own relative data
// path (`./wordbooks/...`) working in both hosts - see server.mjs for the
// desktop half of that arrangement.
//
// ⚠️ Do NOT write a glob like `dir/**` inside a block comment in a .kts file.
// Kotlin block comments NEST, so `/**` opens a nested comment that its own
// `*/` terminator does not close - everything after it (including the whole
// `dependencies { }` block) is then swallowed SILENTLY, with no compiler error.
// That exact mistake cost this project: every AndroidX dependency vanished and
// the only symptom was "resource style/Theme.AppCompat not found".
// ---------------------------------------------------------------------------
val webRoot = layout.projectDirectory.dir("../../web")
val dataRoot = layout.projectDirectory.dir("../../assets")

val syncWebAssets by tasks.registering(Copy::class) {
    from(webRoot) { into("web") }
    from(dataRoot) { into("assets") }
    into(layout.buildDirectory.dir("generated/cvtAssets"))
}

android.sourceSets.getByName("main").assets.srcDir(
    layout.buildDirectory.dir("generated/cvtAssets"),
)

/*
 * 凡是**消费 assets 目录**的任务都必须排在 syncWebAssets 之后，
 * 否则 APK 会打进陈旧或空的 web 应用。
 *
 * ⚠️ 原来只按任务名匹配 `merge*Assets`，**漏掉了 lint**：
 *    release 独有的 `generateReleaseLintVitalReportModel`（LintModelWriterTask）
 *    也会读这个目录，却没被声明依赖 ⇒ Gradle 8 判为配置错误、**构建失败**。
 *    该缺陷 debug 从不触发（debug 不跑 lintVital），只在 release 暴露 ——
 *    正是"定版时才炸"的那类。
 *
 * ⚠️ 不要写成 `tasks.configureEach { inputs.files... }`：那会在**配置期**对所有任务
 *    求值 inputs，其中 extractReleaseNativeSymbolTables 等任务的属性此时还没有值，
 *    直接报 "Cannot query the value of property 'inputDir' because it has no value"。
 *    （本轮踩过：修好 lint 依赖后立刻撞上这个。）
 *    正解是**显式列出**已知会读 assets 的任务名，简单可预测。
 */
val assetsConsumers = listOf(
    "mergeDebugAssets", "mergeReleaseAssets",
    "mergeDebugUnitTestAssets", "mergeReleaseUnitTestAssets",
    // release 的 lint 会读 assets 目录（Gradle 8 要求显式声明这条依赖）
    "generateReleaseLintVitalReportModel", "generateDebugLintReportModel",
    "lintVitalAnalyzeRelease", "lintAnalyzeRelease",
)
tasks.matching { it.name in assetsConsumers }.configureEach { dependsOn(syncWebAssets) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity)
    // WebViewAssetLoader lives here. Loading the app from the
    // appassets.androidplatform.net origin (instead of file://) gives the page
    // a *secure origin*, which is what makes localStorage reliable and keeps the
    // web app's own storage contract intact.
    implementation(libs.androidx.webkit)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
}
