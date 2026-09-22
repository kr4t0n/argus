package app.argus.core.model

import app.argus.core.ArgusJson
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * `GET /me/push/config` mirror — inline JSON in the exact shape of
 * shared-types' `PushConfigDTO`. No captured fixture: the capture script
 * runs against servers without FCM configured, where the endpoint 404s.
 * Android-only DTO (no Swift mirror), so this test is its only pin.
 */
class PushModelsTest {
    @Test
    fun decodesConfig() {
        val json = """
            {
              "projectId": "argus-demo",
              "applicationId": "1:123456789012:android:0123456789abcdef",
              "apiKey": "AIzaSyExample",
              "senderId": "123456789012",
              "unknownFutureField": true
            }
        """.trimIndent()
        val config = ArgusJson.decodeFromString<PushConfigDTO>(json)
        assertEquals("argus-demo", config.projectId)
        assertEquals("1:123456789012:android:0123456789abcdef", config.applicationId)
        assertEquals("AIzaSyExample", config.apiKey)
        assertEquals("123456789012", config.senderId)
    }

    /** The registration body the server validates per platform. */
    @Test
    fun deviceRoundTrip() {
        val json = """{"id":"d1","token":"abc:DEF_ghi-123","platform":"android","createdAt":"2026-09-22T00:00:00.000Z"}"""
        val device = ArgusJson.decodeFromString<DeviceDTO>(json)
        assertEquals("android", device.platform)
        assertEquals("abc:DEF_ghi-123", device.token)
    }
}
