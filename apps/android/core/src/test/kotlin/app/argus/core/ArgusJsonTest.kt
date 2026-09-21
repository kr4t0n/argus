package app.argus.core

import kotlinx.serialization.Serializable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

@Serializable
internal enum class ProbeStatus { IDLE, ACTIVE, UNKNOWN }

@Serializable
internal data class Probe(
    val id: String,
    val status: ProbeStatus = ProbeStatus.UNKNOWN,
    val title: String? = null,
)

/**
 * Pins the decode-tolerance posture of [ArgusJson]. These are the two
 * properties every wire model relies on; if either test starts failing,
 * the Json configuration was tightened and the fixtures will follow.
 */
class ArgusJsonTest {
    @Test
    fun `unknown fields are ignored, not a decode failure`() {
        val probe = ArgusJson.decodeFromString(
            Probe.serializer(),
            """{"id":"s1","status":"IDLE","agentId":"stale","usage":{"x":1}}""",
        )
        assertEquals(Probe(id = "s1", status = ProbeStatus.IDLE), probe)
    }

    @Test
    fun `unknown enum values coerce to the default member`() {
        val probe = ArgusJson.decodeFromString(
            Probe.serializer(),
            """{"id":"s2","status":"compacting"}""",
        )
        assertEquals(ProbeStatus.UNKNOWN, probe.status)
    }

    @Test
    fun `absent nullable fields decode as null, and neither nulls nor defaults are encoded`() {
        val probe = ArgusJson.decodeFromString(Probe.serializer(), """{"id":"s3"}""")
        assertNull(probe.title)
        // explicitNulls=false drops `title`; the library default
        // encodeDefaults=false drops `status` because it equals its default.
        assertEquals("""{"id":"s3"}""", ArgusJson.encodeToString(Probe.serializer(), probe))
    }
}
