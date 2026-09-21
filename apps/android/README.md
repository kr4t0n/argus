# Argus — native Android client

A native **Kotlin + Jetpack Compose** client for the Argus agent dashboard.
Like the iOS client it is a *thin client*: it speaks the same NestJS REST
API + Socket.IO `/stream` namespace as the web app and never touches the
Go sidecar.

> Status: **Phase 2 — app shell.** `:core` holds the full non-UI layer
> (decode-tolerant DTO mirrors of shared-types, the OkHttp REST client,
> the socket.io realtime client as a `Flow` of typed events, and the
> transcript engine ported from ArgusKit — all unit-tested against the
> fixtures shared with the iOS client). `:app` is now a usable phone
> client: server + login, the project-grouped session list, a streaming
> transcript (activity timeline, tool pills, diffs, markdown with math,
> mermaid, sandboxed HTML and inline workspace images), and a composer
> with the prompt queue. Inspector, model picker, attachments, fork,
> palette and push are later phases. The full design, wire contract and
> phase plan are in
> [`docs/plan-android-native-client.md`](../../docs/plan-android-native-client.md).

## CI is the compiler

**Nothing here builds on the dev box, by decision.** The box has no JDK,
Gradle, Kotlin or Android SDK and will not get one; Kotlin is authored
locally and compiled on a Linux runner, the same posture the Swift client
has with `ios.yml`. `.github/workflows/android.yml` is therefore the
primary verifier: it runs on push to `main`, `dev` and `feat/android-*`,
on pull requests, on `workflow_dispatch`, and on edits to the files the
Kotlin side mirrors (`contextWindow.ts`, `hotkeys.ts`, the shared fixtures):

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

## Approach: hand-written mirror + captured fixtures (no codegen)

Kotlin models are **hand-written, decode-tolerant mirrors** of
`packages/shared-types` (`api.ts` / `protocol.ts` / `ws.ts`), decoded
through one `Json` instance (`ArgusJson`):

- unknown JSON fields are ignored (`ignoreUnknownKeys` — never add
  strictness that rejects them; the server ships fields shared-types
  omits, e.g. a denormalized `usage` on command rows),
- every wire enum has an explicit `TolerantEnumSerializer`, so an
  unrecognized value decodes to its `UNKNOWN` member instead of failing
  the payload (chosen over `coerceInputValues` alone, which only coerces
  when the property declares a default — one forgotten default would
  silently reintroduce strict decoding),
- `ResultChunk.ts` absorbs both wire dressings of the same row (WS relays
  carry numeric millis; REST rows serialize an ISO string) through
  `EpochMillisSerializer`,
- `explicitNulls = false`: absent nullable fields decode as `null`, and
  null properties are omitted when encoding. The one body that needs an
  explicit JSON null (`PATCH /sessions/:id/model` clearing the model) is
  built as a `JsonObject` instead — see `UpdateSessionModelRequest`.

Contract confidence comes from **fixtures captured from a real server**,
shared with ArgusKit:

```bash
# repo root; needs a running server + jq. Credentials fall back to
# ADMIN_EMAIL/ADMIN_PASSWORD in .env.
scripts/capture-client-fixtures.sh [--session <id>]
```

That writes sanitized responses (tokens redacted, long strings truncated)
into `packages/shared-types/fixtures/`, and `FixtureDecodingTest` decodes
every one of them in CI — as does ArgusKit's `FixtureDecodingTests` on the
macOS runner, so one capture re-proves both mirrors. **When shared-types
changes shape: re-run the capture script, run the tests, commit the
fixture diff.** Review the diff before committing — fixtures can embed
real prompt text and the repo is public.

## Layout

```
apps/android/
├── settings.gradle.kts         two modules, repositories, FAIL_ON_PROJECT_REPOS
├── build.gradle.kts            plugin versions (apply false) — no kotlin-android, see below
├── gradle/libs.versions.toml   the version catalog: every entry an exact pin
├── gradle/wrapper/             Gradle 9.7.1, checksum-pinned (see "Toolchain")
├── core/                       plain Kotlin/JVM — counterpart of ArgusKit
│   └── src/main/kotlin/app/argus/core/
│       ├── ArgusJson.kt        the one decode-tolerant Json instance
│       ├── model/              DTO mirrors (JsonSupport, Enums, Session/Fleet/Files/User/…)
│       ├── api/                ArgusClient (OkHttp), ServerConfig, ApiError
│       ├── realtime/           StreamClient (socket.io → Flow<ServerEvent>), ProjectRoomRegistry
│       └── engine/             TranscriptEngine, DeltaSplit, UsageMath, ContextWindow,
│                               Math{Delimiters,Segments}, InlineMath, AnswerSegments,
│                               FileReferences, ToolDisplay, DedicatedPanels, SessionMatch,
│                               SearchSnippet, ProjectGroups, DiffLines, PromptQueue, RelativeTime
└── app/                        Jetpack Compose application (app.argus.android)
    ├── src/main/assets/        mermaid-android.html — the WebView host page for ```mermaid
    │                           (mermaid.min.js itself comes from apps/ios/Argus/Resources, see below)
    ├── src/test/               MermaidLockstepTest — pins the vendored mermaid to the web's version
    └── src/main/kotlin/app/argus/android/
        ├── ArgusApplication.kt process-scoped owner of AppModel; foreground hook
        ├── AppModel.kt         auth, socket, event routing, VM cache, queue drainer
        ├── store/              FleetStore, SessionListStore, QueueStore (StateFlow-backed)
        ├── session/            SessionViewModel — TranscriptState + room + start()/revalidate
        └── ui/                 ArgusApp (phase switch + routes), login/, sessions/ (list),
                                session/ (transcript, composer, activity timeline, panels),
                                markdown/ (AnswerView, Markwon host, WebView blocks, images),
                                components/ (atoms, DiffBlock, FileChips), theme/
```

`:core` has **no Android plugin**. It compiles and tests on any JDK 17
without the SDK, so its job in CI fails fast and its tests are ordinary
JUnit 4 (via `kotlin.test`). Tests live under `core/src/test/kotlin` in
the same packages; `TestSupport.kt` provides the chunk/command/session
builders and the fixture locator (Gradle passes the repo root and fixture
directory as system properties; an IDE run falls back to a walk-up).

Ports that must stay in lockstep with their TypeScript originals (the
same table ArgusKit keeps, so a change lands on all three clients):

| Kotlin (`core/src/main/kotlin/app/argus/core/`) | TypeScript original |
| --- | --- |
| `engine/DeltaSplit.kt` | `apps/web/src/lib/deltaSplit.ts` (also ported on the server as `PushService.answerPreview`) |
| `engine/UsageMath.kt` | `packages/shared-types/src/usage.ts` |
| `engine/ContextWindow.kt` | `packages/shared-types/src/contextWindow.ts` — **hash-pinned** by `ContextWindowLockstepTest`; `android.yml` triggers on the TS path |
| `engine/MathDelimiters.kt`, `MathSegments.kt`, `InlineMath.kt` | `apps/web/src/lib/markdown.ts` delimiter rules (semantic port; deviations documented in-file) |
| `engine/FileReferences.kt` | `apps/web/src/components/FileChips.tsx` helpers + the `img` source split in `MarkdownImage.tsx` |
| `engine/SessionMatch.kt` | `apps/web/src/lib/sessionMatch.ts` (Ctrl+P ranking — weights, bonuses, tie-breaks) |
| `engine/SearchSnippet.kt` | `renderSnippet` in `CommandPalette.tsx` + `SEARCH_HL_START`/`SEARCH_HL_STOP` in `api.ts` |
| `realtime/StreamClient.kt` events | `packages/shared-types/src/ws.ts` |
| `model/*` | `packages/shared-types/src/{api,protocol}.ts` |

`MathCompat` is deliberately not ported: the Android renderer uses
JLatexMath (via Markwon's LaTeX extension), whose LaTeX subset makes
SwiftMath's rewrites unnecessary (plan §5).

## The app module (Phase 2)

**State lives on the process, not the Activity.** `ArgusApplication`
owns one `AppModel` (auth, the socket, the stores, the session view-model
cache); `MainActivity` only installs the theme and the root composable.
Configuration changes are handled in-place (`configChanges` in the
manifest) so the socket and the transcript survive rotation and theme
flips. Every store exposes `StateFlow`s that Compose collects; all
mutation happens on `Dispatchers.Main.immediate`, including the socket
event pump.

**Persistence is SharedPreferences, not DataStore** (a deviation from the
plan's first draft): the app persists four small values — server URL,
email, the JWT, and the prompt queue as JSON — and DataStore would add a
dependency plus an async read on the launch path for no gain. The JWT is
also held in a `@Volatile` field the OkHttp token provider reads from its
own threads.

**Session view-models are cached** (LRU, cap 8, never the one on screen,
cleared on logout) exactly like the iOS `AppModel`: `SessionViewModel.
start()` is idempotent — a cold VM loads the tail snapshot, a cached one
re-joins its room and *revalidates* (refetches the tail and merges when it
overlaps the cached window; wipes and replaces when it doesn't).

**The prompt queue is drained app-wide** by `AppModel` (port of the web's
`queueDrainer`): serialization is per session (never two turns for one
session), reachability is machine-level, a 30 s in-flight bridge covers
the dispatch → first-chunk window, and a failed send stalls that session
for 60 s. The composer's send always goes through the queue so a manual
submit joins the tail of a draining backlog.

**Answer rendering** is a column of segments produced by
`AnswerSegments.split` (`:core`, layered on `MathSegments`): markdown
pieces go through **Markwon** (GFM tables, strikethrough, task lists,
linkify, and JLatexMath for `$$…$$`) hosted in an `AndroidView`
`TextView`; single-dollar inline math is rewritten to Markwon's
double-dollar form by `MarkwonMath.rewriteInline`. Markwon was chosen over
a Compose-native renderer because it ships tables, task lists and LaTeX in
one library; it is View-based and dormant since 2021, which is accepted
for now. Closed ```` ```mermaid ```` and ```` ```html ```` fences render
in `WebView` hosts with a Source toggle (an unclosed fence stays a code
block while streaming, and a diagram that fails to parse keeps the last
good render, as on the web); standalone `![alt](path)` images inside the
workspace are fetched over fs-read. The mermaid runtime is **not copied**:
the `app` module adds `apps/ios/Argus/Resources` as an asset source
directory, so the one vendored `mermaid.min.js` serves both native
clients, and `MermaidLockstepTest` (an `:app` unit test) pins its version
to the web's resolved dependency in `pnpm-lock.yaml`. After bumping
mermaid on the web, run `scripts/sync-ios-mermaid.sh` and both clients
pick it up. `securityLevel: 'strict'` and cancel-every-navigation are the
same posture as the web and iOS.

**Cleartext is allowed app-wide** (`usesCleartextTraffic="true"`). The
plan wanted it only for LAN hosts, but Android's network security config
takes domain lists, not CIDR ranges, so a private-IP carve-out cannot be
expressed there; `ServerConfig` still infers `http://` only for private
hosts and `https://` otherwise.

Deliberately not ported in this phase: sticky turn headers (the iOS
`pinnedViews` band — plain items in the `LazyColumn` instead), the
vendors' brand glyphs (a brand-coloured monogram stands in), and
persisted collapse / archived-reveal state for the session list.

## Wire rules the client encodes

- **Fork holds the response.** `POST /sessions/:id/fork` blocks until the
  sidecar's clone settles (up to 15 s server-side). OkHttp's default read
  timeout is 10 s, so `forkSession` uses a dedicated client with a 30 s
  read timeout. `dispatch` returns 409 while a clone is pending — treat
  it as retry-after-cooldown, not a hard failure.
- **Body-less POSTs are sent with an empty body** (archive, seen, cancel,
  sidecar update): OkHttp refuses a POST without one.
- **Responses are gzipped**; OkHttp negotiates and inflates that itself
  as long as the client never sets `Accept-Encoding`.
- **Project rooms are refcounted** (`ProjectRoomRegistry`): Socket.IO's
  `leave` is not, and the first unmounting holder would otherwise starve
  the rest of `fs:changed`. Rooms are per connection — replay them with
  `rejoinProjectRooms()` on every `Connected`, and backfill chunks over
  REST (`getSessionChunks(afterSeq)`); there is no socket replay buffer.
- **`org.json` is excluded from socket.io-client-java** in `:core` and
  restored only on the JVM test runtime: Android ships it in the
  platform, and the app module would fail lint's `DuplicatePlatformClasses`.

## Toolchain and pins

| Component | Version | Why this one |
| --- | --- | --- |
| Gradle (wrapper) | 9.7.1 | AGP 9.4 needs ≥ 9.6.0; distribution SHA-256 pinned in `gradle-wrapper.properties` |
| Android Gradle Plugin | 9.4.1 | latest stable; built-in Kotlin, supports compileSdk 37, needs JDK 17 |
| Kotlin | 2.4.10 | the version the current Android Compose docs pair with this AGP; Compose compiler + serialization plugins ship at it |
| kotlinx.serialization | 1.11.0 | built against Kotlin 2.3.x, compatible with 2.4 |
| kotlinx.coroutines | 1.11.0 | `Flow` for the realtime layer, `suspend` for the REST client |
| OkHttp | 5.5.0 | REST + the WebSocket factory socket.io uses; mockwebserver rides the same version |
| socket.io-client-java | 2.1.2 | speaks the Socket.IO v4 protocol the server runs; supports the `auth` handshake |
| Compose BOM | 2026.09.00 | one source of truth for Compose artifact versions |
| activity-compose / lifecycle-process | 1.13.0 / 2.11.0 | `setContent` + `BackHandler`; `ProcessLifecycleOwner` for the foreground refresh |
| Markwon | 4.6.2 | markdown → `Spanned` with tables, task lists, strikethrough, linkify and JLatexMath in one library (last release; accepted) |
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

See the plan for the full phase list. In short: **0** CI bootstrap ✅ →
**1** core module ✅ → **2** login, session list, streaming transcript,
composer with the queue ✅ (this; a device round-trip is still owed) →
**3** inspector, model picker, attachments, fork, palette and hotkeys →
**4** fleet and account panels → **5** push (FCM, with the server-side
transport split) → **6** terminal and Live Updates.
