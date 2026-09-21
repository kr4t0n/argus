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
        createdAt: String = "2026-07-05T10:00:00.000Z",
        attachmentIds: [String]? = nil
    ) -> CommandDTO {
        let attachmentsJSON = attachmentIds.map { ids in
            let entries = ids.map { attachmentId in
                """
                {"id": "\(attachmentId)", "filename": "\(attachmentId).png",
                 "mime": "image/png", "size": 1,
                 "url": "/attachments/\(attachmentId)?t=T",
                 "createdAt": "2026-07-05T10:00:00.000Z"}
                """
            }
            return "[\(entries.joined(separator: ","))]"
        }
        let json = """
        {
          "id": "\(id)",
          "sessionId": "\(sessionId)",
          "kind": "\(kind.rawValue)",
          "prompt": \(prompt.map { "\"\($0)\"" } ?? "null"),
          "status": "\(status.rawValue)",
          "createdAt": "\(createdAt)",
          "completedAt": null,
          "attachments": \(attachmentsJSON ?? "null")
        }
        """
        // Decoding keeps the fixture path honest (CommandDTO has no
        // public memberwise init on purpose — DTOs come off the wire).
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(CommandDTO.self, from: Data(json.utf8))
    }

    static func session(
        id: String = "sess-1",
        title: String = "Session",
        cliType: String? = "claude-code",
        projectId: String? = nil,
        status: SessionStatus = .idle,
        unread: Bool = false,
        updatedAt: String = "2026-07-05T10:00:00.000Z",
        archivedAt: String? = nil
    ) -> SessionDTO {
        func literal(_ value: String?) -> String {
            value.map { "\"\($0)\"" } ?? "null"
        }
        let json = """
        {
          "id": "\(id)",
          "userId": "u1",
          "projectId": \(literal(projectId)),
          "cliType": \(literal(cliType)),
          "title": "\(title)",
          "externalId": null,
          "status": "\(status.rawValue)",
          "unread": \(unread),
          "archivedAt": \(literal(archivedAt)),
          "createdAt": "2026-07-05T10:00:00.000Z",
          "updatedAt": "\(updatedAt)"
        }
        """
        // Same posture as `command(...)`: decode rather than construct.
        // swiftlint:disable:next force_try
        return try! JSONDecoder().decode(SessionDTO.self, from: Data(json.utf8))
    }

    /// For `.enabled(if:)` on fixtures that are captured on demand — a
    /// test that needs one skips (visibly) until the capture script has
    /// been run against a server that can produce it.
    static func hasFixture(_ name: String) -> Bool {
        Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") != nil
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
