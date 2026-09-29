package app.argus.core.engine

import app.argus.core.metaOf
import app.argus.core.model.ResultKind
import app.argus.core.testChunk
import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/FileReferencesTests.swift.
// The Swift suite's final case (`Turn.touchedFiles populates from tool
// chunks`) exercises TranscriptState, which is not part of this port;
// it belongs with the TranscriptEngine tests.

/** FileReferences — port of apps/web/src/components/FileChips.tsx helpers. */
class FileReferencesTest {
    @Test
    fun `extractFiles dedupes in first-seen order, probes all input keys`() {
        val chunks = listOf(
            testChunk(
                id = "t1", seq = 1, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"Edit","input":{"file_path":"/w/a.swift"}}"""),
            ),
            testChunk(
                id = "t2", seq = 2, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"Read","input":{"path":"/w/b.md"}}"""),
            ),
            // Duplicate of a.swift — dropped.
            testChunk(
                id = "t3", seq = 3, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"Write","input":{"file_path":"/w/a.swift"}}"""),
            ),
            // Array-valued keys count too.
            testChunk(
                id = "t4", seq = 4, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"MultiEdit","input":{"files":["/w/c.ts","/w/d.ts"]}}"""),
            ),
        )
        assertEquals(
            listOf("/w/a.swift", "/w/b.md", "/w/c.ts", "/w/d.ts"),
            FileReferences.extractFiles(chunks),
        )
    }

    @Test
    fun `extractFiles skips dir and command tools`() {
        val chunks = listOf(
            testChunk(
                id = "t1", seq = 1, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"Bash","input":{"path":"/w/dir"}}"""),
            ),
            testChunk(
                id = "t2", seq = 2, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"Glob","input":{"path":"/w/src"}}"""),
            ),
            testChunk(
                id = "t3", seq = 3, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"grep","input":{"path":"/w"}}"""),
            ),
        )
        assertTrue(FileReferences.extractFiles(chunks).isEmpty())
    }

    @Test
    fun `displayPath strips workingDir boundary-safely`() {
        assertEquals("src/a.ts", FileReferences.displayPath("/work/proj/src/a.ts", "/work/proj"))
        // /work/projx must NOT match /work/proj.
        assertEquals("/work/projx/a.ts", FileReferences.displayPath("/work/projx/a.ts", "/work/proj"))
        assertEquals(".", FileReferences.displayPath("/work/proj", "/work/proj"))
        assertEquals("rel/a.ts", FileReferences.displayPath("rel/a.ts", "/work/proj"))
        assertEquals("/etc/hosts", FileReferences.displayPath("/etc/hosts", null))
        // Trailing slash on workingDir is tolerated.
        assertEquals("a.ts", FileReferences.displayPath("/w/p/a.ts", "/w/p/"))
    }

    @Test
    fun `splitLineSuffix splits path-line and path-line-col, schemes do not`() {
        val a = FileReferences.splitLineSuffix("src/foo.go:123")
        assertEquals("src/foo.go", a.path)
        assertEquals(123, a.line)
        // Lazy split: line 123, column 45 dropped.
        val b = FileReferences.splitLineSuffix("src/foo.go:123:45")
        assertEquals("src/foo.go", b.path)
        assertEquals(123, b.line)
        // Bare word before the colon = URI-scheme shaped, no split.
        val c = FileReferences.splitLineSuffix("tel:123")
        assertEquals("tel:123", c.path)
        assertNull(c.line)
        // The accepted miss: dot-less, slash-less names don't split.
        val d = FileReferences.splitLineSuffix("Makefile:12")
        assertEquals("Makefile:12", d.path)
        assertNull(d.line)
        val e = FileReferences.splitLineSuffix("plain/path.swift")
        assertEquals("plain/path.swift", e.path)
        assertNull(e.line)
    }

    @Test
    fun `toAgentRelative treats outside-workspace and directory shapes as unopenable`() {
        assertEquals("a.ts", FileReferences.toAgentRelative("/w/p/a.ts", "/w/p"))
        assertEquals("rel/a.ts", FileReferences.toAgentRelative("rel/a.ts", "/w/p"))
        assertNull(FileReferences.toAgentRelative("/etc/hosts", "/w/p"))
        assertNull(FileReferences.toAgentRelative("/w/p", "/w/p"))
        assertNull(FileReferences.toAgentRelative("rel/dir/", "/w/p"))
    }

    @Test
    fun `imageSource fetches workspace paths, keeps http and https remote, everything else is inert`() {
        // Relative and absolute-inside-workspace both resolve to the
        // fs/read form (the web's `toAgentRelative` + `displayPath` pair).
        assertEquals(
            MarkdownImageSource.Workspace("assets/icon.png"),
            FileReferences.imageSource("assets/icon.png", "/w/p"),
        )
        assertEquals(
            MarkdownImageSource.Workspace("assets/icon.png"),
            FileReferences.imageSource("/w/p/assets/icon.png", "/w/p"),
        )
        // The canonical miss — an agent writing a screenshot to /tmp.
        assertEquals(MarkdownImageSource.Inert, FileReferences.imageSource("/tmp/shot.png", "/w/p"))
        // Prefix-boundary rule holds here too: /w/px is not inside /w/p.
        assertEquals(MarkdownImageSource.Inert, FileReferences.imageSource("/w/px/shot.png", "/w/p"))
        // No workingDir at all → nothing absolute can be fetched.
        assertEquals(
            MarkdownImageSource.Workspace("assets/icon.png"),
            FileReferences.imageSource("assets/icon.png", null),
        )
        assertEquals(MarkdownImageSource.Inert, FileReferences.imageSource("/w/p/assets/icon.png", null))
        // Directory-shaped and empty sources are inert, never fetched.
        assertEquals(MarkdownImageSource.Inert, FileReferences.imageSource("assets/", "/w/p"))
        assertEquals(MarkdownImageSource.Inert, FileReferences.imageSource("", "/w/p"))

        // Real URLs are left to the system — only http(s).
        val remote = URI("https://example.com/a.png")
        assertEquals(
            MarkdownImageSource.Remote(remote),
            FileReferences.imageSource("https://example.com/a.png", "/w/p"),
        )
        val upper = FileReferences.imageSource("HTTP://example.com/a.png", "/w/p")
        assertNotEquals(MarkdownImageSource.Inert, upper)
        assertTrue(upper is MarkdownImageSource.Remote)
        // Non-http schemes never load (the web's urlTransform blanks them).
        assertEquals(
            MarkdownImageSource.Inert,
            FileReferences.imageSource("data:image/png;base64,AAAA", "/w/p"),
        )
        assertEquals(
            MarkdownImageSource.Inert,
            FileReferences.imageSource("file:///w/p/assets/icon.png", "/w/p"),
        )
        // `xxx.png:1` parses as scheme "xxx.png" on both clients → inert,
        // not a workspace path. Same shape as the path:line link gotcha.
        assertEquals(MarkdownImageSource.Inert, FileReferences.imageSource("shot.png:1", "/w/p"))
    }
}
