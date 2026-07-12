import Foundation

// Mirrors packages/shared-types/src/protocol.ts (FSEntry / GitStatus /
// GitCommit) and api.ts (FSListResponse / FSReadResponse / GitLogResponse).

public enum FSEntryKind: String, Codable, Equatable, Sendable {
    case file
    case dir
    case symlink
    case unknown

    public init(from decoder: Decoder) throws {
        self = TolerantDecode.decode(decoder, fallback: .unknown)
    }
}

public struct FSEntry: Codable, Equatable, Sendable {
    public let name: String
    public let kind: FSEntryKind
    public let size: Int
    /// Unix millis.
    public let mtime: Int
    /// Only meaningful when the listing was requested with `showAll`.
    public let gitignored: Bool?
}

/// Snapshot of the workingDir's git HEAD. `branch` is nil in detached-HEAD
/// states; `head` is then the short SHA.
public struct GitStatus: Codable, Equatable, Sendable {
    public let branch: String?
    public let head: String
    public let detached: Bool
}

/// `GET /agents/:id/fs/list`.
public struct FSListResponse: Decodable, Sendable {
    public let path: String
    public let entries: [FSEntry]
    /// Present when `depth > 1` was requested: path (relative to the
    /// workingDir; "" = root) → that directory's listing.
    public let listings: [String: [FSEntry]]?
    public let git: GitStatus?
}

/// `GET /agents/:id/fs/read` — discriminated union on `kind`. Unknown
/// kinds decode as `.unsupported` so a future server-side viewer type
/// degrades gracefully.
public enum FSReadResult: Equatable, Sendable {
    case text(content: String, size: Int)
    case image(mime: String, base64: String, size: Int)
    case binary(size: Int)
    case unsupported(kind: String)
}

extension FSReadResult: Decodable {
    private enum CodingKeys: String, CodingKey {
        case kind, content, mime, base64, size
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "text":
            self = .text(
                content: try container.decode(String.self, forKey: .content),
                size: try container.decode(Int.self, forKey: .size)
            )
        case "image":
            self = .image(
                mime: try container.decode(String.self, forKey: .mime),
                base64: try container.decode(String.self, forKey: .base64),
                size: try container.decode(Int.self, forKey: .size)
            )
        case "binary":
            self = .binary(size: try container.decode(Int.self, forKey: .size))
        default:
            self = .unsupported(kind: kind)
        }
    }
}

public struct FSReadResponse: Decodable, Sendable {
    public let path: String
    public let result: FSReadResult
}

public struct GitCommit: Codable, Equatable, Sendable, Identifiable {
    /// Full 40-char hash.
    public let sha: String
    /// 7-char display form.
    public let shortSha: String
    /// First line of the commit message.
    public let subject: String
    public let authorName: String
    /// ISO-8601 author timestamp.
    public let authorDate: String

    public var id: String { sha }
}

/// `GET /agents/:id/git/log`. Empty `commits` means "not a git repo" or a
/// fresh repo with no commits — render an empty state either way.
public struct GitLogResponse: Decodable, Sendable {
    public let commits: [GitCommit]
    public let git: GitStatus?
}
