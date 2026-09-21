package app.argus.core.model

import kotlinx.serialization.Serializable

// Mirrors packages/shared-types/src/usage.ts (TokenUsage) and api.ts
// (/me/* views). TokenUsage doubles as the wire shape of /me/usage AND
// the output of the client-side usage parser (engine/UsageMath) — one
// class, exactly like the web.

/**
 * Normalized per-event token tally. The four counts default to 0 so
 * callers can sum without null-guarding; [costUsd] / [durationApiMs]
 * stay optional because not every adapter emits them (and the badge
 * hides the cost line when absent).
 */
@Serializable
data class TokenUsage(
    val inputTokens: Double = 0.0,
    val outputTokens: Double = 0.0,
    /** Read from a previously-cached prompt. */
    val cacheReadTokens: Double = 0.0,
    /** Written into a NEW cache entry (Anthropic-only concept). */
    val cacheWriteTokens: Double = 0.0,
    /** USD as reported by the adapter (claude-code only today). */
    val costUsd: Double? = null,
    /** Milliseconds waiting on the upstream API this turn. */
    val durationApiMs: Double? = null,
) {
    /** True iff any field carries a meaningful value — gates badge display. */
    val hasUsage: Boolean
        get() = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 ||
            cacheWriteTokens > 0 || (costUsd ?: 0.0) > 0

    /** Pointwise sum; optional fields stay unset when unset on both sides. */
    operator fun plus(other: TokenUsage): TokenUsage = TokenUsage(
        inputTokens = inputTokens + other.inputTokens,
        outputTokens = outputTokens + other.outputTokens,
        cacheReadTokens = cacheReadTokens + other.cacheReadTokens,
        cacheWriteTokens = cacheWriteTokens + other.cacheWriteTokens,
        costUsd = if (costUsd != null || other.costUsd != null) {
            (costUsd ?: 0.0) + (other.costUsd ?: 0.0)
        } else {
            null
        },
        durationApiMs = if (durationApiMs != null || other.durationApiMs != null) {
            (durationApiMs ?: 0.0) + (other.durationApiMs ?: 0.0)
        } else {
            null
        },
    )

    companion object {
        val ZERO = TokenUsage()
    }
}

/**
 * `GET /me/usage` — rolling windows over the same per-adapter parse the
 * per-session badge uses; the toggle is pure client-side slicing.
 */
@Serializable
data class WindowedUsage(
    val last7Days: TokenUsage = TokenUsage.ZERO,
    val last30Days: TokenUsage = TokenUsage.ZERO,
    val lifetime: TokenUsage = TokenUsage.ZERO,
)

@Serializable
data class UserUsageResponse(val usage: WindowedUsage)

/** One bucket in the activity heatmap — [date] is `YYYY-MM-DD` (UTC). */
@Serializable
data class ActivityDay(
    val date: String,
    val count: Int,
)

@Serializable
data class UserActivityResponse(val days: List<ActivityDay>)

@Serializable
data class QuotaWindow(
    /** Stable key: "five_hour" | "seven_day" | "weekly" | … */
    val key: String,
    /** Short human label, e.g. "5-hour". */
    val label: String = "",
    /** 0–100 percent consumed. */
    val utilizationPercent: Double = 0.0,
    /** ISO timestamp the window resets at, when known. */
    val resetsAt: String? = null,
)

@Serializable
data class UserQuotaRow(
    val type: AgentType,
    /** 'claude-code-oauth' | 'codex-chatgpt' | … (open string). */
    val source: String = "",
    val windows: List<QuotaWindow> = emptyList(),
    /**
     * Set (with empty [windows]) when the probe ran but the vendor
     * endpoint refused — render an "unknown" row, don't hide it.
     */
    val error: String? = null,
    val checkedAt: String = "",
    val machineId: String = "",
    val machineName: String = "",
)

@Serializable
data class UserQuotaResponse(val quotas: List<UserQuotaRow>)

/**
 * `GET`/`PUT /me/extensions` — account-level opt-in feature flags. The
 * PUT sends the full set (no server-side merge).
 */
@Serializable
data class UserExtensions(
    val notes: Boolean = false,
    val diff: Boolean = false,
)

/**
 * One registered push device (`POST /me/devices`). Registration is
 * idempotent: re-posting a token refreshes it, and a token that moved
 * accounts is re-homed (a device has exactly one owner).
 */
@Serializable
data class DeviceDTO(
    val id: String,
    val token: String,
    val platform: String,
    val createdAt: String = "",
)

/** `GET`/`PUT /me/project-notes` envelope. */
@Serializable
data class ProjectNotesResponse(val notes: String)
