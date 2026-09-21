// :core — everything except UI, as a PLAIN Kotlin/JVM module. No Android
// plugin, so it compiles and tests on any JDK 17 without the Android SDK;
// the counterpart of apps/ios/ArgusKit.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(libs.kotlinx.serializationJson)

    // kotlin("test") resolves to kotlin-test-junit because tasks.test uses
    // JUnit 4 below — same framework as :app's AGP-default unit tests.
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnit()
}
