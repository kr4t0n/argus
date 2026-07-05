import Foundation

/// Port of `packages/shared-types/src/usage.ts` — the ONE place that
/// knows each adapter's token-usage field names. Keep behavior identical
/// to the web so the badge never disagrees across clients.
public enum UsageParser {
    /// Parse the raw `meta` of a `final`-kind chunk into normalized usage.
    /// nil when the meta has no recognizable usage payload (error chunk,
    /// cancelled turn, old adapter).
    public static func parseUsage(
        adapterType: AgentType,
        meta: [String: JSONValue]?
    ) -> TokenUsage? {
        guard let meta, let usage = meta["usage"]?.object else { return nil }

        var parsed: TokenUsage
        switch adapterType {
        case KnownAgentType.claudeCode:
            parsed = TokenUsage(
                inputTokens: usage.pickNumber("input_tokens"),
                outputTokens: usage.pickNumber("output_tokens"),
                cacheReadTokens: usage.pickNumber("cache_read_input_tokens"),
                cacheWriteTokens: usage.pickNumber("cache_creation_input_tokens")
            )
            // Anthropic surfaces cost + api duration at the meta ROOT.
            if let cost = meta["total_cost_usd"]?.numberish { parsed.costUsd = cost }
            if let apiMs = meta["duration_api_ms"]?.numberish { parsed.durationApiMs = apiMs }

        case KnownAgentType.codex:
            // OpenAI reports input_tokens as the TOTAL prompt (cached +
            // fresh); normalize to the disjoint convention so
            // input + cacheRead sums uniformly across adapters.
            let totalIn = usage.pickNumber("input_tokens")
            let cached = usage.pickNumber("cached_input_tokens")
            parsed = TokenUsage(
                inputTokens: max(0, totalIn - cached),
                outputTokens: usage.pickNumber("output_tokens"),
                cacheReadTokens: cached,
                cacheWriteTokens: 0
            )

        case KnownAgentType.cursorCLI:
            parsed = TokenUsage(
                inputTokens: usage.pickNumber("inputTokens"),
                outputTokens: usage.pickNumber("outputTokens"),
                cacheReadTokens: usage.pickNumber("cacheReadTokens"),
                cacheWriteTokens: usage.pickNumber("cacheWriteTokens")
            )
            if let apiMs = meta["duration_api_ms"]?.numberish { parsed.durationApiMs = apiMs }

        default:
            // Unknown / custom adapter — probe both conventions.
            parsed = TokenUsage(
                inputTokens: usage.pickNumber("input_tokens", "inputTokens"),
                outputTokens: usage.pickNumber("output_tokens", "outputTokens"),
                cacheReadTokens: usage.pickNumber(
                    "cache_read_input_tokens", "cached_input_tokens", "cacheReadTokens"
                ),
                cacheWriteTokens: usage.pickNumber(
                    "cache_creation_input_tokens", "cacheWriteTokens"
                )
            )
        }

        return parsed.hasUsage ? parsed : nil
    }

    /// Live context size — the prompt the model saw on its most recent
    /// SINGLE API call. Differs from `parseUsage` for claude-code only:
    /// its `result` usage is a cumulative aggregate across every API
    /// round-trip in the turn (a 6-call turn overcounts ~6×); the
    /// per-call breakdown rides `usage.iterations`, whose LAST element is
    /// the real live context. Everything else falls through to
    /// `parseUsage`. Only the context ring should use this; totals keep
    /// using `parseUsage`.
    public static func parseContextUsage(
        adapterType: AgentType,
        meta: [String: JSONValue]?
    ) -> TokenUsage? {
        if adapterType == KnownAgentType.claudeCode,
           let iterations = meta?["usage"]?["iterations"]?.array,
           let last = iterations.last,
           case .object = last {
            let synthetic: [String: JSONValue] = ["usage": last]
            if let perCall = parseUsage(adapterType: KnownAgentType.claudeCode, meta: synthetic) {
                return perCall
            }
        }
        return parseUsage(adapterType: adapterType, meta: meta)
    }

    /// Best-effort model name from a chunk's `meta`. Deliberately not
    /// keyed by adapter — the model lives in different EVENTS per
    /// adapter, not different fields, so callers scan chunks for the
    /// first match. Probe order: top-level beats nested envelopes.
    public static func parseModel(meta: [String: JSONValue]?) -> String? {
        guard let meta else { return nil }
        let candidates: [JSONValue?] = [
            meta["model"],
            meta["message"]?["model"],
            meta["msg"]?["model"],
            meta["session"]?["model"],
            meta["msg"]?["session"]?["model"],
        ]
        for candidate in candidates {
            if let value = candidate?.string, !value.isEmpty { return value }
        }
        return nil
    }
}
