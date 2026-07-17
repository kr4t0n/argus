import Foundation

/// Port of `packages/shared-types/src/contextWindow.ts` — the
/// hand-maintained model → context-window lookup behind the donut ring.
/// Match by family substring, not exact id, so point releases don't need
/// a code change; keep the table in lockstep with the TS original
/// (`chore(shared): update model context windows` commits).
public struct ContextWindowInfo: Equatable, Sendable {
    /// Total context capacity in tokens.
    public let window: Int
    /// Human-readable family label, surfaced in tooltips.
    public let family: String
}

public enum ContextWindows {
    /// Anthropic family detector: the API id form ("claude-…") and
    /// cursor-cli's bare display names ("Opus 4.7 1M Extra High
    /// Thinking"). Family words are word-boundary-gated so "octopus"
    /// doesn't match.
    static func isAnthropicFamily(_ model: String) -> Bool {
        if model.contains("claude") { return true }
        return model.firstMatch(of: #/(^|[^a-z0-9])(opus|sonnet|haiku)([^a-z0-9]|$)/#) != nil
    }

    static func hasMillionTokenMarker(_ model: String) -> Bool {
        if model.contains("[1m]") { return true }
        return model.firstMatch(of: #/(^|[^a-z0-9])1m([^a-z0-9]|$)/#) != nil
    }

    private struct Entry {
        let match: (String) -> Bool
        let window: Int
        let family: String
    }

    // First match wins, and ORDER IS LOAD-BEARING within a vendor: the
    // Claude entries deliberately overlap (every one of them is an
    // Anthropic model) and are ordered most-specific-first — 1M-by-flag,
    // then 1M-by-default, then the baseline that would otherwise swallow
    // both. Append a new Claude family ABOVE the generic entry, never
    // below it. (Mirrors the TS table's ordering rule.)
    private static let entries: [Entry] = [
        Entry(
            match: { isAnthropicFamily($0) && hasMillionTokenMarker($0) },
            window: 1_000_000,
            family: "Claude (1M context)"
        ),
        // Claude Fable — 1M is the DEFAULT, not an opt-in facet, so there
        // is no `[1m]` token in the id to key off. Matching the family
        // word covers both id shapes at once: the API id `claude-fable-5`
        // AND cursor-cli's bare display name "Fable 5 1M Max Thinking"
        // (no "claude" substring — isAnthropicFamily misses it). Must
        // stay ABOVE the generic Claude entry, which would otherwise
        // claim `claude-fable-5` and read the ring 5x too full.
        Entry(
            match: { $0.firstMatch(of: #/(^|[^a-z0-9])fable([^a-z0-9]|$)/#) != nil },
            window: 1_000_000,
            family: "Claude Fable"
        ),
        Entry(match: { isAnthropicFamily($0) }, window: 200_000, family: "Claude"),
        Entry(match: { $0.contains("gpt-5") }, window: 400_000, family: "GPT-5"),
        Entry(match: { $0.contains("gpt-4.1") }, window: 1_000_000, family: "GPT-4.1"),
        Entry(
            match: { $0.contains("gpt-4o") || $0.contains("gpt-4-turbo") },
            window: 128_000,
            family: "GPT-4o"
        ),
        Entry(
            match: { $0.firstMatch(of: #/(^|[^a-z0-9])o[34](-|$)/#) != nil },
            window: 200_000,
            family: "OpenAI o-series"
        ),
    ]

    /// nil for unknown models — hide the ring rather than render a
    /// percentage against a guessed denominator.
    public static func lookup(model: String?) -> ContextWindowInfo? {
        guard let model, !model.isEmpty else { return nil }
        let lowercased = model.lowercased()
        for entry in entries where entry.match(lowercased) {
            return ContextWindowInfo(window: entry.window, family: entry.family)
        }
        return nil
    }
}
