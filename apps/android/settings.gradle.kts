// Argus — native Android client. Two modules:
//   :core  pure Kotlin/JVM (no Android plugin) — wire models, REST + Socket.IO
//          clients, transcript engine. Tests run without the Android SDK.
//   :app   the Jetpack Compose application.
// See apps/android/README.md and docs/plan-android-native-client.md.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "argus-android"

include(":core")
include(":app")
