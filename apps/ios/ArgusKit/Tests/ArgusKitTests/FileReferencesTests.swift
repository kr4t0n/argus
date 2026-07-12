import Testing
@testable import ArgusKit

@Suite("FileReferences — port of apps/web/src/components/FileChips.tsx helpers")
struct FileReferencesTests {
    @Test("extractFiles: dedupes in first-seen order, probes all input keys")
    func extraction() {
        let chunks = [
            TestSupport.chunk(
                id: "t1", seq: 1, kind: .tool,
                meta: ["tool": .string("Edit"), "input": .object(["file_path": .string("/w/a.swift")])]
            ),
            TestSupport.chunk(
                id: "t2", seq: 2, kind: .tool,
                meta: ["tool": .string("Read"), "input": .object(["path": .string("/w/b.md")])]
            ),
            // Duplicate of a.swift — dropped.
            TestSupport.chunk(
                id: "t3", seq: 3, kind: .tool,
                meta: ["tool": .string("Write"), "input": .object(["file_path": .string("/w/a.swift")])]
            ),
            // Array-valued keys count too.
            TestSupport.chunk(
                id: "t4", seq: 4, kind: .tool,
                meta: ["tool": .string("MultiEdit"), "input": .object([
                    "files": .array([.string("/w/c.ts"), .string("/w/d.ts")])
                ])]
            ),
        ]
        #expect(FileReferences.extractFiles(chunks) == ["/w/a.swift", "/w/b.md", "/w/c.ts", "/w/d.ts"])
    }

    @Test("extractFiles: dir/command tools are skipped")
    func skipList() {
        let chunks = [
            TestSupport.chunk(
                id: "t1", seq: 1, kind: .tool,
                meta: ["tool": .string("Bash"), "input": .object(["path": .string("/w/dir")])]
            ),
            TestSupport.chunk(
                id: "t2", seq: 2, kind: .tool,
                meta: ["tool": .string("Glob"), "input": .object(["path": .string("/w/src")])]
            ),
            TestSupport.chunk(
                id: "t3", seq: 3, kind: .tool,
                meta: ["tool": .string("grep"), "input": .object(["path": .string("/w")])]
            ),
        ]
        #expect(FileReferences.extractFiles(chunks).isEmpty)
    }

    @Test("displayPath: boundary-safe workingDir stripping")
    func displayPaths() {
        #expect(FileReferences.displayPath("/work/proj/src/a.ts", workingDir: "/work/proj") == "src/a.ts")
        // /work/projx must NOT match /work/proj.
        #expect(FileReferences.displayPath("/work/projx/a.ts", workingDir: "/work/proj") == "/work/projx/a.ts")
        #expect(FileReferences.displayPath("/work/proj", workingDir: "/work/proj") == ".")
        #expect(FileReferences.displayPath("rel/a.ts", workingDir: "/work/proj") == "rel/a.ts")
        #expect(FileReferences.displayPath("/etc/hosts", workingDir: nil) == "/etc/hosts")
        // Trailing slash on workingDir is tolerated.
        #expect(FileReferences.displayPath("/w/p/a.ts", workingDir: "/w/p/") == "a.ts")
    }

    @Test("splitLineSuffix: path:line and path:line:col split; schemes don't")
    func lineSuffixes() {
        let a = FileReferences.splitLineSuffix("src/foo.go:123")
        #expect(a.path == "src/foo.go" && a.line == 123)
        // Lazy split: line 123, column 45 dropped.
        let b = FileReferences.splitLineSuffix("src/foo.go:123:45")
        #expect(b.path == "src/foo.go" && b.line == 123)
        // Bare word before the colon = URI-scheme shaped, no split.
        let c = FileReferences.splitLineSuffix("tel:123")
        #expect(c.path == "tel:123" && c.line == nil)
        // The accepted miss: dot-less, slash-less names don't split.
        let d = FileReferences.splitLineSuffix("Makefile:12")
        #expect(d.path == "Makefile:12" && d.line == nil)
        let e = FileReferences.splitLineSuffix("plain/path.swift")
        #expect(e.path == "plain/path.swift" && e.line == nil)
    }

    @Test("toAgentRelative: outside-workspace and directory shapes are unopenable")
    func agentRelative() {
        #expect(FileReferences.toAgentRelative("/w/p/a.ts", workingDir: "/w/p") == "a.ts")
        #expect(FileReferences.toAgentRelative("rel/a.ts", workingDir: "/w/p") == "rel/a.ts")
        #expect(FileReferences.toAgentRelative("/etc/hosts", workingDir: "/w/p") == nil)
        #expect(FileReferences.toAgentRelative("/w/p", workingDir: "/w/p") == nil)
        #expect(FileReferences.toAgentRelative("rel/dir/", workingDir: "/w/p") == nil)
    }

    @Test("Turn.touchedFiles populates from tool chunks")
    func turnIntegration() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "t1", seq: 1, kind: .tool, content: "Edited a.swift",
                meta: ["tool": .string("Edit"), "input": .object(["file_path": .string("/w/a.swift")])]
            ),
            TestSupport.chunk(id: "f1", seq: 2, kind: .final, content: "done", isFinal: true),
        ])
        let turn = try #require(state.turns(agentType: KnownAgentType.claudeCode).first)
        #expect(turn.touchedFiles == ["/w/a.swift"])
    }
}
