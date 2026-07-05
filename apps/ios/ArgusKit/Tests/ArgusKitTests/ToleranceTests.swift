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
        #expect(state.append(chunk: chunk))
    }
}
