import Foundation

// Sub-agent + to-do "dedicated panels" — ports of the web's TodoWindow /
// SubAgentWindow (`apps/web/src/components/{TodoWindow,SubAgentWindow}.tsx`)
// plus the `isNestedSubAgentChunk` / `isDedicatedPanelTool` predicates in
// ActivityPill.tsx that keep these chunks OUT of the main tool timeline.

public enum TodoStatus: String, Equatable, Sendable {
    case pending
    case inProgress
    case completed
}

public struct TodoItem: Identifiable, Equatable, Sendable {
    public let id: Int
    public let content: String
    public let status: TodoStatus
    /// Present-continuous form ("Writing tests") — shown only while the
    /// row is in progress.
    public let activeForm: String?

    public var displayText: String {
        status == .inProgress ? (activeForm ?? content) : content
    }
}

/// One `Agent`/Task sub-agent invocation with its nested tool calls and
/// result folded in.
public struct SubAgentCall: Identifiable, Equatable, Sendable {
    public let id: String
    public let subagentType: String
    public let description: String
    public let prompt: String
    /// Trimmed result body, nil when empty.
    public let result: String?
    public let isError: Bool
    /// The sub-agent's chronological activity: `.tool` items (so the UI
    /// reuses ToolPillCard), `.thought` items (coalesced runs of the
    /// sub-agent's streamed text — its preamble narration and response
    /// prose), and `.thinking` items.
    public let nested: [TimelineItem]
}

enum DedicatedPanels {
    /// Tools that render in a dedicated panel, never the main timeline.
    static let dedicatedToolNames: Set<String> = [
        "agent", "todowrite", "todo", "task", "updatetodos",
        "taskcreate", "taskupdate", "tasklist", "taskget",
    ]
    /// Tool names TodoWindow sources its list from.
    static let todoToolNames: Set<String> = ["todowrite", "todo", "task", "updatetodos"]

    static func toolName(_ chunk: ResultChunk) -> String {
        (chunk.meta?["tool"]?.string ?? "").lowercased()
    }

    /// A chunk that happened INSIDE a sub-agent (non-empty parentToolUseId).
    static func isNested(_ chunk: ResultChunk) -> Bool {
        !(chunk.meta?["parentToolUseId"]?.string ?? "").isEmpty
    }

    static func isDedicatedPanelTool(_ chunk: ResultChunk) -> Bool {
        chunk.kind == .tool && dedicatedToolNames.contains(toolName(chunk))
    }

    /// Accepts Claude Code lowercase and cursor-agent `TODO_STATUS_*`.
    static func normaliseTodoStatus(_ raw: String?) -> TodoStatus {
        switch (raw ?? "").uppercased() {
        case "COMPLETED", "TODO_STATUS_COMPLETED": return .completed
        case "IN_PROGRESS", "TODO_STATUS_IN_PROGRESS": return .inProgress
        default: return .pending
        }
    }

    /// Latest-wins: the most recent todo tool chunk carries the full list.
    /// nil when there's none, or the newest one's `todos` isn't an array.
    static func extractTodos(_ chunks: [ResultChunk]) -> [TodoItem]? {
        for chunk in chunks.reversed() {
            guard chunk.kind == .tool, todoToolNames.contains(toolName(chunk)) else { continue }
            guard let raw = chunk.meta?["input"]?["todos"]?.array else { return nil }
            var parsed: [TodoItem] = []
            for row in raw {
                guard let obj = row.object else { continue }
                let content = obj["content"]?.string ?? ""
                if content.isEmpty { continue }
                let activeForm = obj["activeForm"]?.string
                parsed.append(TodoItem(
                    id: parsed.count,
                    content: content,
                    status: normaliseTodoStatus(obj["status"]?.string),
                    activeForm: (activeForm?.isEmpty == false) ? activeForm : nil
                ))
            }
            return parsed.isEmpty ? nil : parsed
        }
        return nil
    }

    /// Group each top-level `agent` tool's nested activity under it, in
    /// stream order: tool calls, thinking blocks, and the sub-agent's
    /// own streamed text (adjacent nested deltas coalesce into one
    /// `.thought` item, mirroring the parent timeline; any chunk from
    /// anything else — top-level or a parallel sibling — closes the run).
    static func extractSubAgents(_ chunks: [ResultChunk]) -> [SubAgentCall] {
        var resultByToolId: [String: ResultChunk] = [:]
        for chunk in chunks where chunk.kind == .stdout || chunk.kind == .stderr {
            if let rid = chunk.meta?["toolResultFor"]?.string { resultByToolId[rid] = chunk }
        }
        var nestedByParent: [String: [TimelineItem]] = [:]
        var textParent = ""
        var textBuffer = ""
        var textStart: (id: String, seq: Int)?
        func flushText() {
            defer { textBuffer = ""; textStart = nil; textParent = "" }
            guard let start = textStart,
                  !textBuffer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return }
            nestedByParent[textParent, default: []].append(TimelineItem(
                id: start.id + ":subtext", kind: .thought, seq: start.seq, text: textBuffer
            ))
        }
        for chunk in chunks {
            let pid = chunk.meta?["parentToolUseId"]?.string ?? ""
            if pid.isEmpty || (textStart != nil && textParent != pid) { flushText() }
            guard !pid.isEmpty else { continue }
            switch chunk.kind {
            case .delta:
                if textStart == nil {
                    textStart = (chunk.id, chunk.seq)
                    textParent = pid
                }
                textBuffer += chunk.delta ?? ""
            case .tool:
                flushText()
                nestedByParent[pid, default: []]
                    .append(toolItem(for: chunk, resultByToolId: resultByToolId))
            case .progress:
                guard chunk.meta?["contentType"]?.string == "thinking" else { continue }
                let text = (chunk.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                flushText()
                nestedByParent[pid, default: []].append(TimelineItem(
                    id: chunk.id + ":subthink",
                    kind: .thinking(redacted: chunk.meta?["redacted"]?.bool == true),
                    seq: chunk.seq,
                    text: chunk.content ?? ""
                ))
            default:
                flushText()
            }
        }
        flushText()

        // Background completion reports: `task_notification` progress
        // chunks carry the sub-agent's full final report in `content`,
        // attributed via meta.tool_use_id. Later wins.
        var notificationByToolId: [String: ResultChunk] = [:]
        for chunk in chunks where chunk.kind == .progress {
            guard chunk.meta?["contentType"]?.string == "task_notification",
                  let tid = chunk.meta?["tool_use_id"]?.string, !tid.isEmpty,
                  chunk.content?.isEmpty == false
            else { continue }
            notificationByToolId[tid] = chunk
        }

        var calls: [SubAgentCall] = []
        for chunk in chunks where chunk.kind == .tool && toolName(chunk) == "agent" {
            let toolId = chunk.meta?["id"]?.string
            let id = (toolId?.isEmpty == false) ? toolId! : chunk.id
            let input = chunk.meta?["input"]?.object ?? [:]
            let subType = input["subagent_type"]?.string ?? input["subagentType"]?.string ?? ""
            let paired = resultByToolId[id]
            let notification = notificationByToolId[id]
            // Background runs (run_in_background: true): the Task
            // tool_result is only launch boilerplate — the real report
            // arrives via task_notification. Until it lands (or for old
            // rows where the sidecar dropped it), show no result rather
            // than the boilerplate blob. Sync runs keep the tool_result.
            let isBackground = input["run_in_background"]?.bool == true
            let notifText = notification?.content?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let pairedText = paired?.content?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resultText = (notifText?.isEmpty == false)
                ? notifText
                : (isBackground ? nil : pairedText)
            let isError: Bool
            if let notification {
                let status = notification.meta?["status"]?.string
                isError = status != nil && status != "completed"
            } else {
                isError = paired?.kind == .stderr
            }
            let nested = nestedByParent[id] ?? []
            calls.append(SubAgentCall(
                id: id,
                subagentType: subType,
                description: input["description"]?.string ?? "",
                prompt: input["prompt"]?.string ?? "",
                result: (resultText?.isEmpty == false) ? resultText : nil,
                isError: isError,
                nested: nested
            ))
        }
        return calls
    }

    /// Build a `.tool` TimelineItem with its paired result folded in —
    /// shared by the main timeline and the sub-agent nested lists.
    static func toolItem(for chunk: ResultChunk, resultByToolId: [String: ResultChunk]) -> TimelineItem {
        let name = chunk.meta?["tool"]?.string ?? firstLine(of: chunk.content) ?? "tool"
        let toolId = chunk.meta?["id"]?.string
        let result = toolId.flatMap { resultByToolId[$0] }
        return TimelineItem(
            id: chunk.id,
            kind: .tool,
            seq: chunk.seq,
            text: chunk.content ?? "",
            toolName: name,
            toolInput: chunk.meta?["input"]?.object,
            resultText: result?.content,
            isError: result?.kind == .stderr,
            isDiff: result?.meta?["isDiff"]?.bool ?? false,
            filePath: result?.meta?["filePath"]?.string
                ?? chunk.meta?["input"]?["file_path"]?.string,
            exitCode: result?.meta?["exitCode"]?.int
        )
    }

    static func firstLine(of text: String?) -> String? {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.split(separator: "\n", maxSplits: 1).first.map(String.init)
    }
}
