import Foundation
@testable import ArgusKit

enum TestSupport {
    static func chunk(
        id: String = UUID().uuidString,
        commandId: String = "cmd-1",
        sessionId: String = "sess-1",
        seq: Int,
        kind: ResultKind,
        delta: String? = nil,
        content: String? = nil,
        meta: [String: JSONValue]? = nil,
        isFinal: Bool = false
    ) -> ResultChunk {
        ResultChunk(
            id: id,
            commandId: commandId,
            agentId: "agent-1",
            sessionId: sessionId,
            seq: seq,
            kind: kind,
            delta: delta,
            content: content,
            meta: meta,
            ts: 1_750_000_000_000 + seq,
            isFinal: isFinal
        )
    }

    static func command(
        id: String = "cmd-1",
        sessionId: String = "sess-1",
        kind: CommandKind = .execute,
        prompt: String? = "do the thing",
        status: CommandStatus = .running,
        createdAt: String = "2026-07-05T10:00:00.000Z"
    ) -> CommandDTO {
        let json = """
        {
          "id": "\(id)",
          "sessionId": "\(sessionId)",
          "agentId": "agent-1",
          "kind": "\(kind.rawValue)",
          "prompt": \(prompt.map { "\"\($0)\"" } ?? "null"),
          "status": "\(status.rawValue)",
          "createdAt": "\(createdAt)",
          "completedAt": null
        }
        """
        // Decoding keeps the fixture path honest (CommandDTO has no
        // public memberwise init on purpose — DTOs come off the wire).
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(CommandDTO.self, from: Data(json.utf8))
    }

    static func fixtureData(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(
            forResource: name,
            withExtension: "json",
            subdirectory: "Fixtures"
        ) else {
            throw NSError(
                domain: "TestSupport",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "missing fixture \(name).json"]
            )
        }
        return try Data(contentsOf: url)
    }

    static func decodeFixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: fixtureData(name))
    }
}
