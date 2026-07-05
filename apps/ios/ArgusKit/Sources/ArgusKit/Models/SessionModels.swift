import Foundation

// Mirrors packages/shared-types/src/api.ts (sessions / commands / chunks /
// attachments) and protocol.ts (ResultChunk).
//
// Timestamps stay `String` (ISO-8601 with fractional seconds, as Prisma
// serializes them) — parse with `ISO8601.parse` at display time instead of
// making every decode depend on a date strategy.

public struct SessionDTO: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let userId: String
    public let agentId: String
    public let title: String
    public let externalId: String?
    public let status: SessionStatus
    /// Unread-result marker, orthogonal to `status`. Sidebar dot iff true.
    public let unread: Bool
    /// Session-default model choice; nil means "CLI default".
    public let modelSelection: ModelSelection?
    public let archivedAt: String?
    public let createdAt: String
    public let updatedAt: String
}

/// Payload of the `session:status` WS event. `updatedAt` enables the
/// monotonic staleness guard: every status/unread write bumps the row's
/// updatedAt, so an older payload must never overwrite a newer one.
public struct SessionStatusEvent: Codable, Equatable, Sendable {
    public let id: String
    public let status: SessionStatus
    public let unread: Bool
    public let updatedAt: String
}

public struct AttachmentDTO: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let filename: String
    public let mime: String
    public let size: Int
    /// API-base-relative path incl. a short-lived token:
    /// `/attachments/{id}?t={token}` — usable without an Authorization header.
    public let url: String
    public let createdAt: String
}

/// NOTE: the server also sends fields shared-types omits (e.g. a
/// denormalized `usage` on command rows). Codable ignores unknown keys —
/// never add strictness that would reject them.
public struct CommandDTO: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let sessionId: String
    public let agentId: String
    public let kind: CommandKind
    public let prompt: String?
    public let status: CommandStatus
    /// Merged adapter options the turn was dispatched with (ModelSelection
    /// keys today). Absent for pre-feature rows / optionless turns.
    public let options: [String: JSONValue]?
    public let createdAt: String
    public let completedAt: String?
    public let attachments: [AttachmentDTO]?
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
    public let id: String
    public let commandId: String
    /// Present on WS-relayed chunks only.
    public let agentId: String?
    /// Present on WS-relayed chunks only.
    public let sessionId: String?
    public let seq: Int
    public let kind: ResultKind
    /// Incremental text; present for kind == .delta.
    public let delta: String?
    /// Full content for non-delta kinds.
    public let content: String?
    /// Raw upstream CLI event, verbatim. Everything adapter-specific
    /// (usage, tool names, diffs, thinking) is parsed out of here.
    public let meta: [String: JSONValue]?
    /// Unix millis.
    public let ts: Int
    /// False on REST rows (terminal-ness is re-derivable from `kind`).
    public let isFinal: Bool

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
    public let agentId: String
    public let title: String?
    public let prompt: String?
    public let modelSelection: ModelSelection?

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
    public let prompt: String
    public let attachmentIds: [String]?
    public let options: [String: JSONValue]?

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
    public let modelSelection: ModelSelection?

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
    public let session: SessionDTO
    public let commands: [CommandDTO]
    public let chunks: [ResultChunk]
    public let hasMore: Bool
}

/// `GET /sessions/:id/chunks?afterSeq=` — reconnect delta fetch.
public struct SessionChunksResponse: Decodable, Sendable {
    public let commands: [CommandDTO]
    public let chunks: [ResultChunk]
}

/// `GET /sessions/:id/history?before=&limit=` — scroll-up pagination.
public struct SessionHistoryResponse: Decodable, Sendable {
    public let commands: [CommandDTO]
    public let chunks: [ResultChunk]
    public let hasMore: Bool
}

/// `POST /sessions` — `command` is non-nil when the request carried an
/// initial prompt (the first turn is dispatched inline).
public struct CreateSessionResponse: Decodable, Sendable {
    public let session: SessionDTO
    public let command: CommandDTO?
}
