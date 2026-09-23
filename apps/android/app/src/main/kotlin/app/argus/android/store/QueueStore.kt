package app.argus.android.store

import android.content.SharedPreferences
import app.argus.core.engine.PromptQueueCodec
import app.argus.core.engine.QueuedPrompt
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

/**
 * Per-session FIFO of follow-up prompts, persisted so a backlog survives
 * relaunch (the web parks its queue in localStorage the same way).
 * Draining lives in AppModel — this is just ordered storage. Port of
 * apps/ios/Argus/Sources/QueueStore.swift.
 */
class QueueStore(private val prefs: SharedPreferences) {
    private val _items = MutableStateFlow(PromptQueueCodec.decode(prefs.getString(KEY, null)))
    val items: StateFlow<List<QueuedPrompt>> = _items.asStateFlow()

    fun items(sessionId: String): List<QueuedPrompt> = _items.value.filter { it.sessionId == sessionId }

    fun head(sessionId: String): QueuedPrompt? = _items.value.firstOrNull { it.sessionId == sessionId }

    fun enqueue(sessionId: String, text: String, attachmentIds: List<String> = emptyList()) {
        _items.value = _items.value + QueuedPrompt(
            id = UUID.randomUUID().toString(),
            sessionId = sessionId,
            text = text,
            attachmentIds = attachmentIds,
            createdAt = System.currentTimeMillis(),
        )
        save()
    }

    fun update(id: String, text: String) {
        _items.value = _items.value.map { if (it.id == id) it.copy(text = text) else it }
        save()
    }

    fun remove(id: String) {
        _items.value = _items.value.filter { it.id != id }
        save()
    }

    fun clear(sessionId: String) {
        _items.value = _items.value.filter { it.sessionId != sessionId }
        save()
    }

    private fun save() {
        prefs.edit().putString(KEY, PromptQueueCodec.encode(_items.value)).apply()
    }

    companion object {
        private const val KEY = "argus.queue.v1"
    }
}
