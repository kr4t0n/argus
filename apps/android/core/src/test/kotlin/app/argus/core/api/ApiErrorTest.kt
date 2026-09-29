package app.argus.core.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ApiErrorTest {
    @Test
    fun `a Nest string message is surfaced verbatim`() {
        val error = ApiError.from(404, """{"statusCode":404,"message":"Session not found","error":"Not Found"}""")
        assertEquals(404, error.status)
        assertEquals("Session not found", error.message)
        assertFalse(error.isUnauthorized)
    }

    @Test
    fun `a validation array is joined`() {
        val error = ApiError.from(
            400,
            """{"statusCode":400,"message":["title must be a string","prompt should not be empty"],"error":"Bad Request"}""",
        )
        assertEquals("title must be a string; prompt should not be empty", error.message)
    }

    @Test
    fun `an empty or non-JSON body falls back to the status line`() {
        assertEquals("HTTP 502", ApiError.from(502, "<html>bad gateway</html>").message)
        assertEquals("HTTP 500", ApiError.from(500, "").message)
        assertEquals("HTTP 500", ApiError.from(500, null).message)
        assertEquals("HTTP 401", ApiError.from(401, """{"statusCode":401}""").message)
    }

    @Test
    fun `401 is the session-expired signal`() {
        assertTrue(ApiError.from(401, null).isUnauthorized)
    }
}
