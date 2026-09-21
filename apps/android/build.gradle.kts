// Top-level build file. Plugins are declared here with `apply false` so that
// every module resolves the same, catalog-pinned versions.
//
// Note on Kotlin: AGP 9 has built-in Kotlin support and applies it to every
// Android module itself, so `org.jetbrains.kotlin.android` is deliberately
// NOT declared anywhere (applying it under AGP 9 is an error). AGP's own
// runtime dependency is on an older KGP; declaring `kotlin.jvm` here puts the
// catalog's KGP on the build classpath, which is what AGP's built-in Kotlin
// then uses — the same effect as the `buildscript { classpath(...) }` recipe
// in the AGP 9 release notes ("Upgrade to a higher KGP version").
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
