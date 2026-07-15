import Foundation

// Wire enums, mirrored from packages/shared-types/src/protocol.ts.
//
// Every enum that arrives FROM the server decodes tolerantly: an
// unrecognized raw value becomes `.unknown` instead of failing the whole
// payload. The server evolves ahead of shipped app builds, so decode
// tolerance is a hard requirement (the deprecated OpenAPI-codegen attempt
// died partly on strict decoding).
//
// The tolerant `init(from:)` is written INSIDE each enum on purpose: an
// explicit member always wins witness resolution, whereas a protocol-
// extension default can silently lose to the compiler-synthesized strict
// decoder. Do not refactor this into a protocol default.

@inline(__always)
private func decodeTolerant<T: RawRepresentable>(
    _ decoder: Decoder,
    fallback: T
) -> T where T.RawValue == String {
    guard let container = try? decoder.singleValueContainer(),
          let raw = try? container.decode(String.self)
    else { return fallback }
    return T(rawValue: raw) ?? fallback
}

/// `AgentType` is an open string by design ("AgentType is an open string
/// and the UI falls back to a generic icon for unknown types").
public typealias AgentType = String

public enum KnownAgentType {
    public static let claudeCode: AgentType = "claude-code"
    public static let codex: AgentType = "codex"
    public static let cursorCLI: AgentType = "cursor-cli"
}

public enum SessionStatus: String, Codable, Equatable, Sendable {
    case active
    case idle
    case failed
    case unknown

    public init(from decoder: Decoder) throws {
        self = decodeTolerant(decoder, fallback: .unknown)
    }
}

public enum MachineStatus: String, Codable, Equatable, Sendable {
    case online
    case offline
    case unknown

    public init(from decoder: Decoder) throws {
        self = decodeTolerant(decoder, fallback: .unknown)
    }
}

public enum CommandStatus: String, Codable, Equatable, Sendable {
    case pending
    case sent
    case running
    case completed
    case failed
    case cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        self = decodeTolerant(decoder, fallback: .unknown)
    }

    /// True while the turn may still produce chunks. `.unknown` counts as
    /// non-terminal so a new server-side status never freezes a spinner
    /// into a phantom "done".
    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled: return true
        case .pending, .sent, .running, .unknown: return false
        }
    }
}

public enum CommandKind: String, Codable, Equatable, Sendable {
    case execute
    case cancel
    case unknown

    public init(from decoder: Decoder) throws {
        self = decodeTolerant(decoder, fallback: .unknown)
    }
}

public enum ResultKind: String, Codable, Equatable, Sendable {
    case delta
    case stdout
    case stderr
    case tool
    case progress
    case final
    case error
    case unknown

    public init(from decoder: Decoder) throws {
        self = decodeTolerant(decoder, fallback: .unknown)
    }
}

/// Shared helper for the same pattern outside this file (FSEntryKind).
enum TolerantDecode {
    static func decode<T: RawRepresentable>(
        _ decoder: Decoder,
        fallback: T
    ) -> T where T.RawValue == String {
        decodeTolerant(decoder, fallback: fallback)
    }
}
