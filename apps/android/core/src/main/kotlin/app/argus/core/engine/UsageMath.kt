package app.argus.core.engine

import app.argus.core.model.AgentType
import app.argus.core.model.KnownAgentType
import app.argus.core.model.TokenUsage
import app.argus.core.model.asArray
import app.argus.core.model.asObject
import app.argus.core.model.asString
import app.argus.core.model.get
import app.argus.core.model.numberish
import app.argus.core.model.pickNumber
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/UsageMath.swift, which
// mirrors packages/shared-types/src/usage.ts. `TokenUsage` itself lives in
// model/UserModels.kt (it doubles as the /me/usage wire shape, exactly
// like the web).

/**
 * The ONE place that knows each adapter's token-usage field names. Keep
 * behavior identical to the web so the badge never disagrees across
 * clients.
 */
object UsageParser {
    /**
     * Parse the raw `meta` of a `final`-kind chunk into normalized usage.
     * null when the meta has no recognizable usage payload (error chunk,
     * cancelled turn, old adapter).
     */
    fun parseUsage(adapterType: AgentType, meta: JsonObject?): TokenUsage? {
        if (meta == null) return null
        val usage = meta["usage"]?.asObject ?: return null

        val parsed: TokenUsage = when (adapterType) {
            KnownAgentType.CLAUDE_CODE -> TokenUsage(
                inputTokens = usage.pickNumber("input_tokens"),
                outputTokens = usage.pickNumber("output_tokens"),
                cacheReadTokens = usage.pickNumber("cache_read_input_tokens"),
                cacheWriteTokens = usage.pickNumber("cache_creation_input_tokens"),
                // Anthropic surfaces cost + api duration at the meta ROOT.
                costUsd = meta["total_cost_usd"]?.numberish,
                durationApiMs = meta["duration_api_ms"]?.numberish,
            )

            KnownAgentType.CODEX -> {
                // OpenAI reports input_tokens as the TOTAL prompt (cached +
                // fresh); normalize to the disjoint convention so
                // input + cacheRead sums uniformly across adapters.
                val totalIn = usage.pickNumber("input_tokens")
                val cached = usage.pickNumber("cached_input_tokens")
                TokenUsage(
                    inputTokens = maxOf(0.0, totalIn - cached),
                    outputTokens = usage.pickNumber("output_tokens"),
                    cacheReadTokens = cached,
                    cacheWriteTokens = 0.0,
                )
            }

            KnownAgentType.CURSOR_CLI -> TokenUsage(
                inputTokens = usage.pickNumber("inputTokens"),
                outputTokens = usage.pickNumber("outputTokens"),
                cacheReadTokens = usage.pickNumber("cacheReadTokens"),
                cacheWriteTokens = usage.pickNumber("cacheWriteTokens"),
                durationApiMs = meta["duration_api_ms"]?.numberish,
            )

            else -> TokenUsage(
                // Unknown / custom adapter — probe both conventions.
                inputTokens = usage.pickNumber("input_tokens", "inputTokens"),
                outputTokens = usage.pickNumber("output_tokens", "outputTokens"),
                cacheReadTokens = usage.pickNumber(
                    "cache_read_input_tokens", "cached_input_tokens", "cacheReadTokens",
                ),
                cacheWriteTokens = usage.pickNumber(
                    "cache_creation_input_tokens", "cacheWriteTokens",
                ),
            )
        }

        return if (parsed.hasUsage) parsed else null
    }

    /**
     * Live context size — the prompt the model saw on its most recent
     * SINGLE API call. Differs from [parseUsage] for claude-code and
     * app-server Codex:
     * its `result` usage is a cumulative aggregate across every API
     * round-trip in the turn (a 6-call turn overcounts ~6×); the
     * per-call breakdown rides `usage.iterations`, whose LAST element is
     * the real live context. Codex carries the equivalent value in
     * `lastUsage`. Everything else falls through to
     * [parseUsage]. Only the context ring should use this; totals keep
     * using [parseUsage].
     */
    fun parseContextUsage(adapterType: AgentType, meta: JsonObject?): TokenUsage? {
        if (adapterType == KnownAgentType.CLAUDE_CODE) {
            val iterations = meta?.get("usage")?.get("iterations")?.asArray
            val last: JsonElement? = iterations?.lastOrNull()
            if (last is JsonObject) {
                val synthetic = buildJsonObject { put("usage", last) }
                val perCall = parseUsage(KnownAgentType.CLAUDE_CODE, synthetic)
                if (perCall != null) return perCall
            }
        }
        if (adapterType == KnownAgentType.CODEX) {
            val lastUsage: JsonElement? = meta?.get("lastUsage")
            if (lastUsage is JsonObject) {
                val synthetic = buildJsonObject { put("usage", lastUsage) }
                val perCall = parseUsage(KnownAgentType.CODEX, synthetic)
                if (perCall != null) return perCall
            }
        }
        return parseUsage(adapterType, meta)
    }

    /**
     * Best-effort model name from a chunk's `meta`. Deliberately not
     * keyed by adapter — the model lives in different EVENTS per
     * adapter, not different fields, so callers scan chunks for the
     * first match. Probe order: top-level beats nested envelopes.
     */
    fun parseModel(meta: JsonObject?): String? {
        if (meta == null) return null
        val candidates: List<JsonElement?> = listOf(
            meta["model"],
            meta["message"]?.get("model"),
            meta["msg"]?.get("model"),
            meta["session"]?.get("model"),
            meta["msg"]?.get("session")?.get("model"),
        )
        for (candidate in candidates) {
            val value = candidate?.asString
            if (!value.isNullOrEmpty()) return value
        }
        return null
    }
}
