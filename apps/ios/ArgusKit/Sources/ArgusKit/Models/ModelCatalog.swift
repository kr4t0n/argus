import Foundation

// Mirrors packages/shared-types/src/protocol.ts (ModelSelection /
// ModelCatalog*) and api.ts (ModelCatalogResponse).
//
// Effort levels, context and speed facets are open strings on purpose:
// the server passes selections through to the CLI without validation, and
// the catalog is CLI-reported — new facet values must not break decoding.

/// One model choice for a session or a single turn. All fields optional —
/// an empty selection means "CLI default".
public struct ModelSelection: Codable, Equatable, Sendable {
    /// Adapter-namespaced id; free text allowed (advanced escape hatch).
    public var model: String?
    /// One of protocol.ts EFFORT_LEVELS ('none'…'max') when set.
    public var effort: String?
    /// '1m' appends the `[1m]` suffix (claude-code only today).
    public var context: String?
    /// 'fast' selects the priority service tier (codex only today).
    public var speed: String?

    public init(
        model: String? = nil,
        effort: String? = nil,
        context: String? = nil,
        speed: String? = nil
    ) {
        self.model = model
        self.effort = effort
        self.context = context
        self.speed = speed
    }

    public var isEmpty: Bool {
        model == nil && effort == nil && context == nil && speed == nil
    }
}

/// Known effort levels, for pickers. The wire stays an open string.
public enum EffortLevels {
    public static let all = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
}

public struct ModelCatalogFacets: Codable, Equatable, Sendable {
    public struct Effort: Codable, Equatable, Sendable {
        public let levels: [String]
        public let defaultLevel: String

        private enum CodingKeys: String, CodingKey {
            case levels
            case defaultLevel = "default"
        }
    }

    public struct Context: Codable, Equatable, Sendable {
        /// 'default' | '1m'
        public let options: [String]
    }

    public struct Speed: Codable, Equatable, Sendable {
        /// 'standard' | 'fast'
        public let options: [String]
    }

    public let effort: Effort?
    public let context: Context?
    public let speed: Speed?
}

public struct ModelCatalogEntry: Codable, Equatable, Sendable, Identifiable {
    /// Value for ModelSelection.model when chosen — always dispatched
    /// exactly as-is, never recomposed.
    public let id: String
    public let displayName: String
    public let description: String?
    /// Display metadata (tokens), informational only.
    public let contextWindow: Int?
    /// The CLI's own default when no model flag is passed.
    public let isDefault: Bool?
    /// Grouping label for flat variant matrices (cursor-cli).
    public let family: String?
    public let variantLabel: String?
    public let facets: ModelCatalogFacets?
}

/// `GET /machines/:id/models?cliType=` (Phase-2 shape: catalogs belong
/// to the machine's installed binary) and the legacy `GET
/// /agents/:id/models` — every identity field is optional so one struct
/// decodes both routes across server versions; `?refresh=1` probes the
/// CLI live.
public struct ModelCatalogResponse: Decodable, Sendable {
    /// 'static' | 'cli'
    public let source: String
    /// Legacy agent-route identity; absent on Phase-2+ servers.
    public let agentId: String?
    /// Machine-route identity (machineId × cliType).
    public let machineId: String?
    public let cliType: String?
    public let fetchedAt: String
    public let models: [ModelCatalogEntry]
}
