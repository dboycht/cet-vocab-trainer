import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
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

        versionCode = 1
        // Single source of truth stays the web app's package.json; this mirrors
        // it. The web UI shows its own version, so the two must not drift.
        versionName = "1.0.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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

// Every merge of assets (debug/release, and the unit-test variants) must run
// after the copy, otherwise the APK ships a stale or empty web app.
// Keep this on ONE line: a statement ending with a bare `}` on a continuation
// line makes Kotlin parse the following block as a member call on it.
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(syncWebAssets) }

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
