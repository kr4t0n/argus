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
    implementation(libs.kotlinx.coroutinesCore)
    implementation(libs.okhttp)

    // socket.io-client-java pulls org.json, which Android already ships in
    // the platform — the app module would fail lint's DuplicatePlatformClasses
    // check. Excluded here; :core compiles against it, and the JVM test
    // runtime gets it back below. (The app inherits the platform copy.)
    implementation(libs.socketio.client) {
        exclude(group = "org.json", module = "json")
    }
    compileOnly(libs.orgJson)

    // kotlin("test") resolves to kotlin-test-junit because tasks.test uses
    // JUnit 4 below — same framework as :app's AGP-default unit tests.
    testImplementation(kotlin("test"))
    testImplementation(libs.mockwebserver)
    testRuntimeOnly(libs.orgJson)
}

tasks.test {
    useJUnit()
    // The repo root and the fixture directory shared with ArgusKit
    // (packages/shared-types/fixtures); TestSupport.kt falls back to a
    // walk-up when these are absent (IDE runs).
    val repoRoot = rootDir.parentFile.parentFile.canonicalFile
    systemProperty("argus.repoRoot", repoRoot.path)
    systemProperty("argus.fixtures", repoRoot.resolve("packages/shared-types/fixtures").path)
}
