import Foundation

// Mirrors packages/shared-types/src/api.ts (sessions / commands / chunks /
// attachments) and protocol.ts (ResultChunk).
//
// Timestamps stay `String` (ISO-8601 with fractional seconds, as Prisma
// serializes them) — parse with `ISO8601.parse` at display time instead of
// making every decode depend on a date strategy.

public struct SessionDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var userId: String
    public var agentId: String
    public var title: String
    public var externalId: String?
    public var status: SessionStatus
    /// Unread-result marker, orthogonal to `status`. Sidebar dot iff true.
    public var unread: Bool
    /// Session-default model choice; nil means "CLI default".
    public var modelSelection: ModelSelection?
    public var archivedAt: String?
    public var createdAt: String
    public var updatedAt: String
}

/// Payload of the `session:status` WS event. `updatedAt` enables the
/// monotonic staleness guard: every status/unread write bumps the row's
/// updatedAt, so an older payload must never overwrite a newer one.
public struct SessionStatusEvent: Codable, Equatable, Sendable {
    public var id: String
    public var status: SessionStatus
    public var unread: Bool
    public var updatedAt: String
}

public struct AttachmentDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var filename: String
    public var mime: String
    public var size: Int
    /// API-base-relative path incl. a short-lived token:
    /// `/attachments/{id}?t={token}` — usable without an Authorization header.
    public var url: String
    public var createdAt: String
}

/// NOTE: the server also sends fields shared-types omits (e.g. a
/// denormalized `usage` on command rows). Codable ignores unknown keys —
/// never add strictness that would reject them.
public struct CommandDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var sessionId: String
    public var agentId: String
    public var kind: CommandKind
    public var prompt: String?
    public var status: CommandStatus
    /// Merged adapter options the turn was dispatched with (ModelSelection
    /// keys today). Absent for pre-feature rows / optionless turns.
    public var options: [String: JSONValue]?
    public var createdAt: String
    public var completedAt: String?
    public var attachments: [AttachmentDTO]?
}

/// One streamed fragment of a turn. `seq` is monotonic PER COMMAND (the
/// sidecar resets it each turn); ordering is `(command.createdAt, seq)`.
///
/// The same logical chunk arrives in two dressings (verified against a
/// live server — see Tests/Fixtures/session-detail.json):
///   - WS `chunk` events relay the wire ResultChunk verbatim: carries
///     `agentId`/`sessionId`/`isFinal`, `ts` is Unix millis (number);
///   - REST rows come from Postgres: NO agentId/sessionId/isFinal
///     columns (implied by the route), `ts` is an ISO string.
/// The custom decoder below absorbs both.
public struct ResultChunk: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var commandId: String
    /// Present on WS-relayed chunks only.
    public var agentId: String?
    /// Present on WS-relayed chunks only.
    public var sessionId: String?
    public var seq: Int
    public var kind: ResultKind
    /// Incremental text; present for kind == .delta.
    public var delta: String?
    /// Full content for non-delta kinds.
    public var content: String?
    /// Raw upstream CLI event, verbatim. Everything adapter-specific
    /// (usage, tool names, diffs, thinking) is parsed out of here.
    public var meta: [String: JSONValue]?
    /// Unix millis.
    public var ts: Int
    /// False on REST rows (terminal-ness is re-derivable from `kind`).
    public var isFinal: Bool

    public init(
        id: String,
        commandId: String,
        agentId: String? = nil,
        sessionId: String? = nil,
        seq: Int,
        kind: ResultKind,
        delta: String? = nil,
        content: String? = nil,
        meta: [String: JSONValue]? = nil,
        ts: Int,
        isFinal: Bool
    ) {
        self.id = id
        self.commandId = commandId
        self.agentId = agentId
        self.sessionId = sessionId
        self.seq = seq
        self.kind = kind
        self.delta = delta
        self.content = content
        self.meta = meta
        self.ts = ts
        self.isFinal = isFinal
    }

    private enum CodingKeys: String, CodingKey {
        case id, commandId, agentId, sessionId, seq, kind, delta, content, meta, ts, isFinal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        commandId = try container.decode(String.self, forKey: .commandId)
        agentId = try container.decodeIfPresent(String.self, forKey: .agentId)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        seq = try container.decode(Int.self, forKey: .seq)
        kind = try container.decode(ResultKind.self, forKey: .kind)
        delta = try container.decodeIfPresent(String.self, forKey: .delta)
        content = try container.decodeIfPresent(String.self, forKey: .content)
        meta = try container.decodeIfPresent([String: JSONValue].self, forKey: .meta)
        isFinal = try container.decodeIfPresent(Bool.self, forKey: .isFinal) ?? false
        if let millis = try? container.decode(Int.self, forKey: .ts) {
            ts = millis
        } else if let iso = try? container.decode(String.self, forKey: .ts),
                  let date = ISO8601.parse(iso) {
            ts = Int(date.timeIntervalSince1970 * 1000)
        } else if let seconds = try? container.decode(Double.self, forKey: .ts) {
            ts = Int(seconds)
        } else {
            ts = 0
        }
    }
}

public typealias ResultChunkDTO = ResultChunk

// MARK: Requests

public struct CreateSessionRequest: Encodable, Sendable {
    public var agentId: String
    public var title: String?
    public var prompt: String?
    public var modelSelection: ModelSelection?

    public init(
        agentId: String,
        title: String? = nil,
        prompt: String? = nil,
        modelSelection: ModelSelection? = nil
    ) {
        self.agentId = agentId
        self.title = title
        self.prompt = prompt
        self.modelSelection = modelSelection
    }
}

public struct CreateCommandRequest: Encodable, Sendable {
    public var prompt: String
    public var attachmentIds: [String]?
    public var options: [String: JSONValue]?

    public init(
        prompt: String,
        attachmentIds: [String]? = nil,
        options: [String: JSONValue]? = nil
    ) {
        self.prompt = prompt
        self.attachmentIds = attachmentIds
        self.options = options
    }
}

/// PATCH /sessions/:id/model — `modelSelection: null` (an explicit JSON
/// null, not an absent key) clears back to "CLI default", so this encodes
/// the key unconditionally.
public struct UpdateSessionModelRequest: Encodable, Sendable {
    public var modelSelection: ModelSelection?

    public init(modelSelection: ModelSelection?) {
        self.modelSelection = modelSelection
    }

    private enum CodingKeys: String, CodingKey { case modelSelection }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(modelSelection, forKey: .modelSelection)
    }
}

// MARK: Responses

/// `GET /sessions/:id` — initial load (tail window) or afterSeq backfill.
public struct SessionDetailResponse: Decodable, Sendable {
    public var session: SessionDTO
    public var commands: [CommandDTO]
    public var chunks: [ResultChunk]
    public var hasMore: Bool
}

/// `GET /sessions/:id/chunks?afterSeq=` — reconnect delta fetch.
public struct SessionChunksResponse: Decodable, Sendable {
    public var commands: [CommandDTO]
    public var chunks: [ResultChunk]
}

/// `GET /sessions/:id/history?before=&limit=` — scroll-up pagination.
public struct SessionHistoryResponse: Decodable, Sendable {
    public var commands: [CommandDTO]
    public var chunks: [ResultChunk]
    public var hasMore: Bool
}

/// `POST /sessions` — `command` is non-nil when the request carried an
/// initial prompt (the first turn is dispatched inline).
public struct CreateSessionResponse: Decodable, Sendable {
    public var session: SessionDTO
    public var command: CommandDTO?
}
