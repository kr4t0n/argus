package app.argus.core.engine

import app.argus.core.ArgusJson
import kotlinx.serialization.Serializable

/**
 * One parked follow-up prompt. Attachments are queued by their
 * already-uploaded server ids (like the web: object bytes live
 * server-side the moment they're picked, so queue entries survive
 * relaunch). Port of QueuedPrompt in apps/ios/Argus/Sources/QueueStore.swift.
 */
@Serializable
data class QueuedPrompt(
    val id: String,
    val sessionId: String,
    val text: String,
    val attachmentIds: List<String> = emptyList(),
    /** Unix millis. */
    val createdAt: Long,
)

/**
 * The persisted shape of the per-session FIFO — the app stores it as one
 * JSON string (the web parks its queue in localStorage the same way).
 * Decoding is tolerant: a corrupt or foreign blob yields an empty queue
 * rather than a crash on launch.
 */
object PromptQueueCodec {
    fun encode(items: List<QueuedPrompt>): String = ArgusJson.encodeToString(items)

    fun decode(json: String?): List<QueuedPrompt> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching { ArgusJson.decodeFromString<List<QueuedPrompt>>(json) }.getOrDefault(emptyList())
    }
}
