import SwiftUI
import ArgusKit
import MarkdownUI

/// The transcript screen: streaming turns + composer. The Swift
/// counterpart of the web's SessionPanel/StreamViewer, driven entirely
/// by SessionViewModel's derived `turns`.
struct SessionView: View {
    @Environment(AppModel.self) private var app
    let sessionId: String

    @State private var model: SessionViewModel?
    @State private var draft = ""

    private var session: SessionDTO? { app.sessionList.sessions[sessionId] }
    private var agent: AgentDTO? {
        session.flatMap { app.fleet.agents[$0.agentId] }
    }

    var body: some View {
        VStack(spacing: 0) {
            ConnectionBanner()
            transcript
            Divider()
            composer
        }
        .navigationTitle(session?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let agent {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 6) {
                        AgentTypeIcon(type: agent.type)
                        if agent.status != .online {
                            Text(agent.status.rawValue)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .task {
            guard model == nil, let client = app.client, let stream = app.stream else { return }
            let viewModel = SessionViewModel(
                sessionId: sessionId,
                agentType: agent?.type ?? "custom",
                client: client,
                stream: stream,
                onAuthError: { [weak app] in app?.handleAPIError($0) }
            )
            model = viewModel
            app.activeSession = viewModel
            app.sessionList.markSeenLocally(id: sessionId)
            await viewModel.start()
        }
        .onDisappear {
            model?.stop()
            if app.activeSession === model { app.activeSession = nil }
        }
    }

    // MARK: Transcript

    @ViewBuilder
    private var transcript: some View {
        if let model {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 24) {
                        historyHeader(model)
                        ForEach(model.turns) { turn in
                            TurnCell(turn: turn).id(turn.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding()
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: model.turns) {
                    // Follow the stream while a turn is live; static
                    // history stays where the user scrolled it.
                    if model.isRunning {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
                .onChange(of: model.turns.isEmpty) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
                .overlay { emptyState(model) }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func historyHeader(_ model: SessionViewModel) -> some View {
        if model.hasMoreHistory {
            Button {
                Task { await model.loadOlder() }
            } label: {
                if model.loadingOlder {
                    ProgressView().controlSize(.small)
                } else {
                    Label("Load earlier turns", systemImage: "arrow.up.circle")
                        .font(.footnote)
                }
            }
            .frame(maxWidth: .infinity)
            .buttonStyle(.bordered)
        }
    }

    @ViewBuilder
    private func emptyState(_ model: SessionViewModel) -> some View {
        if model.turns.isEmpty {
            switch model.loadState {
            case .loading:
                ProgressView()
            case .failed(let message):
                ContentUnavailableView(
                    "Couldn't load transcript",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            case .loaded:
                ContentUnavailableView(
                    "No messages yet",
                    systemImage: "bubble.left",
                    description: Text("Send a prompt to start the conversation.")
                )
            }
        }
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 6) {
            if let error = model?.actionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(
                    model?.isRunning == true ? "Agent is working…" : "Message",
                    text: $draft,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .disabled(model == nil)

                if model?.isRunning == true {
                    Button {
                        Task { await model?.cancelRunningTurn() }
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.red)
                    }
                }

                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.title2)
                }
                .disabled(!canSend)
            }
        }
        .padding(10)
    }

    private var canSend: Bool {
        guard let model else { return false }
        // Queueing while running is Phase 2 — for now one turn at a time.
        return !model.isRunning
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard let model else { return }
        let text = draft
        draft = ""
        Task { await model.send(text) }
    }
}

// MARK: - Turn rendering

private struct TurnCell: View {
    let turn: Turn

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !turn.prompt.isEmpty {
                PromptBubble(text: turn.prompt)
            }

            if !turn.timeline.isEmpty || turn.thinkingTokens != nil || !turn.narration.isEmpty {
                ActivityBlock(turn: turn)
            }

            if !turn.answer.isEmpty {
                Markdown(turn.answer)
                    .markdownTextStyle(\.code) {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.85))
                    }
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if turn.isRunning {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Working…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if let errorText = turn.errorText {
                Text(errorText)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.red)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

private struct PromptBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            Text(text)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.blue.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
                .textSelection(.enabled)
        }
    }
}

/// The activity band under a prompt: narration, thinking counter, and
/// one row per timeline item (tools expandable to their output).
private struct ActivityBlock: View {
    let turn: Turn
    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !turn.narration.isEmpty {
                Text(turn.narration)
                    .font(.footnote)
                    .italic()
                    .foregroundStyle(.secondary)
                    .lineLimit(expanded.contains("narration") ? nil : 3)
                    .onTapGesture { toggle("narration") }
            }

            if let thinkingTokens = turn.thinkingTokens {
                Label("thinking · \(thinkingTokens) tokens", systemImage: "brain")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ForEach(turn.timeline) { item in
                TimelineRow(
                    item: item,
                    isExpanded: expanded.contains(item.id),
                    onToggle: { toggle(item.id) }
                )
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
    }

    private func toggle(_ id: String) {
        if expanded.contains(id) {
            expanded.remove(id)
        } else {
            expanded.insert(id)
        }
    }
}

private struct TimelineRow: View {
    let item: TimelineItem
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: onToggle) {
                HStack(spacing: 6) {
                    Image(systemName: symbol)
                        .font(.caption2)
                        .foregroundStyle(tint)
                        .frame(width: 14)
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(item.kind == .error ? .red : .secondary)
                        .lineLimit(1)
                    if hasDetail {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            .disabled(!hasDetail)

            if isExpanded, hasDetail {
                ScrollView {
                    Text(item.text)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
                .padding(6)
                .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    private var hasDetail: Bool {
        !item.text.isEmpty
    }

    private var title: String {
        switch item.kind {
        case .tool(let name):
            let firstLine = item.text
                .split(separator: "\n", maxSplits: 1)
                .first.map(String.init) ?? ""
            return firstLine.isEmpty ? name : firstLine
        case .thinking(let redacted):
            return redacted ? "thinking (redacted)" : firstLineOrKind("thinking")
        case .stdout: return firstLineOrKind("output")
        case .stderr: return firstLineOrKind("stderr")
        case .progress, .system: return firstLineOrKind("system")
        case .error: return firstLineOrKind("error")
        }
    }

    private func firstLineOrKind(_ fallback: String) -> String {
        let firstLine = item.text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", maxSplits: 1)
            .first.map(String.init) ?? ""
        return firstLine.isEmpty ? fallback : firstLine
    }

    private var symbol: String {
        switch item.kind {
        case .tool: return item.isDiff ? "plus.forwardslash.minus" : "wrench.and.screwdriver"
        case .stdout: return "terminal"
        case .stderr: return "exclamationmark.bubble"
        case .progress, .system: return "info.circle"
        case .thinking: return "brain"
        case .error: return "exclamationmark.triangle"
        }
    }

    private var tint: Color {
        switch item.kind {
        case .tool: return .blue
        case .stdout: return .green
        case .stderr: return .orange
        case .progress, .system: return .secondary
        case .thinking: return .purple
        case .error: return .red
        }
    }
}
