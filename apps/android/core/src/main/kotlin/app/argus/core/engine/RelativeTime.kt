package app.argus.core.engine

import app.argus.core.model.ISO8601

/**
 * Terse relative timestamps for dense rows — "now", "5m", "18h", "16d"
 * (web parity; always days past a day, no "ago"). Port of
 * `RelativeTime.short` in apps/ios/Argus/Sources/Views/Components.swift.
 * [now] is injected so the label is testable.
 */
object RelativeTime {
    fun short(iso: String, now: Long = System.currentTimeMillis()): String {
        val then = ISO8601.parseMillis(iso) ?: return ""
        val seconds = maxOf(0L, (now - then) / 1000)
        return when {
            seconds < 60 -> "now"
            seconds < 3_600 -> "${seconds / 60}m"
            seconds < 86_400 -> "${seconds / 3_600}h"
            else -> "${seconds / 86_400}d"
        }
    }
}
