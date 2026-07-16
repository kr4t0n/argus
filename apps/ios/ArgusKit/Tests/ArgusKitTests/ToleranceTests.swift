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
          "id": "s1", "userId": "u1", "title": "t",
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
          "id": "c1", "sessionId": "s1", "kind": "execute",
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
          "id": "ch1", "commandId": "c1", "sessionId": "s1",
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
    // The Agent entity is retired: sessions route by projectId, watcher
    // nudges are project-scoped, and catalogs are machine×cliType. The
    // wire no longer carries any agentId, and a stray one from an older
    // server must decode as an ignored extra field — never a decode
    // failure that would blank the sidebar on a live device.

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

    @Test("ModelCatalogResponse decodes machine×cliType, tolerating a stray agentId")
    func modelCatalogDecodes() throws {
        // Catalogs belong to (machineId, cliType).
        let machineRoute = try JSONDecoder().decode(ModelCatalogResponse.self, from: Data("""
        {
          "machineId": "m1", "cliType": "claude-code", "source": "static",
          "fetchedAt": "2026-07-05T10:00:00.000Z",
          "models": [{"id": "claude-fable-5", "displayName": "Fable 5"}]
        }
        """.utf8))
        #expect(machineRoute.machineId == "m1")
        #expect(machineRoute.cliType == "claude-code")
        #expect(machineRoute.models.count == 1)

        // An older server that still stamps agentId must decode fine —
        // the stray key is ignored, machineId simply absent.
        let stray = try JSONDecoder().decode(ModelCatalogResponse.self, from: Data("""
        {
          "agentId": "a1", "source": "cli",
          "fetchedAt": "2026-07-05T10:00:00.000Z", "models": []
        }
        """.utf8))
        #expect(stray.machineId == nil)
        #expect(stray.models.isEmpty)
    }

    @Test("watcher nudges decode from the project-scoped pair, tolerating a stray agentId")
    func watcherNudgeShapes() throws {
        // Runner sidecar: project pair present — panels match on
        // (machineId, workingDir). A stray empty agentId is ignored.
        let fs = try JSONDecoder().decode(FSChangedPayload.self, from: Data("""
        {"agentId": "", "path": "src", "machineId": "m1", "workingDir": "/home/k/proj"}
        """.utf8))
        #expect(fs.machineId == "m1")
        #expect(fs.workingDir == "/home/k/proj")

        // A nudge with neither identity still decodes (degrades matching).
        let bare = try JSONDecoder().decode(FSChangedPayload.self, from: Data("""
        {"path": "src"}
        """.utf8))
        #expect(bare.workingDir == nil)

        let git = try JSONDecoder().decode(GitChangedPayload.self, from: Data("""
        {"machineId": "m1", "workingDir": "/home/k/proj"}
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
