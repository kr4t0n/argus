# Plan: native Android client — Kotlin + Jetpack Compose

Status: 🟡 IN PROGRESS · Phase 0 ✅ (2026-09-21) · Phase 1 ✅ (2026-09-21, `android.yml` and `ios.yml` both green on the branch) · Phase 2 next
Branch: `feat/android-native-client` (PRs target `dev`)
Prereq: none — the server contract the client speaks is already frozen by the
iOS client and its captured fixtures.

> **Posture in one line:** a thin native client with the same shape as
> `apps/ios/` — a pure-logic core module plus a UI module — that speaks the
> NestJS REST API and the Socket.IO `/stream` namespace, never touches the
> sidecar, and is **compiled and tested only in GitHub Actions**. The dev
> box has no JDK, Gradle, Kotlin, or Android SDK and will not get one; like
> Swift, CI is the compiler.

## 1. Motivation

Argus has a web dashboard and a feature-complete native iOS/iPadOS client.
An Android client closes the mobile gap for the same reasons the iOS one
exists: turn-completion alerts that survive the app being backgrounded,
read-sync across devices, a lock-screen card for a running turn, and a
transcript that renders the CLI's markdown, math, diagrams and diffs the
way the web does.

The iOS client already proved the load-bearing property: the server needs
no client-specific surface beyond push-device registration. Android inherits
that contract wholesale. What it does not inherit is the toolchain problem
the iOS client lives with — and the decision below is to keep the *same*
posture on purpose rather than exploit the difference.

## 2. Decisions

**CI is the compiler, by request.** The Android toolchain would run on the
Linux dev box, but the maintainer is not installing it there. So
`.github/workflows/android.yml` is the primary verifier exactly as
`ios.yml` is for Swift: Kotlin is authored locally, pushed, and compiled on
an `ubuntu-latest` runner. Every phase's exit criterion below is "the
workflow is green", not "it runs on my machine". A change is *unverified*
until CI has run on it and the PR description must say so if it hasn't.
The one upside kept from the alternative: no macOS runner is involved, so
the workflow is cheaper and faster than `ios.yml`.

**Native Kotlin + Jetpack Compose, one project under `apps/android/`.**
Two Gradle modules:

- `:core` — a **plain Kotlin JVM module** (`kotlin("jvm")`, no Android
  plugin). Wire models, REST client, Socket.IO client, and the transcript
  engine. Because it has no Android dependency it compiles and tests on
  the runner without the Android SDK, in seconds, and its tests are
  ordinary JUnit. This is the counterpart of `ArgusKit`.
- `:app` — the Compose application. Views, view-models, push, the
  WebView hosts. Counterpart of the `Argus` SwiftUI target.

**Hand-written, decode-tolerant DTOs. No codegen.** Same decision as iOS,
same reason: the server ships fields shared-types omits, REST and WS dress
the same row differently, and strict decoding breaks on both. kotlinx
serialization configured with `ignoreUnknownKeys` and `coerceInputValues`;
open string enums decode unrecognised values to an `UNKNOWN` member;
`cliType` stays a plain string; `JsonElement` stands in for the iOS
`JSONValue`. Never add strictness that rejects an unknown field.

**One shared fixture set for both native clients.** The iOS fixture
capture (`scripts/capture-ios-fixtures.sh`) is generalized to a
client-neutral script writing sanitized live-server responses to one
directory that *both* `ArgusKit`'s `FixtureDecodingTests` and `:core`'s
decoding tests consume. One capture keeps both clients honest, and a
shared-types change shows up as a diff in one place.

**Every dependency pinned exactly.** A Gradle version catalog with fixed
versions, the wrapper with a `distributionSha256Sum`, and
`gradle/actions/wrapper-validation` in CI. The iOS build broke once with
no iOS commit because XcodeGen re-resolved floating `from:` ranges on
every run; the Android build gets the reproducibility the Swift one still
lacks.

**Ports, not a shared core.** The transcript engine is ported TypeScript →
Kotlin, the same way it was ported to Swift. The pure-logic surface is
small enough that a third port is cheaper than the alternative:

| ArgusKit part | Lines |
| --- | --- |
| Models (DTO mirrors) | 964 |
| API (REST client) | 676 |
| Realtime (Socket.IO) | 300 |
| Engine (transcript, deltas, usage, math, context window, search) | 2,250 |
| Tests | 2,486 |
| SwiftUI app | 9,198 |

**Rejected alternatives, and why.**

- *Kotlin Multiplatform shared core.* `ArgusKit` is finished,
  device-verified, and in Swift 6 language mode. Replacing it with a
  Kotlin/Native framework rewrites working code, adds a second toolchain
  to the iOS build, and makes the "CI is the compiler" problem worse.
  Revisit only if a third native platform appears.
- *React Native / Flutter.* iOS is fully native at Compose-equivalent
  depth; a third UI stack fragments maintenance without saving the
  engine port.
- *Trusted Web Activity wrapping the web app.* The cheapest way to tick
  an Android box and a fine stopgap, but no background push and not what
  "native client" means.

## 3. The contract the client speaks

Everything below is already true of the web and iOS clients; it is listed
so the Kotlin port starts from the actual wire, not from shared-types'
idealized shapes.

**REST** — the surface `ArgusClient.swift` implements today, which is the
port list: login / me; sessions (list, get with `tailCommands`, chunks
`afterSeq`, history `before`/`after`, create, rename, archive/unarchive,
seen, fork, model); commands (send, cancel); machines (list, delete,
sidecar version, sidecar update, model catalog); projects (list, dir
listing, file read, git log, terminals); `/me` (usage, activity, quota,
extensions, project notes); devices; **search** (`GET /search/sessions?q=`).
Send the JWT as `Authorization: Bearer`. Responses are gzipped; the HTTP
client must accept that transparently.

**WebSocket** — Socket.IO 4.x on namespace `/stream`, JWT in the handshake
`auth.token`, `transports: ['websocket']`, reconnection on. Client emits
`subscribe:session` / `unsubscribe:session`, `subscribe:project` /
`unsubscribe:project` (refcounted — see below), `subscribe:terminal` /
`unsubscribe:terminal`, `terminal:input` / `terminal:resize` /
`terminal:close`. Server events are the seventeen in
`packages/shared-types/src/ws.ts`; the iOS `StreamClient` enum is the
exact list to mirror.

**Rules that are easy to get wrong, all of them already learned once:**

1. *Two dressings of one chunk.* REST-served chunks drop `sessionId` /
   `isFinal` and serialize `ts` as an ISO string; the WS `chunk` event
   carries the full wire shape with numeric millis. One decoder absorbs
   both.
2. *`command:updated` arrives without `attachments`.* Merge into the
   existing command row; never replace it, or the turn's thumbnails vanish.
3. *`seq` restarts at 1 per command.* The reconnect backfill
   (`getSessionChunks(afterSeq:)`) only catches up the turn in flight; the
   robust path on app-foreground is a full `getSession` snapshot, then
   rejoin rooms.
4. *Project rooms are refcounted on the client* (web `lib/ws.ts`, iOS
   `StreamClient.projectRooms`). Socket.IO `leave` is not, so the first
   unmounting holder would otherwise starve the rest of `fs:changed`.
   Replay the room map on every reconnect — rooms are per connection.
5. *Fork holds the response.* `POST /sessions/:id/fork` blocks until the
   sidecar's clone settles, bounded by `FORK_CLONE_TIMEOUT_MS` (15 s).
   **OkHttp's default read timeout is 10 s** — the fork call needs its own
   timeout well above 15 s or every Codex fork will time out client-side
   while succeeding server-side. `dispatch` returns **409** while the clone
   is pending; the queue drainer must treat that as "retry after a
   cooldown", not a hard failure.
6. *Search snippets use `[[hl]]` / `[[/hl]]` sentinels*, never HTML. Split
   on them and build text spans; transcript text must never reach an HTML
   sink.
7. *`session:status` is the notification trigger*, not `command:updated`
   — the latter only reaches clients subscribed to the session room.
   Fire on the `active → idle|failed` transition with `unread` set, and
   reject writes whose `updatedAt` is older than what is stored.
8. *`deltaSplit` is ported four times* once this lands — web
   `lib/deltaSplit.ts`, iOS `DeltaSplit.swift`, the server's
   `answerPreview` in `push.service.ts`, and Kotlin. Change one, change all.

## 4. Lockstep table

The Kotlin files below mirror a TypeScript original and must move with it.
This is the iOS table extended with the September additions (palette
ranking, search snippets, hotkeys).

| Kotlin (`apps/android/core` unless noted) | Original |
| --- | --- |
| `engine/DeltaSplit.kt` | `apps/web/src/lib/deltaSplit.ts` |
| `engine/FileReferences.kt` | `apps/web/src/components/FileChips.tsx` helpers + the `img` source split in `StreamViewer.tsx` |
| `engine/MathDelimiters.kt` / `MathSegments.kt` / `InlineMath.kt` | `apps/web/src/lib/markdown.ts` delimiter rules (semantic port; document deviations in-file as iOS does) |
| `engine/UsageMath.kt` | `packages/shared-types/src/usage.ts` |
| `engine/ContextWindow.kt` | `packages/shared-types/src/contextWindow.ts` — **hash-pinned** by a lockstep test, and `android.yml` triggers on that path |
| `engine/SessionMatch.kt` | `apps/web/src/lib/sessionMatch.ts` (⌘P ranking — weights, bonuses, tie-breaks) |
| `engine/SearchSnippet.kt` | `renderSnippet` in `CommandPalette.tsx` + `SEARCH_HL_START`/`SEARCH_HL_STOP` |
| `engine/ToolDisplay.kt`, `engine/DedicatedPanels.kt` | the iOS files of the same name (which mirror `ActivityPill.tsx` / `TodoWindow.tsx` rules) |
| `realtime/StreamClient.kt` events | `packages/shared-types/src/ws.ts` |
| `model/*` | `packages/shared-types/src/{api,protocol}.ts` |
| `app/…/Hotkeys.kt` | `apps/web/src/lib/hotkeys.ts` (chords, labels, scopes; ⌘ becomes Ctrl) |
| `app/src/main/assets/mermaid.min.js` | the `mermaid` version `apps/web` resolves in `pnpm-lock.yaml` — **version-pinned** by a lockstep test; the sync script grows an Android destination |
| `app/src/main/assets/xterm/` | the `@xterm/xterm` version `apps/web` resolves — same lockstep shape |

`ContextWindowLockstepTests` and `MermaidLockstepTests` exist on iOS
because both drifted silently once. Port the tests in Phase 1, before the
code that depends on them.

## 5. Stack

**Serialization** — kotlinx serialization (see §2). `ResultChunk.ts` gets
a custom serializer accepting both numeric millis and ISO strings. Enum
fallbacks are declared with a default member so `coerceInputValues` maps
unknown wire values onto it.

**Networking** — OkHttp for REST and multipart uploads, with per-call
timeouts (fork ≥ 20 s, everything else default). `io.socket:socket.io-client`
2.x for Socket.IO: it speaks the v4 protocol the server runs (`socket.io`
4.8), supports the `auth` handshake payload and websocket-only transport.
Terminal bytes are base64 in JSON already, nothing to change.

**Transcript rendering** — mirror the iOS split rather than take one
monolithic renderer:

- Prose: a Compose-native markdown renderer with block-level overrides
  (fenced code, images, paragraphs) so the transcript stays a
  `LazyColumn` of composables and streams without View interop.
- Math: `$$` blocks and inline `$…$` spans render through
  JLatexMath-android hosted in `AndroidView`, at the points
  `MathSegments` / `InlineMath` split the markdown — the same seams iOS
  uses for SwiftMath. JLatexMath's LaTeX subset is far larger than
  SwiftMath's, so most `MathCompat` rewrites (and the whole horizontal-
  brace `Shape` workaround) should be unnecessary; port `MathCompat` only
  for constructs a Phase 2 corpus check shows still fail.
- Fallback if the Phase 2 spike shows the Compose renderer can't take the
  paragraph-level override inline math needs: Markwon in `AndroidView`
  (GFM tables, task lists, LaTeX and highlighting in one library, but
  dormant since 2021 and View-based).
- Code highlighting: a Compose-compatible highlighter keyed by the same
  language-alias map `FilePreview.swift` and `lib/shiki.ts` carry.

**Mermaid and sandboxed HTML** — one `WebView` host that loads a bundled
`mermaid.html` once and pushes source + theme through a JS bridge, so a
theme flip redraws without re-parsing the 3 MB runtime. Vendored bundle,
never a CDN (air-gapped servers, offline phones). `securityLevel:
'strict'`, all navigations but the initial asset load cancelled, parse
failure falls back to the plain code block with no error state. The
`html` fence host uses a fresh opaque-origin document with JavaScript
enabled but no file or content access — the Android equivalent of the
web's `allow-scripts` without `allow-same-origin`.

**Terminal** — a `WebView` hosting vendored xterm.js, which is exactly
what the web's `TerminalPane` does; input goes out through a JS bridge as
base64 `terminal:input`, output comes in the same way. Chosen over Termux's
`terminal-view` because that is GPLv3 and this repo has no LICENSE file
yet; keep the dependency posture clean. Same explicit lifecycle as iOS:
idle CTA, open shell with close, settled shell with Dismiss / New shell.
Hardware Ctrl+B / Ctrl+K / Ctrl+D must reach the shell while the terminal
has focus, as on the web.

**Push** — Firebase Cloud Messaging, HTTP v1, **optional exactly as APNs
is** (all `FCM_*` env unset = silent no-op). Two design points specific to
a self-hosted product:

- *One APK for any server.* Firebase is normally configured at build time
  from `google-services.json`, which would bind the binary to one
  operator's Firebase project. Instead the server exposes its **public**
  client identifiers (project id, application id, API key, sender id) on
  an authenticated endpoint and the app initialises Firebase at runtime
  from them. The secret (service-account JSON) lives only on the server.
- *Read-sync is a data message.* Wherever `unread` flips false the server
  already sends APNs a silent push; the FCM branch sends a data-only
  message `{type: clear, sessionId}` and the app cancels its own
  notification — FCM has no server-side revoke either.

Flag in the README: FCM needs the server to reach Google and the device
to have Play services. Air-gapped installs and de-Googled phones run
without push, like a server with no `APNS_*` today. UnifiedPush is the
follow-up if that gap matters.

**Live Updates** — the Android 16 counterpart of Live Activities: a
promoted ongoing notification with `ProgressStyle` carrying session title,
tool count, last tool and elapsed time, resolving to ✓/✗. Updated locally
from the socket while foregrounded; via FCM data messages once
backgrounded, throttled server-side with the same leading-edge +
trailing-flush shape as the APNs path. Pre-16 devices get a plain ongoing
notification with the same content and no promotion.

**Credentials** — the JWT is held in memory for requests and persisted in
app-private storage (DataStore) for relaunch, mirroring the iOS
`TokenStore` rule that the Keychain is never the per-request provider.
`androidx.security-crypto` is deprecated; don't reach for it.

**Process lifecycle** — tie the socket to `ProcessLifecycleOwner`:
disconnect after a short grace in the background, reconnect in the
foreground through the snapshot path (§3 rule 3). Doze and background
restrictions make a background socket unreliable anyway; push covers that
window.

**Hardware keyboards** — Android tablets and ChromeOS have them. Port the
hotkey registry with ⌘ → Ctrl (the web's non-Mac mapping), rendered into
the same shortcuts sheet, dispatched with Compose key-event handlers and
the same two scopes (global vs session). Type-to-focus stays unported
for the reason recorded in the iOS notes (it can't be done without
inserting the character, which breaks IME composition).

## 6. Server-side work (Phase 5)

The only server changes in the whole plan, all in `apps/server/src/modules/push/`:

1. **Token validation is per platform.** `RegisterDeviceDto` requires a
   hex token (`/^[0-9a-fA-F]+$/`) because APNs tokens are hex. FCM
   registration tokens are not (base64url characters plus a colon), so
   registration must validate by `platform` — `ios` keeps hex, `android`
   accepts the FCM alphabet with a generous length cap. The
   `DeviceToken.platform` column already exists, default `ios`.
2. **Split `PushService` into trigger + transports.** The trigger logic
   (which sessions, `answerPreview`, `outstandingBanners`, the read-sync
   clear) is platform-agnostic; APNs (HTTP/2, provider JWT) and FCM
   (HTTP v1, OAuth2 access token from the service account, plain fetch)
   become two transports selected by each device row's `platform`.
   `UNREGISTERED` / `INVALID_ARGUMENT` responses prune the row, as
   `BadDeviceToken` does today.
3. **`GET /me/push/config`** returns the public FCM client identifiers
   (or 404 when FCM is unconfigured) so the app can initialise Firebase at
   runtime.
4. **Env** — `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_BASE64` or
   `FCM_SERVICE_ACCOUNT_PATH`, plus the four public client fields.
   Document in `.env.example`, `INSTALLATION.md`, and the Helm values.
5. **Live Updates pushes** — data messages from the same throttle the
   `liveactivity` APNs type uses; can land after the rest of Phase 5.

## 7. CI: `.github/workflows/android.yml`

Modelled on `ios.yml`, cheaper because it runs on Linux:

- **Triggers** — push to `main`, `dev`, `feat/android-*`; pull requests;
  `workflow_dispatch` for long-lived branches. Path-filtered to
  `apps/android/**`, the workflow file, `packages/shared-types/src/contextWindow.ts`
  (so an unported table change fails Android CI in the same push, as it
  fails iOS CI), and `apps/web/src/lib/hotkeys.ts`.
- **Toolchain** — `actions/setup-java` (Temurin, JDK 17: what AGP 8
  requires to run Gradle); `gradle/actions/setup-gradle` for caching;
  `gradle/actions/wrapper-validation` before anything runs. The hosted
  Ubuntu image ships the Android SDK with `ANDROID_HOME` set; missing
  platform components download on first build. No emulator.
- **Jobs** —
  `core`: `./gradlew :core:test` (fixture decoding, engine ports,
  lockstep pins). Fails fast and needs no SDK.
  `app`: `./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest`.
  Debug signing only; release signing is out of scope until there is
  somewhere to publish.
- **Reports** — upload JUnit XML and the lint report as artifacts on
  failure, since the runner log is the only debugger the dev box has.

**Bootstrapping without a local Gradle.** The wrapper is normally
generated by running Gradle. Instead, commit `gradlew`,
`gradle/wrapper/gradle-wrapper.properties` (with `distributionSha256Sum`)
and `gradle-wrapper.jar` taken from the Gradle repository at the matching
release tag; wrapper-validation in CI checks the jar's checksum against
Gradle's published list on the very first run. If that first run is red for
build-script reasons, iterate on the branch — that is the expected loop.

## 8. Phases

Each phase ends when `android.yml` is green on the branch. Order follows
the iOS roadmap, which is already dependency-ordered.

**Phase 0 — CI bootstrap.** Gradle project with an empty `:core` (one
JUnit test) and an empty `:app` (one Compose activity), version catalog,
wrapper, `android.yml`, `.gitignore` entries (`.gradle/`, `local.properties`,
`.kotlin/`, `*.keystore`), README and AGENTS.md sections. Exit: the
workflow has run green via `workflow_dispatch`. **This is the phase the
maintainer asked to see first**, and it is the smallest one.
*Done 2026-09-21.* Landed as Gradle 9.7.1 / AGP 9.4.1 / Kotlin 2.4.10 /
Compose BOM 2026.09.00 (see `apps/android/README.md` for the pin table and
the AGP 9 built-in-Kotlin rule). The first push went red on a wrong test
expectation, not on the toolchain — the library's `encodeDefaults=false`
omits default-valued fields — and the second run was green: `core` in
about 1 min 20 s, `app` (assemble + lint + unit tests + APK artifact) in
about 2 min 45 s on a cold cache. `setup-gradle` validated the committed
wrapper jar as part of that run.

**Phase 1 — core.** DTO mirrors; `ArgusClient`; `StreamClient` as a
`Flow` of a sealed event type; the engine ports from §4 including
`SessionMatch` and `SearchSnippet`; the two lockstep tests; the
generalized fixture script and the shared fixture directory, with
`FixtureDecodingTests` in both clients pointed at it. Exit: `:core:test`
green decoding every fixture, including `search-sessions.json`.
*Done 2026-09-21.* 4.6k lines of Kotlin under `core/src/main`, 3.7k of
tests — 201 JUnit tests, every Swift test ported one-to-one, all green on
the first CI run after a blind port (verified from the uploaded JUnit
XML, which `android.yml` now publishes on every run). The fixtures moved
to `packages/shared-types/fixtures/`, the capture script became
`scripts/capture-client-fixtures.sh`, ArgusKit's tests read the shared
directory from `#filePath`, and `ios.yml` now also runs on
`feat/android-*` branches so a cross-client change is proved on both
runners. Decisions recorded in `apps/android/README.md` and AGENTS.md:
explicit per-enum tolerant serializers rather than `coerceInputValues`
alone; a dedicated 30 s read-timeout client for fork; `org.json`
excluded from socket.io-client-java for the platform copy; the Kotlin
ports follow the TypeScript (UTF-16) string semantics where the Swift
port had to deviate for grapheme clusters; `MathCompat` not ported. The
mermaid version pin (§4) is deferred to the phase that vendors the
runtime.

**Phase 2 — app shell.** Server/login flow (scheme inference for LAN
hosts, cleartext allowed for them); project-grouped session list with the
iOS `projectGroups` sort; streaming transcript (activity timeline, tool
pills, diffs, answer markdown with math, mermaid, sandboxed HTML, inline
workdir images); composer with the queue; session view-model cache with
the stale-while-revalidate `start()` rule. Exit: a turn round-trips on a
device or emulator someone else runs, recorded in the PR.

**Phase 3 — parity batch.** Inspector (Files tree with depth-3 prefetch,
Commits, Diff, Note, Terminal placeholder), model picker keyed (machine,
cliType), attachments, fork/rename/archive with the fork-hold timeout,
usage badge and context ring, **command palette** (Ctrl+P ranking, Ctrl+K
content search opening at the tail, as iOS does) and the **hotkey
registry** with its shortcuts sheet, clone-failed toasts, compaction
divider.

**Phase 4 — fleet and account.** Machines panel with sidecar update,
user panel (activity grid and curve, usage windows, quota, extensions),
project and session creation sheets.

**Phase 5 — push.** Server §6, then the client: runtime Firebase init,
registration on login and token refresh, the notifications toggle, tap
deep-link, on-screen suppression, read-sync clear, and the `refreshAll`
sweep for banners a best-effort data message missed.

**Phase 6 — terminal and Live Updates.** xterm.js host with the explicit
lifecycle; the promoted ongoing notification with local and pushed updates.

## 9. Working on it without a local toolchain

- Author Kotlin and Gradle files on the dev box; push the branch; run
  `android.yml` (push trigger or `gh workflow run android.yml --ref
  feat/android-native-client`); read the run with `gh run watch` / `gh run
  view --log-failed`.
- Never run `gradle`, `java`, or `kotlinc` locally, and never claim a
  change compiles until the workflow says so. PR descriptions state the
  CI run that verified them.
- When shared-types changes shape: re-run the fixture capture against a
  live server, commit the fixture diff, and let *both* `ios.yml` and
  `android.yml` prove the mirrors still decode.
- Device verification (Phase 2 onward) happens off the dev box; record the
  device, OS version, and what was exercised in the PR.

## 10. Open questions

- **Minimum SDK.** Compose and OkHttp are comfortable at API 26+; Live
  Updates need 36. Proposal: `minSdk 26`, `targetSdk`/`compileSdk` at the
  current stable, with the Live Updates path gated at runtime.
- **Distribution.** Debug APK from CI artifacts is enough for the phases
  above. Play Store or F-Droid, and therefore release signing and a
  LICENSE file for the repo, are separate decisions.
- **UnifiedPush** for devices without Play services — only if someone
  needs it.
- **Deep-link to the matched turn from Ctrl+K** — deferred on iOS because
  the transcript engine has no floating-window model; port it to both
  native clients together, or to neither.
