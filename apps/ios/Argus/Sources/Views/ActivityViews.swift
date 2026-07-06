import SwiftUI
import ArgusKit
import MarkdownUI

/// The per-turn activity band — a collapsible capsule ("N tools · last
/// tool · elapsed" with live dots while running) that expands into a
/// left-railed timeline of tool cards, output, and thinking rows. The
/// iOS counterpart of the web's ActivityPill + ActivityPanel.
struct ActivityPill: View {
    let turn: Turn
    @State private var expanded = false

    private var toolCount: Int {
        turn.timeline.filter { $0.kind == .tool }.count
    }

    private var lastToolSummary: String? {
        guard let last = turn.timeline.last(where: { $0.kind == .tool }) else { return nil }
        let display = ToolDisplay.make(name: last.toolName, input: last.toolInput)
        if let arg = display.argument { return "\(display.verb) \(arg)" }
        return display.verb
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            capsule
            if expanded {
                timeline
            }
        }
    }

    private var capsule: some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() }
        } label: {
            HStack(spacing: 8) {
                Text("\(toolCount) \(toolCount == 1 ? "tool" : "tools")")
                    .monospacedDigit()
                Separator()
                middle
                if let thinking = turn.thinkingTokens {
                    Separator()
                    Label("\(thinking)", systemImage: "brain")
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(.purple)
                }
                Separator()
                ElapsedLabel(turn: turn)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .font(.caption)
            .foregroundStyle(expanded ? .primary : .secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.surface1.opacity(expanded ? 1 : 0.6), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var middle: some View {
        if turn.isRunning {
            RunningDots()
        } else {
            Text(lastToolSummary ?? "done")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(maxWidth: 180, alignment: .leading)
        }
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !turn.narration.isEmpty {
                Markdown(turn.narration)
                    .markdownTextStyle(\.text) {
                        ForegroundColor(.secondary)
                        FontSize(.em(0.9))
                    }
                    .textSelection(.enabled)
            }
            ForEach(turn.timeline) { item in
                TimelineRowView(item: item)
            }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
            Rectangle().frame(width: 1).foregroundStyle(Color(.separator))
        }
    }
}

private struct Separator: View {
    var body: some View {
        Text("·").foregroundStyle(.tertiary)
    }
}

/// Three pulsing dots while a turn streams (web's `Dot`).
private struct RunningDots: View {
    @State private var phase = false

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .frame(width: 4, height: 4)
                    .foregroundStyle(.tertiary)
                    .opacity(phase ? 1 : 0.3)
                    .animation(
                        .easeInOut(duration: 0.6).repeatForever().delay(Double(index) * 0.16),
                        value: phase
                    )
            }
        }
        .onAppear { phase = true }
    }
}

/// Elapsed wall-clock for the turn; ticks live while running.
private struct ElapsedLabel: View {
    let turn: Turn

    var body: some View {
        if turn.isRunning {
            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                Text(format(now: context.date))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        } else {
            Text(format(now: Date()))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    private func format(now: Date) -> String {
        guard let start = ISO8601.parse(turn.command.createdAt) else { return "" }
        let end = turn.command.completedAt.flatMap(ISO8601.parse) ?? now
        let ms = max(0, end.timeIntervalSince(start) * 1000)
        if ms < 1000 { return "\(Int(ms))ms" }
        if ms < 60_000 {
            let s = (ms / 100).rounded() / 10
            return String(format: "%.1fs", s)
        }
        let total = Int(ms / 1000)
        return "\(total / 60)m \(total % 60)s"
    }
}

/// One timeline row, dispatched by kind.
struct TimelineRowView: View {
    let item: TimelineItem

    var body: some View {
        switch item.kind {
        case .tool:
            ToolPillCard(item: item)
        case .output:
            OutputRow(text: item.text, isError: item.isError, isDiff: item.isDiff)
        case .thinking(let redacted):
            ThinkingRow(text: item.text, redacted: redacted)
        case .system:
            Text(item.text)
                .font(.caption)
                .italic()
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .error:
            OutputRow(text: item.text, isError: true, isDiff: false)
        }
    }
}

/// Cursor-style tool card: icon + verb + argument, expandable to the
/// tool input JSON and its result (output or diff). Errors auto-expand.
struct ToolPillCard: View {
    let item: TimelineItem

    @State private var showBody: Bool
    @State private var showInput = false

    init(item: TimelineItem) {
        self.item = item
        _showBody = State(initialValue: item.isError)
    }

    private var display: ToolDisplay {
        ToolDisplay.make(name: item.toolName, input: item.toolInput)
    }

    private var hasInput: Bool { !(item.toolInput ?? [:]).isEmpty }
    private var hasResult: Bool { !(item.resultText ?? "").isEmpty }
    private var expandable: Bool { hasInput || hasResult }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if expandable { withAnimation(.easeOut(duration: 0.12)) { showBody.toggle() } }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: ToolStyle.symbol(for: item.toolName))
                        .font(.caption2)
                        .foregroundStyle(ToolStyle.tint(for: item.toolName))
                        .frame(width: 15)
                    Text(display.verb)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let arg = display.argument {
                        Text(arg)
                            .font(display.mono ? .caption2.monospaced() : .caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 4)
                    if item.isError {
                        Text("ERROR")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.red)
                    } else if expandable {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(showBody ? 180 : 0))
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(showBody ? Color.surface1.opacity(0.6) : .clear,
                            in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!expandable)

            if showBody {
                VStack(alignment: .leading, spacing: 6) {
                    if hasInput {
                        Button {
                            withAnimation(.easeOut(duration: 0.1)) { showInput.toggle() }
                        } label: {
                            Text(showInput ? "hide input" : "show input")
                                .font(.system(size: 10, weight: .semibold))
                                .textCase(.uppercase)
                                .foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.plain)
                        if showInput {
                            MonoBlock(text: prettyInput, maxHeight: 200)
                        }
                    }
                    if item.isDiff {
                        ScrollView { DiffText(text: item.diffBody) }
                            .frame(maxHeight: 220)
                    } else if let result = item.resultText, !result.isEmpty {
                        MonoBlock(text: result, isError: item.isError, maxHeight: 200)
                    }
                }
                .padding(.leading, 21)
            }
        }
    }

    private var prettyInput: String {
        guard let input = item.toolInput else { return "" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(input),
              let string = String(data: data, encoding: .utf8) else { return "" }
        return string
    }
}

private struct OutputRow: View {
    let text: String
    let isError: Bool
    let isDiff: Bool

    var body: some View {
        if isDiff {
            ScrollView { DiffText(text: text) }.frame(maxHeight: 220)
        } else {
            MonoBlock(text: text, isError: isError, maxHeight: 200)
        }
    }
}

private struct ThinkingRow: View {
    let text: String
    let redacted: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("Thinking", systemImage: "brain")
                .font(.system(size: 10, weight: .medium))
                .textCase(.uppercase)
                .foregroundStyle(.tertiary)
            if redacted {
                Text("[redacted]")
                    .font(.caption2)
                    .italic()
                    .foregroundStyle(.tertiary)
            } else {
                Markdown(text)
                    .markdownTextStyle(\.text) {
                        ForegroundColor(.secondary)
                        FontSize(.em(0.85))
                    }
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Scrollable monospace block on a layered surface (tool output / input).
private struct MonoBlock: View {
    let text: String
    var isError = false
    var maxHeight: CGFloat = 200

    var body: some View {
        ScrollView {
            Text(text)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(isError ? Color.red : .secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: maxHeight)
        .padding(8)
        .background(Color.surface1.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
    }
}
