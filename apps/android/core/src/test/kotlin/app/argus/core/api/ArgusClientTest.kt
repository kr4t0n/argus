package app.argus.core.api

import app.argus.core.model.CreateCommandRequest
import app.argus.core.model.ModelSelection
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.GzipSink
import okio.buffer
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Request shapes and response handling against a local mock server: the
 * things a fixture can't prove (headers, methods, bodies, error mapping,
 * transparent gzip).
 */
class ArgusClientTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client(token: String? = "tok"): ArgusClient =
        ArgusClient(server.url("/").toString(), { token })

    private fun json(body: String, code: Int = 200): MockResponse =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private val session = """
        {"id":"s1","userId":"u1","title":"t","status":"idle","unread":false,
         "createdAt":"2026-07-05T10:00:00.000Z","updatedAt":"2026-07-05T10:00:00.000Z"}
    """.trimIndent()

    @Test
    fun `login posts JSON without a bearer and decodes the envelope`() = runBlocking {
        server.enqueue(json("""{"token":"jwt","user":{"id":"u1","email":"a@b","role":"admin"}}"""))

        val response = client(token = null).login("a@b", "pw")
        assertEquals("jwt", response.token)
        assertEquals("admin", response.user.role)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/auth/login", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        assertNull(request.getHeader("Authorization"))
        assertEquals("""{"email":"a@b","password":"pw"}""", request.body.readUtf8())
    }

    @Test
    fun `GETs carry the bearer token and boolean flags as query params`() = runBlocking {
        server.enqueue(json("[]"))
        client().listSessions(includeArchived = true)

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/sessions?includeArchived=true", request.path)
        assertEquals("Bearer tok", request.getHeader("Authorization"))
    }

    @Test
    fun `a base URL with a path prefix is concatenated, not resolved`() = runBlocking {
        server.enqueue(json("[]"))
        ArgusClient(server.url("/argus/").toString(), { null }).listProjects()
        assertEquals("/argus/projects", server.takeRequest().path)
    }

    @Test
    fun `gzipped responses are inflated transparently`() = runBlocking {
        val payload = Buffer()
        GzipSink(payload).buffer().use {
            it.writeUtf8("""{"user":{"id":"u1","email":"a@b","role":"admin"}}""")
        }
        server.enqueue(
            MockResponse().setResponseCode(200).setHeader("Content-Encoding", "gzip").setBody(payload),
        )

        val user = client().me()
        assertEquals("u1", user.id)
        assertEquals("gzip", server.takeRequest().getHeader("Accept-Encoding"))
    }

    @Test
    fun `a Nest error body becomes an ApiError with the server's message`() = runBlocking {
        server.enqueue(json("""{"statusCode":404,"message":"Session not found","error":"Not Found"}""", code = 404))
        val error = assertFailsWith<ApiError> { client().getSession("nope") }
        assertEquals(404, error.status)
        assertEquals("Session not found", error.message)
    }

    @Test
    fun `body-less POSTs still go out (OkHttp would otherwise refuse them)`() = runBlocking {
        server.enqueue(json(session))
        client().archiveSession("s1")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/sessions/s1/archive", request.path)
        assertEquals(0L, request.bodySize)
    }

    @Test
    fun `clearing the session model sends an explicit null`() = runBlocking {
        server.enqueue(json(session))
        client().setSessionModel("s1", null)

        val request = server.takeRequest()
        assertEquals("PATCH", request.method)
        assertEquals("/sessions/s1/model", request.path)
        assertEquals("""{"modelSelection":null}""", request.body.readUtf8())
    }

    @Test
    fun `setting the session model sends the selection`() = runBlocking {
        server.enqueue(json(session))
        client().setSessionModel("s1", ModelSelection(model = "opus"))
        assertEquals("""{"modelSelection":{"model":"opus"}}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `fork posts the anchor turn and omits an absent title`() = runBlocking {
        server.enqueue(json(session))
        client().forkSession("s1", commandId = "c9")

        val request = server.takeRequest()
        assertEquals("/sessions/s1/fork", request.path)
        assertEquals("""{"commandId":"c9"}""", request.body.readUtf8())
    }

    @Test
    fun `fork uses a read timeout above the server's 15 s clone hold`() {
        assertTrue(ArgusClient.FORK_READ_TIMEOUT_SECONDS > 15)
    }

    @Test
    fun `send command carries per-turn options`() = runBlocking {
        server.enqueue(
            json(
                """{"id":"c1","sessionId":"s1","kind":"execute","prompt":"hi","status":"pending",
                    "createdAt":"2026-07-05T10:00:00.000Z"}""",
            ),
        )
        val command = client().sendCommand("s1", CreateCommandRequest(prompt = "hi", attachmentIds = listOf("a1")))
        assertEquals("c1", command.id)

        val request = server.takeRequest()
        assertEquals("/sessions/s1/commands", request.path)
        assertEquals("""{"prompt":"hi","attachmentIds":["a1"]}""", request.body.readUtf8())
    }

    @Test
    fun `attachments upload as multipart under the file field`() = runBlocking {
        server.enqueue(
            json(
                """{"id":"att1","filename":"a.png","mime":"image/png","size":3,
                    "url":"/attachments/att1?t=T","createdAt":"2026-07-05T10:00:00.000Z"}""",
            ),
        )
        val attachment = client().uploadAttachment("a.png", "image/png", byteArrayOf(1, 2, 3))
        assertEquals("att1", attachment.id)

        val request = server.takeRequest()
        assertEquals("/attachments", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data; boundary="))
        val body = request.body.readUtf8()
        assertTrue(body.contains("""name="file"; filename="a.png""""))
        assertTrue(body.contains("Content-Type: image/png"))
    }

    @Test
    fun `absoluteUrl joins API-relative paths onto the base`() {
        val base = server.url("/").toString().trimEnd('/')
        assertEquals("$base/attachments/x?t=y", client().absoluteUrl("/attachments/x?t=y"))
    }
}
