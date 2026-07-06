import Foundation

// Mirrors packages/shared-types/src/usage.ts (TokenUsage) and api.ts
// (/me/* views). TokenUsage doubles as the wire shape of /me/usage AND
// the output of the client-side usage parser (UsageParser) — one struct,
// exactly like the web.

/// Normalized per-event token tally. The four counts default to 0 so
/// callers can sum without nil-guarding; `costUsd` / `durationApiMs` stay
/// optional because not every adapter emits them (and the badge hides the
/// cost line when absent).
public struct TokenUsage: Codable, Equatable, Sendable {
    public var inputTokens: Double
    public var outputTokens: Double
    /// Read from a previously-cached prompt.
    public var cacheReadTokens: Double
    /// Written into a NEW cache entry (Anthropic-only concept).
    public var cacheWriteTokens: Double
    /// USD as reported by the adapter (claude-code only today).
    public var costUsd: Double?
    /// Milliseconds waiting on the upstream API this turn.
    public var durationApiMs: Double?

    public init(
        inputTokens: Double = 0,
        outputTokens: Double = 0,
        cacheReadTokens: Double = 0,
        cacheWriteTokens: Double = 0,
        costUsd: Double? = nil,
        durationApiMs: Double? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.costUsd = costUsd
        self.durationApiMs = durationApiMs
    }

    public static let zero = TokenUsage()

    /// True iff any field carries a meaningful value — gates badge display.
    public var hasUsage: Bool {
        inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0
            || cacheWriteTokens > 0 || (costUsd ?? 0) > 0
    }

    /// Pointwise sum; optional fields stay unset when unset on both sides.
    public func adding(_ other: TokenUsage) -> TokenUsage {
        var out = TokenUsage(
            inputTokens: inputTokens + other.inputTokens,
            outputTokens: outputTokens + other.outputTokens,
            cacheReadTokens: cacheReadTokens + other.cacheReadTokens,
            cacheWriteTokens: cacheWriteTokens + other.cacheWriteTokens
        )
        if costUsd != nil || other.costUsd != nil {
            out.costUsd = (costUsd ?? 0) + (other.costUsd ?? 0)
        }
        if durationApiMs != nil || other.durationApiMs != nil {
            out.durationApiMs = (durationApiMs ?? 0) + (other.durationApiMs ?? 0)
        }
        return out
    }
}

/// `GET /me/usage` — rolling windows over the same per-adapter parse the
/// per-session badge uses; the toggle is pure client-side slicing.
public struct WindowedUsage: Codable, Equatable, Sendable {
    public let last7Days: TokenUsage
    public let last30Days: TokenUsage
    public let lifetime: TokenUsage
}

public struct UserUsageResponse: Decodable, Sendable {
    public let usage: WindowedUsage
}

/// One bucket in the activity heatmap — `date` is `YYYY-MM-DD` (UTC).
public struct ActivityDay: Codable, Equatable, Sendable {
    public let date: String
    public let count: Int
}

public struct UserActivityResponse: Decodable, Sendable {
    public let days: [ActivityDay]
}

public struct QuotaWindow: Codable, Equatable, Sendable {
    /// Stable key: "five_hour" | "seven_day" | "weekly" | …
    public let key: String
    /// Short human label, e.g. "5-hour".
    public let label: String
    /// 0–100 percent consumed.
    public let utilizationPercent: Double
    /// ISO timestamp the window resets at, when known.
    public let resetsAt: String?
}

public struct UserQuotaRow: Codable, Equatable, Sendable {
    public let type: AgentType
    /// 'claude-code-oauth' | 'codex-chatgpt' | … (open string).
    public let source: String
    public let windows: [QuotaWindow]
    /// Set (with empty `windows`) when the probe ran but the vendor
    /// endpoint refused — render an "unknown" row, don't hide it.
    public let error: String?
    public let checkedAt: String
    public let machineId: String
    public let machineName: String
}

public struct UserQuotaResponse: Decodable, Sendable {
    public let quotas: [UserQuotaRow]
}

/// `GET`/`PUT /me/extensions` — account-level opt-in feature flags. The
/// PUT sends the full set (no server-side merge).
public struct UserExtensions: Codable, Equatable, Sendable {
    public var notes: Bool
    public var progress: Bool
    public var diff: Bool

    public init(notes: Bool = false, progress: Bool = false, diff: Bool = false) {
        self.notes = notes
        self.progress = progress
        self.diff = diff
    }
}

/// One registered push device (`POST /me/devices`). Registration is
/// idempotent: re-posting a token refreshes it, and a token that moved
/// accounts is re-homed (a device has exactly one owner).
public struct DeviceDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var token: String
    public var platform: String
    public var createdAt: String
}
