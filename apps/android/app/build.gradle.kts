// :app — the Jetpack Compose application. Kotlin compilation comes from
// AGP 9's built-in Kotlin (no kotlin-android plugin); its jvmTarget follows
// compileOptions.targetCompatibility below.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "app.argus.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.argus.android"
        // 26+: Compose, OkHttp and notification channels are all comfortable
        // here; Live Updates (API 36) are gated at runtime.
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            // Debug signing only until there is somewhere to publish; see the
            // plan's open questions.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    sourceSets {
        getByName("main") {
            // The ```mermaid runtime is vendored ONCE, under the iOS app's
            // Resources (mermaid.min.js + mermaid.LICENSE, pinned to the
            // web's resolved version by both clients' lockstep tests).
            // Pointing the asset source set at it keeps a 3 MB bundle out
            // of the repo twice; the Android host page lives in
            // src/main/assets and loads mermaid.min.js from the merged
            // asset root. Re-vendor with scripts/sync-ios-mermaid.sh.
            assets.srcDirs("src/main/assets", "../../ios/Argus/Resources")
        }
    }
}

dependencies {
    implementation(project(":core"))
    // :core exposes kotlinx JsonObject in its public API (ResultChunk.meta,
    // CommandDTO.options, TimelineItem.toolInput) but declares the library
    // as `implementation`, so the app must add it to see those types.
    implementation(libs.kotlinx.serializationJson)

    // Dispatchers.Main on Android needs the -android artifact.
    implementation(libs.kotlinx.coroutinesAndroid)
    // ProcessLifecycleOwner: disconnect the socket in the background,
    // reconnect through the snapshot path in the foreground.
    implementation(libs.androidx.lifecycleProcess)
    // NotificationCompat for the turn-finished banners.
    implementation(libs.androidx.coreKtx)
    // Push (Phase 5): FCM registration tokens + the messaging service.
    // Firebase is initialised at RUNTIME from the server's public client
    // identifiers — no google-services.json, no google-services plugin —
    // so one APK works against any server. See push/AndroidPushBridge.kt.
    implementation(libs.firebase.messaging)

    implementation(platform(libs.compose.bom))
    implementation(libs.androidx.activityCompose)
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.materialIconsCore)
    implementation(libs.compose.uiToolingPreview)
    debugImplementation(libs.compose.uiTooling)

    // Answer markdown: Markwon (GFM tables, strikethrough, task lists,
    // LaTeX via JLatexMath) rendered into a TextView hosted by AndroidView.
    // Chosen over a Compose-native renderer for its LaTeX support and
    // stable plugin API; see apps/android/README.md.
    implementation(libs.markwon.core)
    implementation(libs.markwon.extTables)
    implementation(libs.markwon.extStrikethrough)
    implementation(libs.markwon.extTasklist)
    implementation(libs.markwon.extLatex)
    implementation(libs.markwon.inlineParser)
    implementation(libs.markwon.linkify)

    testImplementation(libs.junit)
}
