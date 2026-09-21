package app.argus.core.model

import app.argus.core.ArgusJson
import app.argus.core.engine.TranscriptState
import app.argus.core.realtime.FSChangedPayload
import app.argus.core.realtime.GitChangedPayload
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Guards the load-bearing property of the whole model layer: server-side
 * evolution (new enum values, new fields, both wire dressings of a
 * chunk) must NEVER fail a decode in a shipped app build.
 */
class ToleranceTest {
    @Test
    fun `unknown enum raw values decode to UNKNOWN, not an error`() {
        val session = ArgusJson.decodeFromString<SessionDTO>(
            """
            {
              "id": "s1", "userId": "u1", "title": "t",
              "externalId": null, "status": "hibernating", "unread": false,
              "archivedAt": null,
              "createdAt": "2026-07-05T10:00:00.000Z",
              "updatedAt": "2026-07-05T10:00:00.000Z"
            }
            """,
        )
        assertEquals(SessionStatus.UNKNOWN, session.status)
    }

    @Test
    fun `unknown extra fields are ignored (server sends more than shared-types)`() {
        val command = ArgusJson.decodeFromString<CommandDTO>(
            """
            {
              "id": "c1", "sessionId": "s1", "kind": "execute",
              "prompt": "hi", "status": "completed",
              "createdAt": "2026-07-05T10:00:00.000Z", "completedAt": null,
              "usage": {"inputTokens": 5},
              "someFutureField": {"nested": true}
            }
            """,
        )
        assertEquals(CommandStatus.COMPLETED, command.status)
    }

    @Test
    fun `WS chunk shape - full fields, numeric millis ts`() {
        val chunk = ArgusJson.decodeFromString<ResultChunk>(
            """
            {
              "id": "ch1", "commandId": "c1", "sessionId": "s1",
              "seq": 3, "kind": "delta", "delta": "hey",
              "ts": 1751700000123, "isFinal": false
            }
            """,
        )
        assertEquals("s1", chunk.sessionId)
        assertEquals(1_751_700_000_123L, chunk.ts)
        assertEquals(ResultKind.DELTA, chunk.kind)
    }

    @Test
    fun `sidecar version DTO decodes`() {
        val version = ArgusJson.decodeFromString<SidecarVersionInfo>(
            """
            {"current": "0.3.1", "latest": "0.4.0",
             "latestCheckedAt": "2026-07-06T10:00:00.000Z", "updateAvailable": true}
            """,
        )
        assertTrue(version.updateAvailable)
    }

    @Test
    fun `REST chunk shape - missing fields, ISO-string ts, unknown kind`() {
        val chunk = ArgusJson.decodeFromString<ResultChunk>(
            """
            {
              "id": "ch2", "commandId": "c1", "seq": 1, "kind": "hologram",
              "delta": null, "content": "x", "meta": null,
              "ts": "2026-07-05T10:00:00.500Z"
            }
            """,
        )
        assertNull(chunk.sessionId)
        assertFalse(chunk.isFinal)
        assertEquals(ResultKind.UNKNOWN, chunk.kind)
        assertTrue(chunk.ts > 1_700_000_000_000L)
        assertEquals(1_783_245_600_500L, chunk.ts)

        // And the engine accepts sessionId-less chunks as trusted.
        val state = TranscriptState("whatever")
        assertTrue(state.append(chunk))
    }

    @Test
    fun `an unparseable ts decodes as 0, never as an error`() {
        val chunk = ArgusJson.decodeFromString<ResultChunk>(
            """{"id": "ch3", "commandId": "c1", "seq": 2, "kind": "delta", "ts": "yesterday"}""",
        )
        assertEquals(0L, chunk.ts)
        val nullTs = ArgusJson.decodeFromString<ResultChunk>(
            """{"id": "ch4", "commandId": "c1", "seq": 3, "kind": "delta", "ts": null}""",
        )
        assertEquals(0L, nullTs.ts)
    }

    @Test
    fun `a non-string enum value lands on UNKNOWN without derailing the decoder`() {
        val session = ArgusJson.decodeFromString<SessionDTO>(
            """
            {
              "id": "s9", "userId": "u1", "title": "t", "status": 7, "unread": true,
              "createdAt": "2026-07-05T10:00:00.000Z", "updatedAt": "2026-07-05T10:00:00.000Z"
            }
            """,
        )
        assertEquals(SessionStatus.UNKNOWN, session.status)
        assertTrue(session.unread)
    }

    // MARK: Runner refactor (docs/plan-agent-to-runners.md)
    //
    // The Agent entity is retired: sessions route by projectId, watcher
    // nudges are project-scoped, and catalogs are machine×cliType. The
    // wire no longer carries any agentId, and a stray one from an older
    // server must decode as an ignored extra field — never a decode
    // failure that would blank the sidebar on a live device.

    @Test
    fun `SessionDTO carries the project pin (projectId + cliType)`() {
        val session = ArgusJson.decodeFromString<SessionDTO>(
            """
            {
              "id": "s1", "userId": "u1", "agentId": "a1",
              "projectId": "p1", "cliType": "claude-code",
              "title": "t", "externalId": null, "status": "idle", "unread": false,
              "archivedAt": null,
              "createdAt": "2026-07-05T10:00:00.000Z",
              "updatedAt": "2026-07-05T10:00:00.000Z"
            }
            """,
        )
        assertEquals("p1", session.projectId)
        assertEquals("claude-code", session.cliType)

        // Pre-backfill rows omit both — null, not a decode failure.
        val legacy = ArgusJson.decodeFromString<SessionDTO>(
            """
            {
              "id": "s2", "userId": "u1", "agentId": "a1", "title": "t",
              "externalId": null, "status": "idle", "unread": false,
              "archivedAt": null,
              "createdAt": "2026-07-05T10:00:00.000Z",
              "updatedAt": "2026-07-05T10:00:00.000Z"
            }
            """,
        )
        assertNull(legacy.projectId)
        assertNull(legacy.cliType)
    }

    @Test
    fun `ModelCatalogResponse decodes machine x cliType, tolerating a stray agentId`() {
        // Catalogs belong to (machineId, cliType).
        val machineRoute = ArgusJson.decodeFromString<ModelCatalogResponse>(
            """
            {
              "machineId": "m1", "cliType": "claude-code", "source": "static",
              "fetchedAt": "2026-07-05T10:00:00.000Z",
              "models": [{"id": "claude-fable-5", "displayName": "Fable 5"}]
            }
            """,
        )
        assertEquals("m1", machineRoute.machineId)
        assertEquals("claude-code", machineRoute.cliType)
        assertEquals(1, machineRoute.models.size)

        // An older server that still stamps agentId must decode fine —
        // the stray key is ignored, machineId simply absent.
        val stray = ArgusJson.decodeFromString<ModelCatalogResponse>(
            """
            {
              "agentId": "a1", "source": "cli",
              "fetchedAt": "2026-07-05T10:00:00.000Z", "models": []
            }
            """,
        )
        assertNull(stray.machineId)
        assertTrue(stray.models.isEmpty())
    }

    @Test
    fun `watcher nudges decode from the project-scoped pair, tolerating a stray agentId`() {
        // Runner sidecar: project pair present — panels match on
        // (machineId, workingDir). A stray empty agentId is ignored.
        val fs = ArgusJson.decodeFromString<FSChangedPayload>(
            """{"agentId": "", "path": "src", "machineId": "m1", "workingDir": "/home/k/proj"}""",
        )
        assertEquals("m1", fs.machineId)
        assertEquals("/home/k/proj", fs.workingDir)

        // A nudge with neither identity still decodes (degrades matching).
        val bare = ArgusJson.decodeFromString<FSChangedPayload>("""{"path": "src"}""")
        assertNull(bare.workingDir)

        val git = ArgusJson.decodeFromString<GitChangedPayload>(
            """{"machineId": "m1", "workingDir": "/home/k/proj"}""",
        )
        assertEquals("/home/k/proj", git.workingDir)
    }

    @Test
    fun `ProjectDTO decodes the promoted row and the pre-promotion shape`() {
        val promoted = ArgusJson.decodeFromString<ProjectDTO>(
            """
            {
              "id": "p1", "machineId": "m1", "workingDir": "/home/k/proj",
              "name": "My Project", "supportsTerminal": true,
              "archivedAt": "2026-07-05T10:00:00.000Z",
              "archiveSnapshot": {"archivedAgentIds": ["a1"], "archivedSessionIds": ["s1", "s2"]},
              "iconKey": "A"
            }
            """,
        )
        assertEquals("My Project", promoted.name)
        assertEquals(true, promoted.supportsTerminal)
        assertEquals(2, promoted.archiveSnapshot?.archivedSessionIds?.size)

        // Older server (icons only) — every promoted field absent.
        val legacy = ArgusJson.decodeFromString<ProjectDTO>(
            """{"id": "p1", "machineId": "m1", "workingDir": "/home/k/proj", "iconKey": null}""",
        )
        assertNull(legacy.name)
        assertNull(legacy.archivedAt)
    }

    @Test
    fun `FSReadResult decodes every kind and degrades unknown ones`() {
        val text = ArgusJson.decodeFromString<FSReadResponse>(
            """{"path": "a.txt", "result": {"kind": "text", "content": "hi", "size": 2}}""",
        )
        assertEquals(FSReadResult.Text(content = "hi", size = 2), text.result)

        val image = ArgusJson.decodeFromString<FSReadResponse>(
            """{"path": "a.png", "result": {"kind": "image", "mime": "image/png", "base64": "AA==", "size": 1}}""",
        )
        assertEquals(FSReadResult.Image(mime = "image/png", base64 = "AA==", size = 1), image.result)

        val binary = ArgusJson.decodeFromString<FSReadResponse>(
            """{"path": "a.bin", "result": {"kind": "binary", "size": 9}}""",
        )
        assertEquals(FSReadResult.Binary(size = 9), binary.result)

        val future = ArgusJson.decodeFromString<FSReadResponse>(
            """{"path": "a.ipynb", "result": {"kind": "notebook", "cells": []}}""",
        )
        assertEquals(FSReadResult.Unsupported(kind = "notebook"), future.result)
    }
}
