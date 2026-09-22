# Argus — native Android client

A native **Kotlin + Jetpack Compose** client for the Argus agent dashboard.
Like the iOS client it is a *thin client*: it speaks the same NestJS REST
API + Socket.IO `/stream` namespace as the web app and never touches the
Go sidecar.

> Status: **Phase 5 — push.** `:core` holds the full non-UI
> layer (decode-tolerant DTO mirrors of shared-types, the OkHttp REST
> client, the socket.io realtime client as a `Flow` of typed events, and
> the transcript engine ported from ArgusKit — all unit-tested against
> the fixtures shared with the iOS client). `:app` is a usable client on
> phones and tablets: server + login, the project-grouped session list
> (a side column from 840dp), a streaming transcript (activity timeline,
> tool pills, diffs, markdown with math, mermaid, sandboxed HTML and
> inline workspace images), a composer with attachments and the prompt
> queue, the inspector (Commits / Files / Note / Diff, terminal
> placeholder), file preview, model picker, usage badge + context ring,
> fork, the Ctrl+P / Ctrl+K palette (also behind the list's search
> button) and the Ctrl+/ shortcuts sheet, the machine panel (host,
> adapters, projects, sidecar update, remove), the account panel
> (activity grid/curve, usage windows, plan quota, extensions, the
> push toggle), the project / session creation sheets, and
> turn-finished push notifications over FCM (deep link, on-screen
> suppression, read-sync clear). The terminal and Live Updates are the
> remaining phase. The full design, wire contract and phase plan are in
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
        ├── MainActivity.kt     theme + root composable; the hardware-keyboard dispatch point
        ├── AppModel.kt         auth, socket, event routing, VM cache, queue drainer,
        │                       palette mode, fs/git change batches, hotkey dispatch
        ├── Hotkeys.kt          the binding registry (mirror of hotkeys.ts / Hotkeys.swift)
        ├── store/              FleetStore, SessionListStore, QueueStore (StateFlow-backed)
        ├── session/            SessionViewModel — TranscriptState + room + start()/revalidate
        └── ui/                 ArgusApp (phase switch, stack ↔ split layout), login/,
                                sessions/ (list), session/ (transcript, composer, attachments,
                                activity timeline, panels, model picker, usage badge),
                                inspector/ (Commits / Files / Note / Diff), files/ (file +
                                attachment previews), palette/ (Ctrl+P / Ctrl+K / Ctrl+/),
                                machine/ (machine panel), user/ (account panel), create/
                                (project + session sheets, the shared model form),
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
submit joins the tail of a draining backlog. The composer itself is the
iOS pill: one surface1 capsule holding the pending-attachment chips, the
paperclip, a `BasicTextField` that grows to six lines, and the 32dp
actions (up-arrow send, or add-to-queue plus the square stop while a turn
runs) — a Material outlined field with the buttons outside it read as a
different app. The field's one-line height is sized to the actions so
the row shares one centre line and extra lines grow upward.

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

Deliberately not ported: sticky turn headers (the iOS `pinnedViews`
band — plain items in the `LazyColumn` instead) and persisted collapse /
archived-reveal state for the session list. The CLI brand marks are the
iOS asset catalog's PNGs copied into `res/drawable-*dpi/agent_*.png`
(24dp at 1x/2x/3x; Android's density folders cannot point at an
`.imageset`), theme-resolved like the web's `AgentTypeIcon`; the folder,
eye, monitor and archive-box glyphs the sidebar needs are
hand-transcribed Material paths in `ui/components/Glyphs.kt`, because
`material-icons-core` lacks them and the extended set is a 16 MB
dependency for five icons.

The list itself renders as the iOS sidebar's inset grouped "islands":
one rounded card for every project (headers, sessions and the
archived-projects row are flat rows inside it, so a collapsed project is
one compact line), a "Machines" title over the machines card (monitor
glyph, emerald while online, trailing status dot), and the account card.
The list stays a `LazyColumn`: every row is its own item and rounds only
the corners it owns, so the projects section is first flattened into a
row list (collapse and archive-reveal applied) to know which row is
first and which is last. The card is one step above the page on both
themes — white on the light page, the surface1 grey on the dark one.

## Parity batch (Phase 3)

**Layout.** Compact widths keep the two-level stack (list, then one
session); from 840dp the session list becomes a 340dp column beside the
open session, hideable with Ctrl+B — the split the web and iPad show.
Inside a session the inspector sits beside the transcript when the
session area is at least 900dp wide and is a full-height bottom sheet
otherwise.

**Hardware keyboard.** `Hotkeys.kt` mirrors the web's `hotkeys.ts` and
the iOS `Hotkeys.swift` table — same ids, labels and scopes — but the
chords are **Ctrl-only**: Android keyboards carry Ctrl, and Meta is the
system's launcher key. Dispatch is one place, `MainActivity.onKeyDown`,
which sees only keys the view hierarchy declined: a focused text field
keeps its editing chords, and the composer handles Enter (send),
Shift+Enter (newline), Ctrl+Enter (send) and Escape (leave the field)
itself. The on-screen keyboard's Enter still inserts a newline — a key
event from the virtual device is let through. GLOBAL bindings (palette
modes, sidebar) are handled by `AppModel`; SESSION bindings (archive
toggle, stop turn) go to the handler the open session screen registers,
so they are inert on the list by construction, and are refused while
the palette is up (a modal can be showing a different session). There
is no terminal pane yet; when one lands, Ctrl+K / P / D / B must reach
the PTY while it has focus, as the web defers them.

**Palette.** One `ModalBottomSheet` keyed on `AppModel.paletteMode`
(session / content / help) — another mode's hotkey swaps the content
in place instead of stacking a second sheet, and the last non-null mode
is latched so the content does not flip while the sheet animates out.
Ctrl+P ranks client-side with the ported `SessionMatch`; Ctrl+K calls
the server's full-text search with a 200 ms debounce and cancels the
previous request, and opens the hit at the session's TAIL (the same
tail-only cut iOS made — see the AGENTS.md entry on the transcript
window invariant). Snippets render the `[[hl]]` sentinel runs as styled
text; they never reach an HTML sink.

**Inspector, previews, picker, badge.** All project-addressed through
`ProjectRef`, all joining the (refcounted) project socket room
themselves, all refetching from `AppModel.fsChanges` /
`AppModel.gitChanges` — sequence-numbered batches, because the wire
payloads carry no timestamp and a `StateFlow` of the raw payload would
swallow every repeat edit to one directory. The file preview's
auto-refresh window is NON-restarting, as on the web and iOS (a
restarting debounce starves under sustained editing). The model picker
is keyed (machine, cliType) and never validates against the catalog; the
usage badge is the context ring alone, with the breakdown one tap away.

**Fleet and account (Phase 4).** Machines and the account are routes
beside sessions (`Route.Machine`, `Route.User`), reached from the list's
machine rows and account row and rendered in the detail column on
tablets. Creation is project-first, as on the web: a project row's `+`
creates a session inside it, a machine's "New project…" (long-press on
its row, or the machine panel's menu) creates a working directory plus
its first session; both go through one `POST /sessions` that upserts the
Project row. The model editor is one composable shared by the session
picker and both sheets, so a catalog fix lands everywhere. The account
panel's "task completion alerts" toggle is rendered disabled until push
lands. The list's top bar gained a search action that opens the palette
in session mode — the on-screen entry point a phone needs, since the
chords are Ctrl-only.

**Push (Phase 5).** Firebase Cloud Messaging, with Firebase initialised
at RUNTIME: there is no `google-services.json` and no google-services
plugin. Turning the account panel's toggle on requests the Android 13+
notification permission from the gesture, then `AppModel.setPushEnabled`
fetches the server's public Firebase identifiers (`GET /me/push/config`
— 404 means "this server has no Android push", shown in the footer),
`AndroidPushBridge` builds `FirebaseOptions` from them, mints the
registration token and registers it as `platform: "android"`. The
config is cached so a process that an incoming message starts can
re-initialise Firebase without a login; auto-init is off in the
manifest, so no token exists before opt-in. Every message the server
sends is a data message (see the server's `push/` module for why), so
`ArgusMessagingService` renders the banner itself through
`TurnNotifications`: posted under the session id as its tag (a newer
completion replaces the older banner), suppressed while that session is
on screen in the foreground, cancelled on the server's `clear` message,
on the socket's `session:status` with `unread: false`, and by the
`refreshAll` sweep against the fresh unread set. A tap deep-links via an
intent extra with a per-session request code; `MainActivity` is
`singleTop`. The enabled flag survives logout and the token is
unregistered, so the next login re-registers — iOS parity throughout.

**Attachments.** The system photo and document pickers feed
`ArgusClient.uploadAttachment`; uploads happen ahead of send, the chips
show a local thumbnail from the bytes in hand, and the ids ride the
queued prompt. A sent turn's thumbnails and the file preview's images
are fetched with `HttpURLConnection` — there is no image-loading
dependency, on purpose.

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
- **Push tokens are validated per platform** by `POST /me/devices`:
  `platform: "android"` accepts the FCM alphabet, `ios` (the default)
  APNs hex — always send the platform. `GET /me/push/config` is
  Android-only and 404s on a server without `FCM_*`; `PushConfigDTO`
  has no Swift mirror by design.

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
| androidx.core (core-ktx) | 1.19.0 | `NotificationCompat` for the turn banners — used directly, so pinned directly rather than inherited |
| firebase-messaging | 25.1.3 | FCM registration tokens + the messaging service; initialised at runtime, no google-services plugin |
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
composer with the queue ✅ (device-verified) → **3** inspector, file
preview, model picker, usage badge, attachments, fork, palette and
hotkeys ✅ → **4** fleet and account panels, creation sheets ✅ →
**5** push (FCM, with the server-side transport split) ✅ (this) →
**6** terminal and Live Updates.
