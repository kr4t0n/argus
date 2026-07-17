# Argus — native iOS / iPadOS client

A native **SwiftUI** client for the Argus agent dashboard. It is a *thin
client*: it speaks the same NestJS REST API + Socket.IO `/stream`
namespace as the web app and never touches the Go sidecar.

> Status: **Phase 4 + terminal.** Turn-completion alerts via APNs
> (enable "Task completion alerts" in the account panel; needs the
> server's `APNS_*` env — see the repo-root `.env.example`; Simulator
> remote push needs an Apple silicon Mac), and a full **interactive
> terminal** (SwiftTerm) in the session inspector for agents created
> with the PTY opt-in — same shell-access trust model as the web's
> Terminal pane. Phases 1–3 cover login, streaming transcript, iPad
> three-column layout, inspector (Commits / Files / Terminal / Note /
> Progress / Diff), queue, attachments, fleet + account panels, and
> creation flows.
>
> This is a **fresh implementation** — the earlier
> `feat/ios-native-client` branch (OpenAPI-codegen based) is deprecated;
> do not build on it.

## Approach: hand-written mirror + captured fixtures (no codegen)

Swift models are **hand-written, decode-tolerant mirrors** of
`packages/shared-types` (`api.ts` / `protocol.ts` / `ws.ts`):

- unknown JSON fields are ignored (Codable default — never add strictness
  that rejects them; the server ships fields shared-types omits),
- string enums decode unrecognized values to `.unknown` instead of
  failing the payload,
- `ResultChunk` absorbs both wire dressings of the same row (WS relays
  carry `sessionId`/`agentId`/`isFinal` and numeric `ts`; REST rows drop
  those columns and serialize `ts` as an ISO string).

Contract confidence comes from **fixtures captured from a real server**:

```bash
# repo root; needs a running server + jq. Credentials fall back to
# ADMIN_EMAIL/ADMIN_PASSWORD in .env.
scripts/capture-ios-fixtures.sh [--session <id>]
```

That writes sanitized responses (tokens redacted, long strings truncated)
into `ArgusKit/Tests/ArgusKitTests/Fixtures/`, and
`FixtureDecodingTests` decodes every one of them in CI. **When
shared-types changes shape: re-run the capture script, run the tests,
commit the fixture diff.** Review the diff before committing — fixtures
can embed real prompt text and the repo is public.

## Layout

```
apps/ios/
├── ArgusKit/                     SwiftPM package — everything except UI
│   ├── Package.swift             iOS 17+ / macOS 14+, Swift 6 language mode
│   └── Sources/ArgusKit/
│       ├── Models/               DTO mirrors (JSONValue, enums, sessions, fleet, …)
│       ├── API/                  ArgusClient (URLSession), ServerConfig, TokenStore
│       ├── Realtime/             StreamClient — Socket.IO /stream → AsyncStream
│       └── Engine/               TranscriptState reducer, DeltaSplit, UsageParser,
│                                 ContextWindows (all pure + unit-tested)
└── Argus/                        SwiftUI app target (XcodeGen; .xcodeproj generated)
    ├── project.yml               targets, ATS exception, MarkdownUI + ArgusKit deps
    └── Sources/
        ├── ArgusApp.swift        @main, root phase switch, scenePhase handling
        ├── AppModel.swift        auth, socket ownership, event routing, TokenBox
        ├── Stores.swift          FleetStore + SessionListStore (+ projectGroups)
        ├── SessionViewModel.swift per-session transcript state + actions
        └── Views/                Login, SessionList, Session (transcript+composer)
```

Ports that must stay in lockstep with their TS originals:

| Swift | TypeScript original |
| --- | --- |
| `Engine/DeltaSplit.swift` | `apps/web/src/lib/deltaSplit.ts` |
| `Engine/UsageMath.swift` | `packages/shared-types/src/usage.ts` |
| `Engine/ContextWindow.swift` | `packages/shared-types/src/contextWindow.ts` |
| `Realtime/StreamClient.swift` events | `packages/shared-types/src/ws.ts` |
| `Models/*` | `packages/shared-types/src/{api,protocol}.ts` |

## Build & test

Nothing here builds on Linux — Swift is authored on the dev box and
verified on macOS. **CI (`.github/workflows/ios.yml`, macOS runner) is
the primary verifier**: it runs `swift build` + `swift test` on every
push touching `apps/ios/`.

Locally on a Mac:

```bash
cd apps/ios/ArgusKit
swift build          # works with Command Line Tools alone
swift test           # needs full Xcode (Testing.framework ships in its SDK)
```

## Build & run the app (Xcode)

The Xcode project is **generated** from `Argus/project.yml` via
[XcodeGen](https://github.com/yonaskolb/XcodeGen) — reproducible, and the
`.xcodeproj` / `Info.plist` are never committed:

```bash
brew install xcodegen                 # once
cd apps/ios/Argus
xcodegen generate                     # → Argus.xcodeproj
open Argus.xcodeproj
```

Pick an **iPhone or iPad Simulator** destination and ⌘R. On the login
screen enter your server (e.g. `localhost:4000` — the Simulator shares
the Mac's network; scheme defaults to http for LAN/localhost hosts, ATS
allows cleartext) plus the seeded admin credentials. Re-run `xcodegen
generate` only after adding/renaming source files or editing
`project.yml`.

> **Signing:** none needed for the Simulator (`CODE_SIGNING_ALLOWED=NO`
> in project.yml). For a physical device, delete the two signing lines
> there and pick a team in Xcode → Signing & Capabilities (a free Apple
> ID works).
>
> **No Apple Developer account?** Everything except push works — the
> server runs with no `APNS_*` env set (push is a silent no-op) and the
> app is fully functional; the notifications toggle just never produces
> an alert. One catch on **physical devices** with free-Apple-ID
> signing: the generated `aps-environment` entitlement can fail
> provisioning ("profile doesn't support Push Notifications") — delete
> the `entitlements:` block from `project.yml` and re-run
> `xcodegen generate`. The Simulator is unaffected either way.

## Using ArgusKit

```swift
import ArgusKit

// Parse whatever the user typed; scheme is inferred (LAN hosts → http).
let config = ServerConfig.parse("192.168.1.20:4000")!

// Hold the JWT in MEMORY; TokenStore (Keychain) is only for persistence
// across launches. Never wire TokenStore.read as the per-request provider.
var token: String? = TokenStore.read(server: config.displayName)
let client = ArgusClient(baseURL: config.baseURL, tokenProvider: { token })

// Login → persist.
let login = try await client.login(email: email, password: password)
token = login.token
TokenStore.save(login.token, server: config.displayName)

// Load a session and build display turns.
let detail = try await client.getSession(id: sessionId, tailCommands: 20)
var transcript = TranscriptState(sessionId: sessionId)
transcript.applySnapshot(
    commands: detail.commands, chunks: detail.chunks, hasMore: detail.hasMore
)

// Live updates.
let stream = await StreamClient()
await stream.connect(baseURL: config.baseURL, token: login.token)
await stream.joinSession(sessionId)
for await event in await stream.events {
    switch event {
    case .chunk(let chunk):
        transcript.append(chunk: chunk)
    case .connected:
        // Socket.IO has no replay buffer — catch up over REST.
        let missed = try await client.getSessionChunks(
            id: sessionId, afterSeq: transcript.maxSeq
        )
        transcript.mergeBackfill(commands: missed.commands, chunks: missed.chunks)
    default:
        break
    }
    let turns = transcript.turns(agentType: agent.type)
    // render…
}
```

Reconnect/lifecycle rules (mirror the web, plus mobile realities):

- `chunk` / `command:*` arrive only while subscribed to `session:{id}`;
  `session:status` arrives always (drives list dots + notifications).
- On socket reconnect: `getSessionChunks(afterSeq: transcript.maxSeq)`.
- On app foreground (iOS suspends sockets): treat it as a cold start —
  full `getSession` snapshot via `applySnapshot`, then rejoin rooms.
  `seq` resets per command server-side, so the afterSeq heuristic only
  catches up the currently-streaming turn; the snapshot path is the
  robust one.

## Roadmap

- **Phase 0 (done):** ArgusKit foundations + fixtures + CI.
- **Phase 1 (done, runtime-verified):** SwiftUI app (XcodeGen target):
  server/login flow, project-grouped session list, streaming
  transcript, composer.
- **Phase 2 (done, runtime-verified):** iPad `NavigationSplitView` +
  inspector (files, commits, diffs), usage badge + context ring, model
  picker, prompt queue + drainer, attachments, fork/rename/archive,
  keyboard shortcuts.
- **Phase 3 (done):** machines panel, user panel
  (activity/usage/quota/extensions), project/agent/session creation.
- **Phase 4 (done):** APNs push — server: `DeviceToken` table,
  `POST/DELETE /me/devices`, HTTP/2 APNs sender in the result-ingestor;
  iOS: registration + settings toggle + tap deep-link + on-screen
  suppression.
- **Post-Phase-4 (done):** inspector parity (Note + Progress tabs, web
  tab order/gating) and the interactive terminal (SwiftTerm over the
  `terminal:*` socket events, lazy-opened per inspector).
- **Live Activity (done):** a lock-screen / Dynamic Island card for a
  running turn — session title, live tool count + last tool, on-device
  elapsed timer, resolving to ✓/✗. Starts when a turn begins in the
  viewed session or is submitted from the device; updates locally while
  the app is foregrounded, and via APNs `liveactivity` pushes (throttled
  server-side in the result-ingestor) once backgrounded. Both throttles
  are leading-edge + trailing-flush: the first update in a window goes
  out immediately, and one deferred update at window expiry carries
  whatever a burst left behind, so the card never sits stale mid-turn. The UI lives in
  the `ArgusWidgets` extension; `Shared/TurnActivityAttributes.swift` is
  the content-state wire contract with the server — field names must
  match `push.service.ts`. Without `APNS_*` configured the card still
  works while the app is open (plus a foreground reconcile fallback);
  locked-screen updates need the push credentials.
- **Read-sync (done):** reading a session on *any* client withdraws its
  completion banner from the phone — the banner mirrors the session's
  `unread` flag. Server: a silent background clear push at every
  `unread → false` transition (session opened, fresh turn superseding
  the result, cancel), gated on an in-memory outstanding-banner set so
  the hot ingest path pays a Set lookup. iOS: `UIBackgroundModes:
  remote-notification` (re-run `xcodegen generate` — Info.plist is
  generated), a background handler that removes the delivered
  notification by `sessionId`, a local removal when the session is
  read on-device, and a `refreshAll` sweep that catches whatever the
  best-effort background push misses (Apple throttles them and never
  delivers to force-quit apps).
- **Inspector Files/Commits polish (done):** both panels rebuilt to the
  web ContextPane's density — no `List` (its default row heights and
  separators read loose), fixed 24pt mono rows in a `LazyVStack`.
  Files is now a lazy-expanding tree (web FileTree port: depth-3
  prefetch per cold expansion, cache kept across collapse, gitignored
  eye toggle, branch badge, per-level inline error/"(empty)" rows)
  instead of the old drill-down-per-directory browser; Commits is
  one-line `sha · subject · age` rows under a branch-badge + refresh
  header (amber when detached). Size/mtime and author/date/copy-SHA
  moved to long-press menus — the touch equivalent of the web's
  tooltips.
- **Clone-failed toasts (done):** `session:clone-failed` was silently
  ignored; forking a session whose CLI-state clone fails now floats an
  amber toast (web SessionCloneFailedToasts parity: one per session,
  newest first, 8s auto-dismiss + manual dismiss, session title looked
  up at event time with id-prefix fallback) over the split view.
- **Explicit terminal lifecycle (this):** the Terminal tab no longer
  auto-attaches a PTY on visit — web TerminalPane parity: idle shows an
  "Open shell on \<machine\>" CTA, an open shell gets a close (power)
  button, a settled shell offers Dismiss / New shell. One deliberate
  divergence: the shell is still reaped when the inspector closes (the
  web leaves it running; on a phone an orphaned PTY has no re-attach
  surface).
