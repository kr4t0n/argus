package app.argus.core.model

import app.argus.core.ArgusJson
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pins the exact bytes the request bodies put on the wire. The server is
 * Nest with class-validator DTOs, so an unexpected key shape is a 400 —
 * and the one body that needs an explicit JSON null must keep it.
 */
class RequestShapesTest {
    @Test
    fun `optional request fields are omitted when null, not sent as null`() {
        val body = ArgusJson.encodeToString(
            CreateSessionRequest(machineId = "m1", workingDir = "/w", cliType = "codex"),
        )
        assertEquals("""{"machineId":"m1","workingDir":"/w","cliType":"codex"}""", body)
    }

    @Test
    fun `a command request carries attachment ids and per-turn options`() {
        val body = ArgusJson.encodeToString(
            CreateCommandRequest(
                prompt = "hi",
                attachmentIds = listOf("a1"),
                options = buildJsonObject { put("model", "opus") },
            ),
        )
        assertEquals("""{"prompt":"hi","attachmentIds":["a1"],"options":{"model":"opus"}}""", body)
    }

    @Test
    fun `clearing the session model sends an explicit JSON null`() {
        // PATCH /sessions/:id/model distinguishes "absent" (no change)
        // from null (back to CLI default); ArgusJson drops null
        // properties, so the body is built as a JsonObject instead.
        assertEquals("""{"modelSelection":null}""", UpdateSessionModelRequest(null).toJson().toString())
        assertEquals(
            """{"modelSelection":{"model":"opus","effort":"high"}}""",
            UpdateSessionModelRequest(ModelSelection(model = "opus", effort = "high")).toJson().toString(),
        )
    }

    @Test
    fun `extension flags equal to their default are omitted, which the server reads as false`() {
        // `PUT /me/extensions` takes the full flag set with no server-side
        // merge, and coerceExtensions defaults absent keys to false — so
        // omitting a false flag is equivalent to sending it.
        assertEquals("""{"notes":true}""", ArgusJson.encodeToString(UserExtensions(notes = true, diff = false)))
        assertEquals("{}", ArgusJson.encodeToString(UserExtensions()))
    }
}
