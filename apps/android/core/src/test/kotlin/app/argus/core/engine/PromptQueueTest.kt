package app.argus.core.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PromptQueueTest {
    @Test
    fun `the queue round-trips through its persisted JSON`() {
        val items = listOf(
            QueuedPrompt(id = "q1", sessionId = "s1", text = "first", createdAt = 1L),
            QueuedPrompt(id = "q2", sessionId = "s1", text = "with files", attachmentIds = listOf("a1"), createdAt = 2L),
        )
        assertEquals(items, PromptQueueCodec.decode(PromptQueueCodec.encode(items)))
    }

    @Test
    fun `a missing or corrupt blob decodes as an empty queue`() {
        assertTrue(PromptQueueCodec.decode(null).isEmpty())
        assertTrue(PromptQueueCodec.decode("").isEmpty())
        assertTrue(PromptQueueCodec.decode("{not json").isEmpty())
        assertTrue(PromptQueueCodec.decode("""[{"id":"x"}]""").isEmpty())
    }
}
