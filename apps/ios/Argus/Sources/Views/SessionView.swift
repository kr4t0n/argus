import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ArgusKit

/// The transcript screen: streaming turns + composer. The Swift
/// counterpart of the web's SessionPanel/StreamViewer, driven entirely
/// by SessionViewModel's derived `turns`. Renders as the split view's
/// detail column.
struct SessionView: View {
    @Environment(AppModel.self) private var app
    let sessionId: String

    @State private var model: SessionViewModel?
    @State private var draft = ""
    @State private var nearBottom = true

    // Attachments being composed (already uploaded — server holds bytes).
    @State private var pendingAttachments: [UploadedAttachment] = []
    @State private var uploadsInFlight = 0
    @State private var showAttachmentDialog = false
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var photoSelection: [PhotosPickerItem] = []

    // Toolbar sheets/alerts.
    @State private var showModelPicker = false
    @State private var showRename = false
    @State private var renameText = ""

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
        .toolbar { toolbarContent }
        .sheet(isPresented: $showModelPicker) {
            if let session {
                ModelPickerSheet(session: session, agent: agent)
            }
        }
        .alert("Rename session", isPresented: $showRename) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { commitRename() }
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $photoSelection,
            maxSelectionCount: 5,
            matching: .images
        )
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result { uploadFiles(urls) }
        }
        .onChange(of: photoSelection) { uploadPhotos() }
        .confirmationDialog("Attach", isPresented: $showAttachmentDialog) {
            Button("Photo Library") { showPhotoPicker = true }
            Button("Files") { showFileImporter = true }
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

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 10) {
                if let model {
                    UsageBadge(usage: model.usage, context: model.context)
                }
                Button {
                    app.inspectorPresented.toggle()
                } label: {
                    Image(systemName: "sidebar.trailing")
                }
                Menu {
                    Button("Model…", systemImage: "cpu") { showModelPicker = true }
                    modelSummary
                    Divider()
                    Button("Rename…", systemImage: "pencil") {
                        renameText = session?.title ?? ""
                        showRename = true
                    }
                    Button("Archive", systemImage: "archivebox") { archive() }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }

    @ViewBuilder
    private var modelSummary: some View {
        if let selection = session?.modelSelection, !selection.isEmpty {
            Text(selectionLabel(selection))
        } else {
            Text("Model: CLI default")
        }
    }

    private func selectionLabel(_ selection: ModelSelection) -> String {
        var parts: [String] = []
        if let model = selection.model { parts.append(model) }
        if let effort = selection.effort { parts.append(effort) }
        if selection.context == "1m" { parts.append("1M") }
        if selection.speed == "fast" { parts.append("fast") }
        return "Model: " + (parts.isEmpty ? "CLI default" : parts.joined(separator: " · "))
    }

    private func commitRename() {
        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, let client = app.client else { return }
        Task {
            do {
                app.sessionList.upsert(try await client.renameSession(id: sessionId, title: title))
            } catch {
                app.handleAPIError(error)
            }
        }
    }

    private func archive() {
        guard let client = app.client else { return }
        Task {
            do {
                app.sessionList.upsert(try await client.archiveSession(id: sessionId))
                if app.route == .session(sessionId) { app.route = nil }
            } catch {
                app.handleAPIError(error)
            }
        }
    }

    private func fork(from turn: Turn) {
        guard let client = app.client else { return }
        Task {
            do {
                let forked = try await client.forkSession(id: sessionId, commandId: turn.id)
                app.sessionList.upsert(forked)
                app.route = .session(forked.id)
            } catch {
                app.handleAPIError(error)
                model?.actionError = (error as? APIError)?.message ?? error.localizedDescription
            }
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
                            TurnCell(
                                turn: turn,
                                attachmentURL: { app.client?.absoluteURL(for: $0.url) },
                                onFork: { fork(from: turn) }
                            )
                            .id(turn.id)
                        }
                        // Bottom sentinel: its visibility IS the
                        // "pinned to bottom" signal for stickiness.
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                            .onAppear { nearBottom = true }
                            .onDisappear { nearBottom = false }
                    }
                    .padding()
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: model.turns) {
                    // Follow a live stream only while the user is at the
                    // bottom — scrolled-up reading stays put.
                    if model.isRunning, nearBottom {
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
        VStack(spacing: 8) {
            if let error = model?.actionError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            PromptQueueList(sessionId: sessionId)

            inputBox
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    /// The web's rounded-3xl composer: a soft layered pill wrapping the
    /// paperclip, the auto-growing field, and the send/stop actions.
    private var inputBox: some View {
        VStack(spacing: 8) {
            if !pendingAttachments.isEmpty || uploadsInFlight > 0 {
                attachmentChips
            }

            HStack(alignment: .bottom, spacing: 6) {
                Button {
                    showAttachmentDialog = true
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .disabled(model == nil)

                TextField(
                    isBusy ? "Queue a follow-up…" : "Request changes or ask a question…",
                    text: $draft,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .padding(.vertical, 6)
                .disabled(model == nil)

                if model?.isRunning == true {
                    Button {
                        Task { await model?.cancelRunningTurn() }
                    } label: {
                        Image(systemName: "square.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.red)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(Color.surface2))
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(".", modifiers: .command)
                }

                Button(action: send) {
                    Group {
                        if uploadsInFlight > 0 {
                            ProgressView().controlSize(.small).tint(Color(.systemBackground))
                        } else {
                            Image(systemName: isBusy ? "text.badge.plus" : "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                        }
                    }
                    .foregroundStyle(Color(.systemBackground))
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(canSend ? Color.primary : Color.secondary.opacity(0.3)))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.surface1, in: RoundedRectangle(cornerRadius: 24))
    }

    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pendingAttachments) { attachment in
                    attachmentChip(attachment)
                }
                if uploadsInFlight > 0 {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 56, height: 56)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    @ViewBuilder
    private func attachmentChip(_ attachment: UploadedAttachment) -> some View {
        let remove = Button {
            pendingAttachments.removeAll { $0.id == attachment.id }
        } label: {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 15))
                .foregroundStyle(.white, .black.opacity(0.5))
        }
        .buttonStyle(.plain)
        .offset(x: 6, y: -6)

        if attachment.isImage, let url = attachment.url.flatMap({ app.client?.absoluteURL(for: $0) }) {
            AsyncImage(url: url) { phase in
                if case .success(let image) = phase {
                    image.resizable().scaledToFill()
                } else {
                    Color.surface2
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(.separator)))
            .overlay(alignment: .topTrailing) { remove }
        } else {
            HStack(spacing: 6) {
                Image(systemName: "doc.text").font(.caption).foregroundStyle(.tertiary)
                Text(attachment.filename).font(.caption2).lineLimit(1)
            }
            .padding(.horizontal, 8)
            .frame(width: 140, height: 56)
            .background(Color.surface2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(.separator)))
            .overlay(alignment: .topTrailing) { remove }
        }
    }

    /// Running turn OR queued backlog → submits join the queue.
    private var isBusy: Bool {
        model?.isRunning == true || app.queue.head(for: sessionId) != nil
    }

    private var canSend: Bool {
        model != nil
            && uploadsInFlight == 0
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        let attachmentIds = pendingAttachments.map(\.id)
        draft = ""
        pendingAttachments = []
        app.submitPrompt(sessionId: sessionId, text: text, attachmentIds: attachmentIds)
    }

    // MARK: Attachment uploads

    private func uploadPhotos() {
        guard !photoSelection.isEmpty else { return }
        let items = photoSelection
        photoSelection = []
        for (index, item) in items.enumerated() {
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            upload(name: "photo-\(index + 1).\(ext)", mime: mime) {
                try await item.loadTransferable(type: Data.self)
            }
        }
    }

    private func uploadFiles(_ urls: [URL]) {
        for url in urls {
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                ?? "application/octet-stream"
            upload(name: url.lastPathComponent, mime: mime) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                return try Data(contentsOf: url)
            }
        }
    }

    private func upload(
        name: String,
        mime: String,
        loadData: @escaping () async throws -> Data?
    ) {
        guard let client = app.client else { return }
        uploadsInFlight += 1
        Task {
            defer { uploadsInFlight -= 1 }
            do {
                guard let data = try await loadData() else { return }
                let attachment = try await client.uploadAttachment(
                    filename: name, mime: mime, data: data
                )
                pendingAttachments.append(UploadedAttachment(
                    id: attachment.id,
                    filename: attachment.filename,
                    isImage: attachment.mime.hasPrefix("image/"),
                    url: attachment.url
                ))
            } catch {
                app.handleAPIError(error)
                model?.actionError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}

private struct UploadedAttachment: Identifiable, Equatable {
    let id: String
    let filename: String
    let isImage: Bool
    /// API-relative tokenized URL for the composer thumbnail preview.
    let url: String?
}

// MARK: - Prompt queue strip

/// Parked follow-ups shown directly above the input (web's PromptQueue):
/// editable inline via alert, removable, drained oldest-first by
/// AppModel as the session goes idle.
private struct PromptQueueList: View {
    @Environment(AppModel.self) private var app
    let sessionId: String

    @State private var editing: QueuedPrompt?
    @State private var editText = ""

    var body: some View {
        let items = app.queue.items(for: sessionId)
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(items) { item in
                    HStack(spacing: 6) {
                        Image(systemName: "clock")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text(item.text)
                            .font(.caption)
                            .lineLimit(1)
                        if !item.attachmentIds.isEmpty {
                            Image(systemName: "paperclip")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Button {
                            editText = item.text
                            editing = item
                        } label: {
                            Image(systemName: "pencil").font(.caption2)
                        }
                        Button {
                            app.queue.remove(id: item.id)
                        } label: {
                            Image(systemName: "xmark").font(.caption2)
                        }
                    }
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .alert("Edit queued prompt", isPresented: editAlertBinding) {
                TextField("Prompt", text: $editText)
                Button("Cancel", role: .cancel) { editing = nil }
                Button("Save") {
                    if let editing, !editText.trimmingCharacters(in: .whitespaces).isEmpty {
                        app.queue.update(id: editing.id, text: editText)
                    }
                    editing = nil
                }
            }
        }
    }

    private var editAlertBinding: Binding<Bool> {
        Binding(
            get: { editing != nil },
            set: { if !$0 { editing = nil } }
        )
    }
}

// MARK: - Turn rendering

private struct TurnCell: View {
    let turn: Turn
    let attachmentURL: (AttachmentDTO) -> URL?
    let onFork: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Attachments render ABOVE the prompt bubble — matches the
            // web's user-message layout.
            if !turn.attachments.isEmpty {
                attachmentRow
            }

            if !turn.prompt.isEmpty {
                PromptBubble(text: turn.prompt)
            }

            if !turn.timeline.isEmpty || turn.thinkingTokens != nil || !turn.narration.isEmpty {
                ActivityPill(turn: turn)
            }

            if !turn.answer.isEmpty {
                AnswerView(markdown: turn.answer, isStreaming: turn.isRunning)
                    .contextMenu {
                        Button("Copy answer", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = turn.answer
                        }
                        Button("Fork from this turn", systemImage: "arrow.branch") {
                            onFork()
                        }
                    }
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
        .contextMenu {
            Button("Fork from this turn", systemImage: "arrow.branch") { onFork() }
        }
    }

    private var attachmentRow: some View {
        // Attachments are part of the USER's message — right-aligned
        // under the prompt bubble, like the web. A plain trailing frame
        // doesn't cut it: the horizontal ScrollView fills the row and
        // pins content leading; the trailing default anchor both aligns
        // fitting content right and starts overflow scrolled to the end.
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(turn.attachments) { attachment in
                    if attachment.mime.hasPrefix("image/"), let url = attachmentURL(attachment) {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().scaledToFill()
                            default:
                                Color.gray.opacity(0.1)
                            }
                        }
                        .frame(width: 88, height: 88)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    } else {
                        Label(attachment.filename, systemImage: "doc")
                            .font(.caption2)
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .background(.quaternary.opacity(0.5), in: Capsule())
                    }
                }
            }
            .padding(.leading, 40)
        }
        .defaultScrollAnchor(.trailing)
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

