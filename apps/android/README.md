# Argus — native Android client

A native **Kotlin + Jetpack Compose** client for the Argus agent dashboard.
Like the iOS client it is a *thin client*: it speaks the same NestJS REST
API + Socket.IO `/stream` namespace as the web app and never touches the
Go sidecar.

> Status: **Phase 0 — CI bootstrap.** The Gradle project, an empty core
> module with its first decode-tolerance test, an empty Compose activity,
> and the `android` workflow. No product features yet. The full design,
> wire contract, lockstep table and phase plan are in
> [`docs/plan-android-native-client.md`](../../docs/plan-android-native-client.md).

## CI is the compiler

**Nothing here builds on the dev box, by decision.** The box has no JDK,
Gradle, Kotlin or Android SDK and will not get one; Kotlin is authored
locally and compiled on a Linux runner, the same posture the Swift client
has with `ios.yml`. `.github/workflows/android.yml` is therefore the
primary verifier: it runs on push to `main`, `dev` and `feat/android-*`,
on pull requests, and by hand:

```bash
gh workflow run android.yml --ref feat/android-native-client
gh run watch                       # or: gh run view --log-failed
```

A change is *unverified* until the workflow has run on it; say so in the
PR if it hasn't. The `app` job uploads the debug APK as an artifact
(`argus-android-debug-apk`) for installing on a device.

If you do have a JDK 17 locally, the same commands work:

```bash
cd apps/android
./gradlew :core:build                                          # no Android SDK needed
./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest   # needs the SDK
```

## Layout

```
apps/android/
├── settings.gradle.kts         two modules, repositories, FAIL_ON_PROJECT_REPOS
├── build.gradle.kts            plugin versions (apply false) — no kotlin-android, see below
├── gradle/libs.versions.toml   the version catalog: every entry an exact pin
├── gradle/wrapper/             Gradle 9.7.1, checksum-pinned (see "Toolchain")
├── core/                       plain Kotlin/JVM — counterpart of ArgusKit
│   └── src/main/kotlin/app/argus/core/
│       └── ArgusJson.kt        the one decode-tolerant Json instance
└── app/                        Jetpack Compose application (app.argus.android)
    └── src/main/kotlin/app/argus/android/MainActivity.kt
```

`:core` has **no Android plugin**. It compiles and tests on any JDK 17
without the SDK, so its job in CI fails fast and its tests stay ordinary
JUnit. Everything that is not UI lives there: wire models, the REST and
Socket.IO clients, the transcript engine and the lockstep ports (Phase 1).

## Toolchain and pins

| Component | Version | Why this one |
| --- | --- | --- |
| Gradle (wrapper) | 9.7.1 | AGP 9.4 needs ≥ 9.6.0; distribution SHA-256 pinned in `gradle-wrapper.properties` |
| Android Gradle Plugin | 9.4.1 | latest stable; built-in Kotlin, supports compileSdk 37, needs JDK 17 |
| Kotlin | 2.4.10 | the version the current Android Compose docs pair with this AGP; Compose compiler + serialization plugins ship at it |
| kotlinx.serialization | 1.11.0 | built against Kotlin 2.3.x, compatible with 2.4 |
| Compose BOM | 2026.09.00 | one source of truth for Compose artifact versions |
| JUnit | 4.13.2 | AGP's default unit-test framework; used on both modules so there is one |

Rules that fall out of AGP 9:

- **Never apply `org.jetbrains.kotlin.android`.** AGP 9 compiles Kotlin
  itself ("built-in Kotlin") and applying that plugin is an error. The
  catalog's Kotlin version still reaches Android modules: declaring
  `kotlin.jvm` in the top-level `plugins {}` puts it on the build
  classpath, which AGP's built-in Kotlin uses in preference to its own
  older runtime dependency.
- Kotlin's `jvmTarget` in `:app` follows `compileOptions.targetCompatibility`
  (17); `:core` pins the same through `jvmToolchain(17)`.

**Updating a pin:** change the number in `libs.versions.toml` (or the
wrapper properties, with its new `distributionSha256Sum` from
`https://services.gradle.org/distributions/gradle-<v>-bin.zip.sha256`),
push, and let the workflow prove it. Check the AGP release notes'
"Compatibility" table first — the Gradle floor and JDK floor move with
AGP.

**Wrapper provenance:** the dev box cannot run `gradle wrapper`, so
`gradle-wrapper.jar` was taken from the Gradle repository at the release
tag and its SHA-256 (`7a9ce74c…`) checked against Gradle's published
`gradle-9.7.1-wrapper.jar.sha256` before committing. `setup-gradle`
re-validates it against the same list on every CI run.

## Roadmap

See the plan for the full phase list. In short: **0** CI bootstrap (this)
→ **1** core module with DTO mirrors, clients, engine ports, shared
fixtures and the two lockstep tests → **2** login, session list,
streaming transcript, composer → **3** inspector, model picker, queue,
attachments, palette and hotkeys → **4** fleet and account panels →
**5** push (FCM, with the server-side transport split) → **6** terminal
and Live Updates.
