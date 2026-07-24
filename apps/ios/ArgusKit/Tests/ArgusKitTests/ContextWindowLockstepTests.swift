import CryptoKit
import Foundation
import Testing
@testable import ArgusKit

/// Mechanically enforces the `contextWindow.ts` ↔ `ContextWindow.swift`
/// lockstep. The Swift table is a hand-written mirror of the shared TS
/// one, and nothing used to tie them together: the Fable 1M entry
/// landed in TS on 2026-07-16, the mirror missed it, and the iOS
/// context ring read 5x too full until a user noticed.
///
/// This test pins the TS file's SHA-256. Any edit to it — including
/// comment-only edits, since the comments encode load-bearing rules
/// like entry ordering — fails here until someone re-verifies the
/// mirror and re-pins. `.github/workflows/ios.yml` triggers on that TS
/// path specifically so the failure surfaces in the same push that
/// changed the table, not on the next unrelated iOS build.
@Suite("ContextWindow lockstep — shared TS table pinned by hash")
struct ContextWindowLockstepTests {
    /// SHA-256 of `packages/shared-types/src/contextWindow.ts` as of the
    /// last time the Swift mirror was verified against it.
    ///
    /// THIS FAILING MEANS the TS table changed. To fix:
    ///   1. Port the change into ContextWindow.swift.
    ///   2. Extend ContextWindowTests.swift to cover it.
    ///   3. Re-pin: shasum -a 256 packages/shared-types/src/contextWindow.ts
    private static let pinnedSHA256 =
        "d68b9e37e3fe61ba7c988015a02b274f100631090a32acba2b6a067024fe512b"

    @Test("shared contextWindow.ts is unchanged since the last mirror sync")
    func tsTableUnchanged() throws {
        let tsURL = Self.repoRoot.appending(
            path: "packages/shared-types/src/contextWindow.ts"
        )
        let data = try #require(
            try? Data(contentsOf: tsURL),
            "contextWindow.ts not found at \(tsURL.path) — if it moved, update this test's pointer AND the mirror note in the TS file."
        )
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #expect(
            hash == Self.pinnedSHA256,
            """
            packages/shared-types/src/contextWindow.ts changed \
            (sha256 \(hash), pinned \(Self.pinnedSHA256)).
            Port the change into ContextWindow.swift, extend \
            ContextWindowTests.swift, then update pinnedSHA256 in \
            ContextWindowLockstepTests.swift to re-pin the mirror.
            """
        )
    }

    /// This file sits at apps/ios/ArgusKit/Tests/ArgusKitTests/ —
    /// six components up is the repo root. Works both under `swift test`
    /// on CI runners and locally: #filePath is absolute on the machine
    /// that compiled the test, which is the machine running it.
    private static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // ContextWindowLockstepTests.swift
            .deletingLastPathComponent() // ArgusKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ArgusKit
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // apps → repo root
    }
}
