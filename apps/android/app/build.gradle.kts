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
}

dependencies {
    implementation(project(":core"))

    implementation(platform(libs.compose.bom))
    implementation(libs.androidx.activityCompose)
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.uiToolingPreview)
    debugImplementation(libs.compose.uiTooling)

    testImplementation(libs.junit)
}
