package app.argus.core.engine

import kotlin.test.Test
import kotlin.test.assertEquals

class RelativeTimeTest {
    private val now = 1_783_245_600_000L // 2026-07-05T10:00:00Z

    @Test
    fun `buckets match the web's short labels`() {
        assertEquals("now", RelativeTime.short("2026-07-05T09:59:30Z", now))
        assertEquals("5m", RelativeTime.short("2026-07-05T09:55:00Z", now))
        assertEquals("18h", RelativeTime.short("2026-07-04T16:00:00Z", now))
        assertEquals("16d", RelativeTime.short("2026-06-19T10:00:00Z", now))
    }

    @Test
    fun `future or unparseable timestamps degrade quietly`() {
        assertEquals("now", RelativeTime.short("2026-07-05T10:30:00Z", now))
        assertEquals("", RelativeTime.short("yesterday", now))
    }
}
