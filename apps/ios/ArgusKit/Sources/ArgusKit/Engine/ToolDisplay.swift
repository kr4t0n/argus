import Foundation

/// Verb + argument for a tool row — a pure port of the web's
/// `ToolPill.describe()` (`apps/web/src/components/ToolPill.tsx`). Keeps
/// the transcript's tool phrasing identical across clients. SF-symbol and
/// color choices stay in the UI layer (keyed off `toolName`); this is
/// only the text.
public struct ToolDisplay: Equatable, Sendable {
    public let verb: String
    /// Primary argument (file path, command, query…), or nil.
    public let argument: String?
    /// Render the argument in a monospaced font (paths, commands).
    public let mono: Bool

    public init(verb: String, argument: String? = nil, mono: Bool = false) {
        self.verb = verb
        self.argument = argument
        self.mono = mono
    }

    /// Build the display for a tool name + its raw `meta.input`.
    public static func make(name rawName: String?, input: [String: JSONValue]?) -> ToolDisplay {
        let name = (rawName ?? "").lowercased()
        let input = input ?? [:]

        // Argument sources, mirroring the web's field probes.
        let file = firstString(input, "file_path", "filePath", "path", "filename")
        let pattern = firstString(input, "pattern", "glob")
        let query = firstString(input, "query", "search")
        let cmd = firstString(input, "command", "cmd")
        let url = firstString(input, "url")

        switch name {
        case "read", "cat", "open":
            if let file { return ToolDisplay(verb: "Read", argument: file, mono: true) }
        case "write", "create":
            if let file { return ToolDisplay(verb: "Wrote", argument: file, mono: true) }
        case "edit", "patch", "multiedit":
            if let file { return ToolDisplay(verb: "Edited", argument: file, mono: true) }
        case "delete", "remove", "rm":
            if let file { return ToolDisplay(verb: "Deleted", argument: file, mono: true) }
        case "rename", "move", "mv":
            if let file { return ToolDisplay(verb: "Renamed", argument: file, mono: true) }
        case "grep":
            if let arg = pattern ?? query {
                return ToolDisplay(verb: "Searched codebase for", argument: arg, mono: false)
            }
        case "glob", "find", "ls":
            if let arg = pattern ?? file {
                return ToolDisplay(verb: "Listed", argument: arg, mono: true)
            }
        case "bash", "shell", "exec", "run":
            if let cmd { return ToolDisplay(verb: "Ran", argument: cmd, mono: true) }
        case "fetch", "webfetch":
            if let url { return ToolDisplay(verb: "Fetched", argument: url, mono: true) }
        case "websearch":
            if let query { return ToolDisplay(verb: "Searched web for", argument: query, mono: false) }
        case "task", "todo", "todowrite", "updatetodos":
            return ToolDisplay(verb: "Updated todos")
        case "taskcreate":
            return ToolDisplay(verb: "Created task", argument: firstString(input, "subject"), mono: false)
        case "taskupdate":
            let taskId = firstString(input, "taskId")
            let status = firstString(input, "status")
            let arg = [taskId.map { "#\($0)" }, status].compactMap { $0 }.joined(separator: " → ")
            return ToolDisplay(verb: "Updated task", argument: arg.isEmpty ? nil : arg, mono: false)
        case "tasklist":
            return ToolDisplay(verb: "Listed tasks")
        case "taskget":
            return ToolDisplay(verb: "Read task", argument: firstString(input, "taskId").map { "#\($0)" }, mono: false)
        case "agent":
            let arg = firstString(input, "description", "subagent_type")
            return ToolDisplay(verb: "Sub-agent", argument: arg, mono: false)
        default:
            break
        }

        // Default row: use the raw name as the verb, best-effort argument.
        let verb = (rawName?.isEmpty == false) ? rawName! : "Called tool"
        let arg = file ?? pattern ?? query ?? cmd ?? url ?? fallbackArgument(input)
        return ToolDisplay(verb: verb, argument: arg, mono: true)
    }

    private static func firstString(_ input: [String: JSONValue], _ keys: String...) -> String? {
        for key in keys {
            if let value = input[key]?.string, !value.isEmpty { return value }
        }
        return nil
    }

    /// Last-resort argument for an unrecognized tool — the first short
    /// string value in the input, so the row isn't verb-only.
    private static func fallbackArgument(_ input: [String: JSONValue]) -> String? {
        for (_, value) in input {
            if let string = value.string, !string.isEmpty, string.count <= 200 {
                return string
            }
        }
        return nil
    }
}
