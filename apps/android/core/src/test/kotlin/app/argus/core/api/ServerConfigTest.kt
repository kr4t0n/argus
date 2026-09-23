package app.argus.core.api

import app.argus.core.model.ISO8601
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** ServerConfig — user-input URL parsing (port of ServerConfigTests.swift). */
class ServerConfigTest {
    private fun parsed(raw: String): ServerConfig = assertNotNull(ServerConfig.parse(raw), "expected $raw to parse")

    @Test
    fun `explicit schemes are respected`() {
        assertEquals("http://localhost:4000", parsed("http://localhost:4000").baseUrl)
        assertEquals("https://argus.example.com", parsed("https://argus.example.com").baseUrl)
    }

    @Test
    fun `private hosts default to http, public hosts to https`() {
        assertTrue(parsed("localhost:4000").baseUrl.startsWith("http://"))
        assertTrue(parsed("192.168.1.20:4000").baseUrl.startsWith("http://"))
        assertTrue(parsed("10.0.0.5:4000").baseUrl.startsWith("http://"))
        assertTrue(parsed("172.20.1.2:4000").baseUrl.startsWith("http://"))
        assertTrue(parsed("kyle-mbp.local:4000").baseUrl.startsWith("http://"))
        assertTrue(parsed("[::1]:4000").baseUrl.startsWith("http://"))
        assertTrue(parsed("argus.example.com:4000").baseUrl.startsWith("https://"))
        // 172.x outside the /12 private block is public.
        assertTrue(parsed("172.10.1.2").baseUrl.startsWith("https://"))
    }

    @Test
    fun `trailing slashes are stripped, ports survive`() {
        val config = parsed("https://argus.example.com:4000/")
        assertEquals("https://argus.example.com:4000", config.baseUrl)
        assertEquals("argus.example.com:4000", config.displayName)
    }

    @Test
    fun `a path prefix survives, a query does not`() {
        assertEquals("https://x.example.com/argus", parsed("https://x.example.com/argus/").baseUrl)
        assertEquals("https://x.example.com", parsed("https://x.example.com/?next=1#f").baseUrl)
    }

    @Test
    fun `garbage is rejected`() {
        assertNull(ServerConfig.parse(""))
        assertNull(ServerConfig.parse("   "))
        assertNull(ServerConfig.parse("ftp://argus.example.com"))
    }

    @Test
    fun `ISO8601 parses both fractional and whole-second forms`() {
        assertEquals(1_783_245_600_123L, ISO8601.parseMillis("2026-07-05T10:00:00.123Z"))
        assertEquals(1_783_245_600_000L, ISO8601.parseMillis("2026-07-05T10:00:00Z"))
        assertEquals(1_783_238_400_000L, ISO8601.parseMillis("2026-07-05T10:00:00+02:00"))
        assertNull(ISO8601.parseMillis("not a date"))
    }
}
