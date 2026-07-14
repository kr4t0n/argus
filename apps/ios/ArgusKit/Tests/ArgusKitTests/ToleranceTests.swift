import Foundation
import Testing
@testable import ArgusKit

/// Guards the load-bearing property of the whole model layer: server-side
/// evolution (new enum values, new fields, both wire dressings of a
/// chunk) must NEVER fail a decode in a shipped app build.
@Suite("Decode tolerance — future-proofing against server evolution")
struct ToleranceTests {
    @Test("unknown enum raw values decode to .unknown, not an error")
    func unknownEnumValues() throws {
        let json = """
        {
          "id": "s1", "userId": "u1", "agentId": "a1", "title": "t",
          "externalId": null, "status": "hibernating", "unread": false,
          "archivedAt": null,
          "createdAt": "2026-07-05T10:00:00.000Z",
          "updatedAt": "2026-07-05T10:00:00.000Z"
        }
        """
        let session = try JSONDecoder().decode(SessionDTO.self, from: Data(json.utf8))
        #expect(session.status == .unknown)
    }

    @Test("unknown extra fields are ignored (server sends more than shared-types)")
    func extraFieldsIgnored() throws {
        let json = """
        {
          "id": "c1", "sessionId": "s1", "agentId": "a1", "kind": "execute",
          "prompt": "hi", "status": "completed",
          "createdAt": "2026-07-05T10:00:00.000Z", "completedAt": null,
          "usage": {"inputTokens": 5},
          "someFutureField": {"nested": true}
        }
        """
        let command = try JSONDecoder().decode(CommandDTO.self, from: Data(json.utf8))
        #expect(command.status == .completed)
    }

    @Test("WS chunk shape: full fields, numeric millis ts")
    func wsChunkShape() throws {
        let json = """
        {
          "id": "ch1", "commandId": "c1", "agentId": "a1", "sessionId": "s1",
          "seq": 3, "kind": "delta", "delta": "hey",
          "ts": 1751700000123, "isFinal": false
        }
        """
        let chunk = try JSONDecoder().decode(ResultChunk.self, from: Data(json.utf8))
        #expect(chunk.sessionId == "s1")
        #expect(chunk.ts == 1_751_700_000_123)
    }

    @Test("sidecar version/update DTOs decode, incl. unknown plan status")
    func sidecarModels() throws {
        let version = try JSONDecoder().decode(SidecarVersionInfo.self, from: Data("""
        {"current": "0.3.1", "latest": "0.4.0",
         "latestCheckedAt": "2026-07-06T10:00:00.000Z", "updateAvailable": true}
        """.utf8))
        #expect(version.updateAvailable)

        let batch = try JSONDecoder().decode(SidecarUpdateBatchAccepted.self, from: Data("""
        {"batchId": "b1", "plan": [
          {"machineId": "m1", "machineName": "mac", "fromVersion": "0.3.1",
           "status": "some-future-status"}
        ]}
        """.utf8))
        #expect(batch.plan.first?.status == "some-future-status")
    }

    @Test("REST chunk shape: missing fields, ISO-string ts, unknown kind")
    func restChunkShape() throws {
        let json = """
        {
          "id": "ch2", "commandId": "c1", "seq": 1, "kind": "hologram",
          "delta": null, "content": "x", "meta": null,
          "ts": "2026-07-05T10:00:00.500Z"
        }
        """
        let chunk = try JSONDecoder().decode(ResultChunk.self, from: Data(json.utf8))
        #expect(chunk.sessionId == nil)
        #expect(chunk.agentId == nil)
        #expect(!chunk.isFinal)
        #expect(chunk.kind == .unknown)
        #expect(chunk.ts > 1_700_000_000_000)

        // And the engine accepts sessionId-less chunks as trusted.
        var state = TranscriptState(sessionId: "whatever")
        let inserted = state.append(chunk: chunk)
        #expect(inserted)
    }

    // MARK: Runner refactor (docs/plan-agent-to-runners.md)
    //
    // Phase 4 nulls `agentId` on session/command/terminal rows and stops
    // sending it on watcher nudges. A shipped build that force-decodes
    // it would fail the WHOLE payload — the sidebar and every transcript
    // would go dark on live devices. These tests are the contract that
    // makes the server change safe to deploy.

    @Test("SessionDTO decodes with agentId null, absent, or present")
    func sessionAgentIdOptional() throws {
        let base = """
        "id": "s1", "userId": "u1", "title": "t",
        "externalId": null, "status": "idle", "unread": false,
        "archivedAt": null,
        "createdAt": "2026-07-05T10:00:00.000Z",
        "updatedAt": "2026-07-05T10:00:00.000Z"
        """
        // Phase-4 server: the column is nulled.
        let nulled = try JSONDecoder().decode(
            SessionDTO.self,
            from: Data("{\(base), \"agentId\": null}".utf8)
        )
        #expect(nulled.agentId == nil)

        // Belt and braces: the key dropped from the payload entirely.
        let absent = try JSONDecoder().decode(SessionDTO.self, from: Data("{\(base)}".utf8))
        #expect(absent.agentId == nil)

        // Today's server still sends it — that must keep working.
        let present = try JSONDecoder().decode(
            SessionDTO.self,
            from: Data("{\(base), \"agentId\": \"a1\"}".utf8)
        )
        #expect(present.agentId == "a1")
    }

    @Test("SessionDTO carries the Phase-1 project pin (projectId + cliType)")
    func sessionProjectPin() throws {
        let json = """
        {
          "id": "s1", "userId": "u1", "agentId": "a1",
          "projectId": "p1", "cliType": "claude-code",
          "title": "t", "externalId": null, "status": "idle", "unread": false,
          "archivedAt": null,
          "createdAt": "2026-07-05T10:00:00.000Z",
          "updatedAt": "2026-07-05T10:00:00.000Z"
        }
        """
        let session = try JSONDecoder().decode(SessionDTO.self, from: Data(json.utf8))
        #expect(session.projectId == "p1")
        #expect(session.cliType == "claude-code")

        // Pre-backfill rows omit both — nil, not a decode failure.
        let legacy = try JSONDecoder().decode(SessionDTO.self, from: Data("""
        {
          "id": "s2", "userId": "u1", "agentId": "a1", "title": "t",
          "externalId": null, "status": "idle", "unread": false,
          "archivedAt": null,
          "createdAt": "2026-07-05T10:00:00.000Z",
          "updatedAt": "2026-07-05T10:00:00.000Z"
        }
        """.utf8))
        #expect(legacy.projectId == nil)
        #expect(legacy.cliType == nil)
    }

    @Test("CommandDTO decodes with agentId null (attribution-only column)")
    func commandAgentIdOptional() throws {
        let json = """
        {
          "id": "c1", "sessionId": "s1", "agentId": null, "kind": "execute",
          "prompt": "hi", "status": "completed",
          "createdAt": "2026-07-05T10:00:00.000Z", "completedAt": null
        }
        """
        let command = try JSONDecoder().decode(CommandDTO.self, from: Data(json.utf8))
        #expect(command.agentId == nil)
        #expect(command.status == .completed)
    }

    @Test("ModelCatalogResponse decodes BOTH the machine route and the legacy agent route")
    func modelCatalogBothRoutes() throws {
        // Phase-2 shape: catalogs belong to (machineId, cliType).
        let machineRoute = try JSONDecoder().decode(ModelCatalogResponse.self, from: Data("""
        {
          "machineId": "m1", "cliType": "claude-code", "source": "static",
          "fetchedAt": "2026-07-05T10:00:00.000Z",
          "models": [{"id": "claude-fable-5", "displayName": "Fable 5"}]
        }
        """.utf8))
        #expect(machineRoute.agentId == nil)
        #expect(machineRoute.machineId == "m1")
        #expect(machineRoute.cliType == "claude-code")
        #expect(machineRoute.models.count == 1)

        // Legacy shape from an older server: no machineId/cliType.
        let agentRoute = try JSONDecoder().decode(ModelCatalogResponse.self, from: Data("""
        {
          "agentId": "a1", "source": "cli",
          "fetchedAt": "2026-07-05T10:00:00.000Z", "models": []
        }
        """.utf8))
        #expect(agentRoute.agentId == "a1")
        #expect(agentRoute.machineId == nil)
    }

    @Test("watcher nudges decode from both sidecar generations")
    func watcherNudgeShapes() throws {
        // Runner sidecar (≥0.3): empty agentId, project pair present —
        // panels must match on (machineId, workingDir).
        let runner = try JSONDecoder().decode(FSChangedPayload.self, from: Data("""
        {"agentId": "", "path": "src", "machineId": "m1", "workingDir": "/home/k/proj"}
        """.utf8))
        #expect(runner.machineId == "m1")
        #expect(runner.workingDir == "/home/k/proj")

        // Pre-Phase-2 sidecar: agentId only — the legacy-room shim path.
        let legacy = try JSONDecoder().decode(FSChangedPayload.self, from: Data("""
        {"agentId": "a1", "path": "src"}
        """.utf8))
        #expect(legacy.agentId == "a1")
        #expect(legacy.workingDir == nil)

        let git = try JSONDecoder().decode(GitChangedPayload.self, from: Data("""
        {"agentId": "", "machineId": "m1", "workingDir": "/home/k/proj"}
        """.utf8))
        #expect(git.workingDir == "/home/k/proj")
    }

    @Test("ProjectDTO decodes the promoted row and the pre-promotion shape")
    func projectPromotedFields() throws {
        let promoted = try JSONDecoder().decode(ProjectDTO.self, from: Data("""
        {
          "id": "p1", "machineId": "m1", "workingDir": "/home/k/proj",
          "name": "My Project", "supportsTerminal": true,
          "archivedAt": "2026-07-05T10:00:00.000Z",
          "archiveSnapshot": {"archivedAgentIds": ["a1"], "archivedSessionIds": ["s1", "s2"]},
          "iconKey": "A"
        }
        """.utf8))
        #expect(promoted.name == "My Project")
        #expect(promoted.supportsTerminal == true)
        #expect(promoted.archiveSnapshot?.archivedSessionIds.count == 2)

        // Older server (icons only) — every promoted field absent.
        let legacy = try JSONDecoder().decode(ProjectDTO.self, from: Data("""
        {"id": "p1", "machineId": "m1", "workingDir": "/home/k/proj", "iconKey": null}
        """.utf8))
        #expect(legacy.name == nil)
        #expect(legacy.archivedAt == nil)
    }
}
