# Argus — native iOS / iPadOS client

A native **SwiftUI** client for the Argus agent dashboard. It is a *thin
client*: it speaks the same NestJS REST API + Socket.IO `/stream`
namespace as the web app and never touches the Go sidecar.

> Status: **Phase 0 — foundations.** This directory contains `ArgusKit`
> (models, REST client, realtime layer, transcript engine) with a full
> test suite. The SwiftUI app target lands in Phase 1.
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
└── ArgusKit/                     SwiftPM package — everything except UI
    ├── Package.swift             iOS 17+ / macOS 14+, Swift language mode v5
    └── Sources/ArgusKit/
        ├── Models/               DTO mirrors (JSONValue, enums, sessions, fleet, …)
        ├── API/                  ArgusClient (URLSession), ServerConfig, TokenStore
        ├── Realtime/             StreamClient — Socket.IO /stream → AsyncStream
        └── Engine/               TranscriptState reducer, DeltaSplit, UsageParser,
                                  ContextWindows (all pure + unit-tested)
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

- **Phase 0 (this):** ArgusKit foundations + fixtures + CI.
- **Phase 1:** SwiftUI app (XcodeGen target): server/login flow,
  project-grouped session list, streaming transcript, composer.
- **Phase 2:** iPad `NavigationSplitView` + inspector (files, commits,
  diffs), usage badge + context ring, model picker, prompt queue,
  attachments, fork/rename/archive.
- **Phase 3:** machines panel, user panel (usage/quota/extensions).
- **Phase 4:** APNs push (net-new server work), Live Activity for a
  running turn; terminal (SwiftTerm) as stretch.
