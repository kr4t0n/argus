package app.argus.core.engine

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/ToolDisplayTests.swift.

/** ToolDisplay — port of web ToolPill.describe(). */
class ToolDisplayTest {
    private fun input(vararg pairs: Pair<String, String>): JsonObject =
        JsonObject(pairs.associate { (key, value) -> key to JsonPrimitive(value) })

    @Test
    fun `file verbs, mono argument`() {
        val read = ToolDisplay.make(name = "Read", input = input("file_path" to "src/app.swift"))
        assertEquals("Read", read.verb)
        assertEquals("src/app.swift", read.argument)
        assertTrue(read.mono)

        assertEquals("Wrote", ToolDisplay.make(name = "write", input = input("path" to "a.txt")).verb)
        assertEquals("Edited", ToolDisplay.make(name = "MultiEdit", input = input("filePath" to "b")).verb)
        assertEquals("Deleted", ToolDisplay.make(name = "rm", input = input("file_path" to "c")).verb)
        assertEquals("Renamed", ToolDisplay.make(name = "mv", input = input("file_path" to "d")).verb)
    }

    @Test
    fun `search verbs are non-mono, prose-style`() {
        val grep = ToolDisplay.make(name = "grep", input = input("pattern" to "TODO"))
        assertEquals("Searched codebase for", grep.verb)
        assertEquals("TODO", grep.argument)
        assertFalse(grep.mono)

        val web = ToolDisplay.make(name = "WebSearch", input = input("query" to "swiftui"))
        assertEquals("Searched web for", web.verb)
        assertEquals("swiftui", web.argument)
    }

    @Test
    fun `bash and fetch`() {
        val bash = ToolDisplay.make(name = "Bash", input = input("command" to "ls -la"))
        assertEquals("Ran", bash.verb)
        assertEquals("ls -la", bash.argument)
        assertTrue(bash.mono)
        assertEquals("Fetched", ToolDisplay.make(name = "webfetch", input = input("url" to "https://x")).verb)
    }

    @Test
    fun `task family`() {
        assertEquals("Updated todos", ToolDisplay.make(name = "TodoWrite", input = null).verb)
        val update = ToolDisplay.make(
            name = "TaskUpdate",
            input = input("taskId" to "7", "status" to "completed"),
        )
        assertEquals("Updated task", update.verb)
        assertEquals("#7 → completed", update.argument)
    }

    @Test
    fun `unknown tool falls back to its name + best-effort arg`() {
        val custom = ToolDisplay.make(name = "MyTool", input = input("thing" to "value"))
        assertEquals("MyTool", custom.verb)
        assertEquals("value", custom.argument)

        // A verb branch only fires when its field exists — read with no
        // file path falls through to the default row.
        val readNoFile = ToolDisplay.make(name = "read", input = input("other" to "x"))
        assertEquals("read", readNoFile.verb)

        val empty = ToolDisplay.make(name = null, input = null)
        assertEquals("Called tool", empty.verb)
        assertNull(empty.argument)
    }
}
