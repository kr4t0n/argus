package app.argus.core.engine

import app.argus.core.repoRoot
import java.io.File
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/ContextWindowLockstepTests.swift.

/**
 * Mechanically enforces the `contextWindow.ts` ↔ `ContextWindow.kt`
 * lockstep. The Kotlin table is a hand-written mirror of the shared TS
 * one (as is the Swift one), and nothing used to tie them together: the
 * Fable 1M entry landed in TS on 2026-07-16, the Swift mirror missed it,
 * and the iOS context ring read 5x too full until a user noticed.
 *
 * This test pins the TS file's SHA-256. Any edit to it — including
 * comment-only edits, since the comments encode load-bearing rules
 * like entry ordering — fails here until someone re-verifies the
 * mirror and re-pins. `.github/workflows/android.yml` triggers on that TS
 * path specifically so the failure surfaces in the same push that
 * changed the table, not on the next unrelated Android build.
 */
class ContextWindowLockstepTest {
    private companion object {
        /**
         * SHA-256 of `packages/shared-types/src/contextWindow.ts` as of the
         * last time the Kotlin mirror was verified against it.
         *
         * THIS FAILING MEANS the TS table changed. To fix:
         *   1. Port the change into ContextWindow.kt.
         *   2. Extend ContextWindowTest.kt to cover it.
         *   3. Re-pin: sha256sum packages/shared-types/src/contextWindow.ts
         */
        const val PINNED_SHA256 =
            "192b3f09e8b3908cfcc77fa9f8fce4af2db0a787e19868025aad7bda9d9a4ab5"
    }

    @Test
    fun `shared contextWindow ts is unchanged since the last mirror sync`() {
        val tsFile = File(repoRoot(), "packages/shared-types/src/contextWindow.ts")
        assertTrue(
            tsFile.isFile,
            "contextWindow.ts not found at ${tsFile.path} — if it moved, update this test's pointer " +
                "AND the mirror note in the TS file.",
        )
        val digest = MessageDigest.getInstance("SHA-256").digest(tsFile.readBytes())
        val hash = digest.joinToString("") { byte ->
            (byte.toInt() and 0xff).toString(16).padStart(2, '0')
        }
        assertEquals(
            PINNED_SHA256,
            hash,
            "packages/shared-types/src/contextWindow.ts changed " +
                "(sha256 $hash, pinned $PINNED_SHA256). " +
                "Port the change into ContextWindow.kt, extend ContextWindowTest.kt, " +
                "then update PINNED_SHA256 in ContextWindowLockstepTest.kt to re-pin the mirror.",
        )
    }
}
