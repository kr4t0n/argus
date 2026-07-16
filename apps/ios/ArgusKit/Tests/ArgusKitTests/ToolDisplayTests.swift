import Testing
@testable import ArgusKit

@Suite("ToolDisplay — port of web ToolPill.describe()")
struct ToolDisplayTests {
    private func input(_ pairs: [String: String]) -> [String: JSONValue] {
        pairs.mapValues { .string($0) }
    }

    @Test("file verbs, mono argument")
    func fileVerbs() {
        let read = ToolDisplay.make(name: "Read", input: input(["file_path": "src/app.swift"]))
        #expect(read.verb == "Read")
        #expect(read.argument == "src/app.swift")
        #expect(read.mono)

        #expect(ToolDisplay.make(name: "write", input: input(["path": "a.txt"])).verb == "Wrote")
        #expect(ToolDisplay.make(name: "MultiEdit", input: input(["filePath": "b"])).verb == "Edited")
        #expect(ToolDisplay.make(name: "rm", input: input(["file_path": "c"])).verb == "Deleted")
        #expect(ToolDisplay.make(name: "mv", input: input(["file_path": "d"])).verb == "Renamed")
    }

    @Test("search verbs are non-mono, prose-style")
    func searchVerbs() {
        let grep = ToolDisplay.make(name: "grep", input: input(["pattern": "TODO"]))
        #expect(grep.verb == "Searched codebase for")
        #expect(grep.argument == "TODO")
        #expect(!grep.mono)

        let web = ToolDisplay.make(name: "WebSearch", input: input(["query": "swiftui"]))
        #expect(web.verb == "Searched web for")
        #expect(web.argument == "swiftui")
    }

    @Test("bash / fetch")
    func runAndFetch() {
        let bash = ToolDisplay.make(name: "Bash", input: input(["command": "ls -la"]))
        #expect(bash.verb == "Ran")
        #expect(bash.argument == "ls -la")
        #expect(bash.mono)
        #expect(ToolDisplay.make(name: "webfetch", input: input(["url": "https://x"])).verb == "Fetched")
    }

    @Test("task family")
    func taskFamily() {
        #expect(ToolDisplay.make(name: "TodoWrite", input: nil).verb == "Updated todos")
        let update = ToolDisplay.make(name: "TaskUpdate", input: input(["taskId": "7", "status": "completed"]))
        #expect(update.verb == "Updated task")
        #expect(update.argument == "#7 → completed")
    }

    @Test("unknown tool falls back to its name + best-effort arg")
    func unknownFallback() {
        let custom = ToolDisplay.make(name: "MyTool", input: input(["thing": "value"]))
        #expect(custom.verb == "MyTool")
        #expect(custom.argument == "value")

        // A verb branch only fires when its field exists — read with no
        // file path falls through to the default row.
        let readNoFile = ToolDisplay.make(name: "read", input: input(["other": "x"]))
        #expect(readNoFile.verb == "read")

        let empty = ToolDisplay.make(name: nil, input: nil)
        #expect(empty.verb == "Called tool")
        #expect(empty.argument == nil)
    }
}
