import SwiftUI
import ArgusKit

// To-do + sub-agent panels — the iOS counterparts of the web's
// TodoWindow / SubAgentWindow. Rendered per turn, above the answer.

/// Collapsible to-do checklist (latest TodoWrite snapshot). Default open;
/// deliberately never auto-collapses when everything is done — the
/// finished plan stays visible (web parity).
struct TodoWindow: View {
    let todos: [TodoItem]
    @State private var open = true

    private var done: Int { todos.filter { $0.status == .completed }.count }
    private var allDone: Bool { !todos.isEmpty && done == todos.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.12)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checklist").font(.caption)
                    Text("To-dos").font(.caption)
                    Text(allDone ? "\(todos.count)" : "\(done)/\(todos.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Chevron(open: open)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(todos) { TodoRow(todo: $0) }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
        .background(Color.surface1.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct TodoRow: View {
    let todo: TodoItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            icon
                .frame(width: 14, height: 14)
                .padding(.top, 1)
            Text(todo.displayText)
                .font(.caption)
                .strikethrough(todo.status == .completed)
                .foregroundStyle(textColor)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var icon: some View {
        switch todo.status {
        case .completed:
            // Web parity: emerald-500 at 80%, not bright system green.
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(Color(hex: 0x10B981).opacity(0.8))
        case .inProgress:
            ProgressView().controlSize(.mini)
        case .pending:
            Image(systemName: "circle").font(.caption).foregroundStyle(.tertiary)
        }
    }

    private var textColor: HierarchicalShapeStyle {
        switch todo.status {
        case .completed: return .tertiary
        case .inProgress: return .primary
        case .pending: return .secondary
        }
    }
}

/// Collapsible list of sub-agent invocations. Window default open; each
/// row default-open only when it errored (web parity).
struct SubAgentWindow: View {
    let calls: [SubAgentCall]
    @State private var open = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.12)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "cpu").font(.caption).foregroundStyle(Color.toolAmber)
                    Text("Sub-agents").font(.caption).foregroundStyle(.secondary)
                    Text("\(calls.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Chevron(open: open)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(calls) { SubAgentRow(call: $0) }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
        .background(Color.surface1.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct SubAgentRow: View {
    let call: SubAgentCall
    @State private var open: Bool

    init(call: SubAgentCall) {
        self.call = call
        _open = State(initialValue: call.isError)
    }

    private var hasBody: Bool {
        !call.prompt.isEmpty || call.result != nil || !call.nested.isEmpty
    }

    /// The header badge counts tool calls only — the interleaved
    /// `.thought`/`.thinking` items are prose, not activity units.
    private var toolCount: Int {
        call.nested.filter { $0.kind == .tool }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if hasBody, !call.isError { withAnimation(.easeOut(duration: 0.12)) { open.toggle() } }
            } label: {
                HStack(spacing: 6) {
                    if !call.subagentType.isEmpty {
                        Text(call.subagentType)
                            .font(.system(size: 10, design: .monospaced))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.surface2.opacity(0.6), in: Capsule())
                    }
                    Text(call.description.isEmpty ? "no description" : call.description)
                        .font(.caption)
                        .italic(call.description.isEmpty)
                        .foregroundStyle(call.description.isEmpty ? .tertiary : .secondary)
                        .lineLimit(1)
                    if toolCount > 0 {
                        Text("\(toolCount) tool\(toolCount == 1 ? "" : "s")")
                            .font(.system(size: 10).monospacedDigit())
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 4)
                    if call.isError {
                        Text("ERROR").font(.system(size: 9, weight: .semibold)).foregroundStyle(.red)
                    } else if hasBody {
                        Chevron(open: open)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!hasBody || call.isError)

            if open, hasBody {
                VStack(alignment: .leading, spacing: 6) {
                    if !call.prompt.isEmpty {
                        caption("prompt")
                        MonoBlock(text: call.prompt, maxHeight: 180)
                    }
                    if !call.nested.isEmpty {
                        caption("activity")
                        VStack(alignment: .leading, spacing: 4) {
                            // Chronological: tools interleaved with the
                            // sub-agent's streamed text and thinking.
                            ForEach(call.nested) { item in
                                switch item.kind {
                                case .thought:
                                    Text(item.text)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 2)
                                case .thinking(let redacted):
                                    Text(redacted ? "[redacted thinking]" : item.text)
                                        .font(.caption2)
                                        .italic()
                                        .foregroundStyle(.tertiary)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 2)
                                default:
                                    ToolPillCard(item: item)
                                }
                            }
                        }
                        .padding(6)
                        .background(Color.surface2.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                    }
                    if let result = call.result {
                        caption(call.isError ? "error" : "result")
                        MonoBlock(text: result, isError: call.isError, maxHeight: 180)
                    }
                }
                .padding(.leading, 8)
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .textCase(.uppercase)
            .foregroundStyle(.tertiary)
    }
}

private struct Chevron: View {
    let open: Bool
    var body: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.tertiary)
            .rotationEffect(.degrees(open ? 180 : 0))
    }
}
