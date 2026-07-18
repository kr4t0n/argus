import SwiftUI
import PhotosUI
import UIKit
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
    /// Composer pill highlighted as a drop target.
    @State private var dropTargeted = false
    /// Monotonic counter naming dropped payloads (they arrive nameless).
    @State private var droppedCount = 0
    @State private var showAttachmentDialog = false
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var photoSelection: [PhotosPickerItem] = []

    // Toolbar sheets/alerts.
    @State private var showModelPicker = false
    @State private var showRename = false
    @State private var renameText = ""

    /// File preview opened from a chip or a path:line answer link.
    @State private var filePreview: FilePreviewTarget?
    /// Full-size viewer for a turn's uploaded attachment.
    @State private var attachmentPreview: AttachmentDTO?
    /// Turns with their activity timeline expanded — lifted out of the
    /// cells because the pinned band (capsule) and the scrolling body
    /// (timeline) are separate views of the same turn.
    @State private var expandedActivity: Set<String> = []

    private var session: SessionDTO? { app.sessionList.sessions[sessionId] }
    /// Project addressing for file previews; nil for workdir-less
    /// sessions (previews are disabled there).
    private var projectRef: ProjectRef? { app.fleet.projectRef(for: session) }
    /// The session's pinned workingDir, resolved through its project.
    private var workingDir: String? { projectRef?.workingDir }
    /// Adapter type keying the transcript parsers: pinned on the session
    /// since Phase 1 (the Agent entity that used to back-fill this is
    /// retired).
    private var agentType: AgentType {
        session?.cliType ?? "custom"
    }

    var body: some View {
        VStack(spacing: 0) {
            ConnectionBanner()
            transcript
            composer
        }
        // Opaque cover for the under-bar strip. Pinned section headers
        // defeat the bar's scroll-edge appearance (and forcing
        // toolbarBackground(.visible) proved unreliable in the split
        // view's detail column), so scrolled content from previous
        // turns was readable behind the title. This strip lives in the
        // CONTENT layer: exactly safe-area-top tall, offset up over the
        // bar region — scrolled content slides under it, while the bar's
        // own chrome (title, buttons) draws above it.
        .overlay(alignment: .top) {
            GeometryReader { geo in
                Color(.systemBackground)
                    .frame(width: geo.size.width, height: geo.safeAreaInsets.top)
                    .offset(y: -geo.safeAreaInsets.top)
                    .allowsHitTesting(false)
            }
            .frame(height: 0)
        }
        .navigationTitle(session?.title ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        // Keep the forced bar background too — over the opaque strip it
        // contributes the standard hairline separator.
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { toolbarContent }
        .sheet(isPresented: $showModelPicker) {
            if let session {
                ModelPickerSheet(session: session)
            }
        }
        .sheet(item: $filePreview) { previewTarget in
            if let projectRef {
                FilePreviewSheet(project: projectRef, target: previewTarget)
            }
        }
        .sheet(item: $attachmentPreview) { attachment in
            AttachmentPreviewSheet(
                attachment: attachment,
                url: app.client?.absoluteURL(for: attachment.url)
            )
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
            // Re-runs on every appearance, not just the first: start()
            // is idempotent (re-join room + revalidate), which both
            // serves cache re-opens and restores room membership after
            // a disappear/reappear of the same view identity.
            if model == nil {
                model = app.sessionViewModel(
                    for: sessionId,
                    agentType: agentType
                )
            }
            guard let model else { return }
            app.activeSession = model
            app.sessionList.markSeenLocally(id: sessionId)
            await model.start()
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
                    UsageBadge(
                        usage: model.usage,
                        context: model.context,
                        // /compact is a REAL client-side command only on
                        // claude-code (codex/cursor print modes role-play
                        // a fake "Compacted." reply — verified against
                        // both binaries), and it can't overlap a turn.
                        onCompact: session?.cliType == KnownAgentType.claudeCode
                            && model.isRunning != true
                            ? { app.submitPrompt(
                                sessionId: sessionId, text: "/compact", attachmentIds: []
                              ) }
                            : nil
                    )
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
                    if session?.archivedAt != nil {
                        Button("Unarchive", systemImage: "arrow.uturn.backward") { unarchive() }
                    } else {
                        Button("Archive", systemImage: "archivebox") { archive() }
                    }
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

    private func unarchive() {
        guard let client = app.client else { return }
        Task {
            do {
                app.sessionList.upsert(try await client.unarchiveSession(id: sessionId))
            } catch {
                app.handleAPIError(error)
            }
        }
    }

    /// Open a preview for a raw tool/citation path — only when it
    /// resolves inside the session's workspace (the sidecar rejects
    /// reads outside its jail).
    private func openFilePreview(_ rawPath: String, line: Int?) {
        guard let relative = FileReferences.toAgentRelative(rawPath, workingDir: workingDir) else {
            return
        }
        filePreview = FilePreviewTarget(
            path: relative,
            displayPath: FileReferences.displayPath(rawPath, workingDir: workingDir),
            line: line
        )
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

    // MARK: Activity expansion (sticky-band scroll snap)

    private func bandAnchor(_ turnId: String) -> String {
        "band-" + turnId
    }

    private func activityToggleBinding(_ turnId: String, proxy: ScrollViewProxy) -> Binding<Bool> {
        Binding(
            get: { expandedActivity.contains(turnId) },
            set: { _ in toggleActivity(turnId, proxy: proxy) }
        )
    }

    /// Web parity (StreamViewer's handleActivityToggle): on toggle, snap
    /// this turn's band to the top of the scrollport — expanding lands
    /// you at the tool list, collapsing doesn't strand you mid-body.
    /// Skipped while browsing history (not near the live edge), where a
    /// snap would yank the view to a turn the user didn't ask for.
    private func toggleActivity(_ turnId: String, proxy: ScrollViewProxy) {
        if expandedActivity.contains(turnId) {
            expandedActivity.remove(turnId)
        } else {
            expandedActivity.insert(turnId)
        }
        guard nearBottom else { return }
        Task { @MainActor in
            // Let the timeline mount/unmount commit before scrolling.
            try? await Task.sleep(for: .milliseconds(60))
            withAnimation(.easeOut(duration: 0.15)) {
                proxy.scrollTo(bandAnchor(turnId), anchor: .top)
            }
        }
    }

    // MARK: Transcript

    @ViewBuilder
    private var transcript: some View {
        if let model {
            ScrollViewReader { proxy in
                ScrollView {
                    // Sticky turn bands (web parity): each turn is a
                    // Section whose pinned header carries the user
                    // message + activity capsule, so scrolling through a
                    // long turn keeps "what is the agent doing" visible.
                    // Spacing is 0 — the inter-turn gap lives inside the
                    // band's opaque background.
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        historyHeader(model)
                        ForEach(model.turns) { turn in
                            Section {
                                TurnBody(
                                    turn: turn,
                                    workingDir: workingDir,
                                    timelineExpanded: expandedActivity.contains(turn.id),
                                    onFork: { fork(from: turn) },
                                    onOpenFile: { path, line in openFilePreview(path, line: line) }
                                )
                            } header: {
                                TurnBand(
                                    turn: turn,
                                    attachmentURL: { app.client?.absoluteURL(for: $0.url) },
                                    expanded: activityToggleBinding(turn.id, proxy: proxy),
                                    onFork: { fork(from: turn) },
                                    onOpenAttachment: { attachmentPreview = $0 }
                                )
                                .id(bandAnchor(turn.id))
                            }
                        }
                        // Bottom sentinel: its visibility IS the
                        // "pinned to bottom" signal for stickiness.
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                            .onAppear { nearBottom = true }
                            .onDisappear { nearBottom = false }
                    }
                    .padding(.horizontal)
                    .padding(.bottom)
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
                .onAppear {
                    // Cache re-open: the transcript is populated on the
                    // first frame, so the empty→non-empty trigger above
                    // never fires — land at the live edge explicitly.
                    // (Cold opens mount with zero turns and skip this.)
                    guard !model.turns.isEmpty else { return }
                    Task { @MainActor in
                        // Let the LazyVStack lay out before scrolling.
                        try? await Task.sleep(for: .milliseconds(60))
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
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
        }
        // EXACTLY the transcript rows' geometry (pad INSIDE the 720
        // cap, same 16pt) so the pill's edges line up with the text
        // column at every window width — capping first and padding
        // outside left the pill wider than the chat area.
        .padding(.horizontal)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
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
                // Hardware-keyboard Enter sends, Shift+Enter newlines —
                // the web Composer's onKeyDown rule, for the iPad
                // Magic-Keyboard flow. onKeyPress sees only hardware
                // events, so the on-screen return key still inserts a
                // newline. Web parity details: an unmodified Return is
                // ALWAYS swallowed (send() no-ops via canSend when
                // there's nothing to send — Enter never newlines), any
                // modifier falls through (Shift+Return → the field's
                // newline; ⌘↩ → the send button's shortcut), and Return
                // mid-IME-composition confirms the marked text instead
                // of sending (the web's isComposing guard).
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.isEmpty else { return .ignored }
                    guard !ComposerKeyboard.isComposingMarkedText else { return .ignored }
                    send()
                    return .handled
                }

                if model?.isRunning == true {
                    // Web order: add-to-queue (only when there's content)
                    // on the LEFT, then the stop button on the RIGHT.
                    if hasContent {
                        primaryButton(symbol: "text.badge.plus")
                    }
                    Button {
                        Task { await model?.cancelRunningTurn() }
                    } label: {
                        // Subtle (surface-2) square, NOT red — matches the
                        // web's `variant="subtle"` cancel button.
                        Image(systemName: "square.fill")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.primary)
                            .frame(width: 32, height: 32)
                            .background(Circle().fill(Color.surface2))
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(".", modifiers: .command)
                } else {
                    primaryButton(symbol: "arrow.up")
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.surface1, in: RoundedRectangle(cornerRadius: 24))
        // Drag a screenshot/file onto the pill (iPad Split View flow).
        .dropDestination(for: Data.self) { items, _ in
            handleDrop(items)
        } isTargeted: { targeted in
            dropTargeted = targeted
        }
        .overlay(
            RoundedRectangle(cornerRadius: 24)
                .strokeBorder(Color.accentColor, lineWidth: 2)
                .opacity(dropTargeted ? 1 : 0)
        )
        .animation(.easeOut(duration: 0.12), value: dropTargeted)
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

        if let thumbnail = attachment.thumbnail {
            // Instant local preview from the bytes we just uploaded —
            // no server round-trip (web object-URL parity).
            Image(uiImage: thumbnail)
                .resizable()
                .scaledToFill()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(.separator)))
                .overlay(alignment: .topTrailing) { remove }
        } else if attachment.isImage, let url = attachment.url.flatMap({ app.client?.absoluteURL(for: $0) }) {
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

    /// Something to send/queue: text or a ready attachment.
    private var hasContent: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !pendingAttachments.isEmpty
    }

    private var canSend: Bool {
        model != nil && uploadsInFlight == 0 && hasContent
    }

    /// The primary circular action button (send when idle, add-to-queue
    /// while running) — white on dark, disabled when there's nothing to
    /// send.
    private func primaryButton(symbol: String) -> some View {
        Button(action: send) {
            Group {
                if uploadsInFlight > 0 {
                    ProgressView().controlSize(.small).tint(Color(.systemBackground))
                } else {
                    Image(systemName: symbol).font(.system(size: 15, weight: .bold))
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
                // Local thumbnail from the bytes in hand (nil for
                // non-images — UIImage init just fails).
                let thumbnail = await UIImage(data: data)?
                    .byPreparingThumbnail(ofSize: CGSize(width: 112, height: 112))
                let attachment = try await client.uploadAttachment(
                    filename: name, mime: mime, data: data
                )
                pendingAttachments.append(UploadedAttachment(
                    id: attachment.id,
                    filename: attachment.filename,
                    isImage: attachment.mime.hasPrefix("image/"),
                    url: attachment.url,
                    thumbnail: thumbnail
                ))
            } catch {
                app.handleAPIError(error)
                model?.actionError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }

    // MARK: Drag & drop (iPad Split View: drag a screenshot straight in)

    /// Raw dropped payloads arrive as Data with no filename — sniff the
    /// type from magic bytes and synthesize a name.
    private func handleDrop(_ items: [Data]) -> Bool {
        guard model != nil, !items.isEmpty else { return false }
        for data in items {
            droppedCount += 1
            let (ext, mime) = Self.sniffType(data)
            upload(name: "dropped-\(droppedCount).\(ext)", mime: mime) { data }
        }
        return true
    }

    private static func sniffType(_ data: Data) -> (ext: String, mime: String) {
        if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return ("png", "image/png") }
        if data.starts(with: [0xFF, 0xD8, 0xFF]) { return ("jpg", "image/jpeg") }
        if data.starts(with: [0x47, 0x49, 0x46, 0x38]) { return ("gif", "image/gif") }
        if data.starts(with: [0x25, 0x50, 0x44, 0x46]) { return ("pdf", "application/pdf") }
        // ISO-BMFF (HEIC/HEIF): "ftyphei*"/"ftypmif1" at offset 4.
        if data.count > 12 {
            let brand = data.subdata(in: 4..<12)
            if let text = String(data: brand, encoding: .ascii),
               text.hasPrefix("ftyphei") || text.hasPrefix("ftypmif") {
                return ("heic", "image/heic")
            }
        }
        return ("bin", "application/octet-stream")
    }
}

private struct UploadedAttachment: Identifiable, Equatable {
    let id: String
    let filename: String
    let isImage: Bool
    /// API-relative tokenized URL for the composer thumbnail preview.
    let url: String?
    /// Local thumbnail generated from the picked/dropped bytes — instant
    /// like the web's object-URL previews; `url`/AsyncImage is only the
    /// fallback. Deliberately not part of what survives queueing.
    let thumbnail: UIImage?

    static func == (lhs: UploadedAttachment, rhs: UploadedAttachment) -> Bool {
        lhs.id == rhs.id
    }
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

/// The pinned per-turn band — user message (attachments + prompt) and
/// the activity capsule, i.e. the web's sticky band. Rendered as a
/// pinned section header; inter-turn spacing lives INSIDE its opaque
/// background so no uncovered sliver shows while body content slides
/// beneath it.
private struct TurnBand: View {
    let turn: Turn
    let attachmentURL: (AttachmentDTO) -> URL?
    @Binding var expanded: Bool
    let onFork: () -> Void
    /// Tap on an uploaded-attachment thumbnail/pill → full-size viewer.
    let onOpenAttachment: (AttachmentDTO) -> Void

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

            if !turn.timeline.isEmpty {
                ActivityCapsule(turn: turn, expanded: $expanded)
            }
        }
        .padding(.top, 20)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemBackground))
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
                    Button {
                        onOpenAttachment(attachment)
                    } label: {
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
                    .buttonStyle(.plain)
                }
            }
            .padding(.leading, 40)
        }
        .defaultScrollAnchor(.trailing)
    }
}

/// The scrolling remainder of a turn — panels, expanded timeline,
/// answer, file chips, error — the section content that slides under
/// the pinned band. Web order: panels stay on top of the expanded
/// tool list.
private struct TurnBody: View {
    let turn: Turn
    let workingDir: String?
    let timelineExpanded: Bool
    let onFork: () -> Void
    /// (raw path, optional line) — from FileChips or path:line links.
    let onOpenFile: (String, Int?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let todos = turn.todos {
                TodoWindow(todos: todos)
            }
            if !turn.subAgents.isEmpty {
                SubAgentWindow(calls: turn.subAgents)
            }

            if !turn.timeline.isEmpty, timelineExpanded {
                ActivityTimeline(turn: turn)
            }

            if !turn.answer.isEmpty {
                AnswerView(markdown: turn.answer, isStreaming: turn.isRunning)
                    // Route `path:line` citations (and plain file-path
                    // links) into the file preview; real URLs pass
                    // through to the system. Mirrors the web's
                    // fileLinkUrlTransform + a-renderer gotcha pair.
                    .environment(\.openURL, OpenURLAction { url in
                        handleAnswerLink(url)
                    })
                    .contextMenu {
                        Button("Copy answer", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = turn.answer
                        }
                        Button("Fork from this turn", systemImage: "arrow.branch") {
                            onFork()
                        }
                    }
            } else if turn.isRunning, turn.timeline.isEmpty, turn.todos == nil, turn.subAgents.isEmpty {
                // Only before ANY activity streams — once the pill or a
                // panel has content, that conveys progress.
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Working…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            // Files the agent touched — after the answer, like the web.
            if !turn.touchedFiles.isEmpty {
                FileChipsRow(
                    files: turn.touchedFiles,
                    workingDir: workingDir,
                    onOpen: onOpenFile
                )
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
        .padding(.top, 4)
    }

    /// The web's two-layer gotcha, in OpenURLAction form: (1) a real
    /// scheme (http/https/mailto) goes to the system — this keeps
    /// `http://localhost:3000` a browser link; (2) anything else is
    /// tried as a `path[:line[:col]]` citation — note `xxx.txt:1`
    /// parses as URL scheme "xxx.txt", which is exactly why the check
    /// can't just be "has a scheme".
    private func handleAnswerLink(_ url: URL) -> OpenURLAction.Result {
        let scheme = url.scheme?.lowercased()
        if scheme == "http" || scheme == "https" || scheme == "mailto" {
            return .systemAction
        }
        let raw = url.absoluteString.removingPercentEncoding ?? url.absoluteString
        let split = FileReferences.splitLineSuffix(raw)
        // File-ish only (contains . or /) — bare words stay inert
        // rather than opening a garbage preview.
        guard split.path.contains("/") || split.path.contains(".") else {
            return .discarded
        }
        onOpenFile(split.path, split.line)
        return .handled
    }
}

private struct PromptBubble: View {
    let text: String

    /// Web parity (UserMessage's max-h-24 + inner scroll + fade): long
    /// pasted prompts cap instead of dominating the transcript — extra
    /// important here because the bubble lives in the PINNED band, so
    /// an uncapped prompt would pin itself over everything.
    private let maxHeight: CGFloat = 116
    @State private var textHeight: CGFloat = 0

    private var overflows: Bool { textHeight > maxHeight }

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            bubble
                // Neutral surface bubble, NOT blue — the web's exact
                // pick: bg-surface-1 on light, surface-2/80 on dark
                // (solid surface2 read one step too dark on light).
                // Applied OUTSIDE the fade mask so only the text fades,
                // not the bubble itself.
                .background(
                    colorScheme == .dark ? Color.surface2.opacity(0.8) : Color.surface1,
                    in: RoundedRectangle(cornerRadius: 16)
                )
        }
        .onPreferenceChange(PromptHeightKey.self) { textHeight = $0 }
    }

    @ViewBuilder
    private var bubble: some View {
        if overflows {
            ScrollView {
                innerText
            }
            .frame(height: maxHeight)
            .mask(fadeMask)
        } else {
            innerText
        }
    }

    private var innerText: some View {
        Text(text)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .textSelection(.enabled)
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: PromptHeightKey.self, value: geo.size.height)
                }
            )
    }

    /// Solid through the body, fading out over the last ~22pt — the
    /// web's "there's more, scroll" affordance.
    private var fadeMask: some View {
        VStack(spacing: 0) {
            Rectangle()
            LinearGradient(
                colors: [.black, .clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 22)
        }
    }
}

private struct PromptHeightKey: PreferenceKey {
    static var defaultValue: CGFloat { 0 }
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// The composer's stand-in for the web's `isComposing` guard: while an
/// IME has marked text active (CJK composition), hardware Return must
/// confirm the candidate, never send. SwiftUI doesn't surface marked
/// text, so ask UIKit — walk to the first responder and check its
/// `markedTextRange` (public API; the composer's backing field IS the
/// first responder whenever a key press reaches onKeyPress).
@MainActor
enum ComposerKeyboard {
    static var isComposingMarkedText: Bool {
        guard let input = firstResponder() as? UITextInput else { return false }
        return input.markedTextRange != nil
    }

    private static func firstResponder() -> UIResponder? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                if let responder = findFirstResponder(in: window) { return responder }
            }
        }
        return nil
    }

    private static func findFirstResponder(in view: UIView) -> UIResponder? {
        if view.isFirstResponder { return view }
        for subview in view.subviews {
            if let responder = findFirstResponder(in: subview) { return responder }
        }
        return nil
    }
}

