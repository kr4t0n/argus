import SwiftUI
import WebKit
import Highlightr
import ArgusKit

/// What to preview: an agent-relative path (the form fs/read accepts),
/// a display title, and an optional line to scroll to + highlight
/// (from a `path:line` citation).
struct FilePreviewTarget: Identifiable, Equatable {
    let path: String
    let displayPath: String
    let line: Int?

    var id: String { "\(path):\(line ?? 0)" }
}

/// The shared file viewer — used by the inspector's Files browser, the
/// per-turn FileChips, and `path:line` links in answers. Text renders
/// with a line-number gutter, syntax highlighting (Highlightr — the
/// iOS stand-in for the web's shiki), and target-line scroll/highlight;
/// `.html` files get a rendered preview with a Source toggle (strictly
/// script-less, matching the web FileViewer's inert `sandbox=""`).
struct FilePreviewSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    /// Project addressing — fs/read is project-addressed since the
    /// runner refactor, so previews keep working when the session's
    /// agent row is gone.
    let project: ProjectRef
    let target: FilePreviewTarget

    private enum HtmlMode: String, CaseIterable {
        case preview = "Preview"
        case source = "Source"
    }

    @State private var result: FSReadResult?
    @State private var loadError: String?
    @State private var htmlMode: HtmlMode = .preview
    /// Coalesces a burst of nudges into one re-read; cancelled and
    /// replaced while the window is open, and on dismiss.
    @State private var refreshTask: Task<Void, Never>?

    /// Trailing window for coalescing `fs:changed` nudges, on top of the
    /// sidecar's own 250 ms fsWatcher debounce — so a long edit loop
    /// settles into one re-read instead of tracking the agent's write
    /// rate. Matches the web client's INVALIDATE_DEBOUNCE_MS.
    private static let refreshDebounce = Duration.milliseconds(400)

    private var fileExtension: String {
        (target.path as NSString).pathExtension.lowercased()
    }

    /// Directory the previewed file sits in, workingDir-relative. `""`
    /// for a root-level file — matching how the sidecar names the watched
    /// root, and NOT the "." a naive path API would hand back.
    private var targetDirectory: String {
        let parent = (target.path as NSString).deletingLastPathComponent
        return parent == "." ? "" : parent
    }

    private var isHTMLFile: Bool {
        fileExtension == "html" || fileExtension == "htm"
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle((target.path as NSString).lastPathComponent)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if case .text(let content, _) = result {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Copy", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = content
                            }
                        }
                    }
                    if isHTMLFile, case .text = result {
                        ToolbarItem(placement: .principal) {
                            Picker("Mode", selection: $htmlMode) {
                                ForEach(HtmlMode.allCases, id: \.self) { Text($0.rawValue) }
                            }
                            .pickerStyle(.segmented)
                            .frame(maxWidth: 220)
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
                .task { await load(isRefresh: false) }
                // Hold the project room for as long as the sheet is up.
                // The inspector holds it too when the preview is opened
                // from the Files browser — but a preview opened from a
                // chat citation or FileChip can have the inspector
                // closed, in which case nothing else is subscribed and no
                // nudge would ever arrive. StreamClient refcounts, so the
                // overlapping case is safe.
                .onAppear {
                    app.stream?.joinProject(
                        machineId: project.machineId, workingDir: project.workingDir
                    )
                }
                .onDisappear {
                    refreshTask?.cancel()
                    refreshTask = nil
                    app.stream?.leaveProject(
                        machineId: project.machineId, workingDir: project.workingDir
                    )
                }
                // Watch the SEQ and read the BATCH: repeat writes to one
                // directory are Equatable-identical and `.onChange` would
                // swallow every one after the first — which is exactly
                // the case that matters here (see AppModel.fsChanges).
                .onChange(of: app.fsChangeSeq) { scheduleRefresh() }
        }
    }

    /// Read the file into `result`.
    ///
    /// A refresh deliberately does NOT clear `result` first: the reader
    /// is looking at this file, and dropping to a spinner every time an
    /// agent touches its directory would be worse than the staleness
    /// being fixed. A refresh that fails likewise keeps the last good
    /// render — an atomic write-then-rename leaves a window where the
    /// path briefly doesn't resolve, and that must not blow away a
    /// readable file. A cold load still surfaces its error; there's
    /// nothing else to show then.
    @MainActor
    private func load(isRefresh: Bool) async {
        guard let client = app.client else { return }
        do {
            let fresh = try await client.readProjectFile(
                projectId: project.projectId, path: target.path
            ).result
            result = fresh
            loadError = nil
        } catch {
            guard !isRefresh else { return }
            app.handleAPIError(error)
            loadError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Debounce a nudge into a re-read, if it names this file's project
    /// and directory. `fs:changed` is directory-granular (the sidecar
    /// drops the filename), so a sibling write re-reads too — accepted,
    /// since only one preview is ever open.
    @MainActor
    private func scheduleRefresh() {
        let touchesThisFile = app.fsChanges.contains { change in
            guard let workingDir = change.workingDir, !workingDir.isEmpty else { return false }
            return change.machineId == project.machineId
                && workingDir == project.workingDir
                && change.path == targetDirectory
        }
        guard touchesThisFile else { return }

        // Do NOT restart an open window. A trailing debounce that resets
        // on every nudge never fires while an agent is actively editing:
        // the sidecar emits roughly every 250 ms and this window is
        // 400 ms, so each nudge would cancel the pending read and the
        // refresh would only land once editing STOPPED — which reads as
        // "auto-refresh doesn't work". The web's schedule() early-returns
        // for exactly this reason; this port originally didn't, and that
        // divergence was the bug.
        guard refreshTask == nil else { return }
        refreshTask = Task {
            try? await Task.sleep(for: Self.refreshDebounce)
            guard !Task.isCancelled else { return }
            // Cleared BEFORE the read so a nudge arriving during it can
            // open the next window rather than being swallowed.
            refreshTask = nil
            await load(isRefresh: true)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch result {
        case .none:
            if let loadError {
                ContentUnavailableView(
                    "Couldn't read file",
                    systemImage: "exclamationmark.triangle",
                    description: Text(loadError)
                )
            } else {
                ProgressView()
            }
        case .text(let content, _):
            if isHTMLFile, htmlMode == .preview {
                StaticHtmlView(html: content)
                    .ignoresSafeArea(edges: .bottom)
            } else {
                TextFileView(
                    content: content,
                    language: CodeHighlighter.language(forExtension: fileExtension),
                    targetLine: target.line
                )
            }
        case .image(_, let base64, _):
            if let data = Data(base64Encoded: base64),
               let image = UIImage(data: data) {
                ScrollView {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                }
            } else {
                ContentUnavailableView("Couldn't decode image", systemImage: "photo")
            }
        case .binary(let size):
            ContentUnavailableView(
                "Binary file",
                systemImage: "doc.zipper",
                description: Text(TokenFormat.bytes(size))
            )
        case .unsupported(let kind):
            ContentUnavailableView(
                "Unsupported viewer (\(kind))",
                systemImage: "doc.questionmark"
            )
        }
    }
}

// MARK: - Text (line numbers + syntax highlighting)

/// Monospaced text with a line-number gutter. Renders plain lines
/// immediately, then swaps in Highlightr-colored lines when the
/// off-main highlight pass completes. Lines wrap (mobile beats
/// horizontal scrolling); the target line gets an amber highlight and
/// is centered on open.
private struct TextFileView: View {
    let content: String
    let language: String?
    let targetLine: Int?

    @Environment(\.colorScheme) private var colorScheme
    @State private var highlightedLines: [AttributedString]?
    /// Topmost visible line (1-based, matching the row `.id`s). Declaring
    /// it is what lets the scroll view hold its place when `content` is
    /// replaced by a live refresh — without it a re-read snaps the reader
    /// back to line 1 on every agent write.
    @State private var topLine: Int?

    /// What a highlight pass depends on. Re-highlighting is driven by
    /// `.task(id:)` on this rather than a bare `.task` (appear-only,
    /// which would leave the OLD file's colors applied to new content
    /// after a refresh) plus a separate colorScheme observer — one path
    /// for both inputs.
    private struct HighlightKey: Equatable, Sendable {
        let content: String
        let dark: Bool
    }

    private var plainLines: [String] {
        content.components(separatedBy: "\n")
    }

    var body: some View {
        let lines = plainLines
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines.indices, id: \.self) { index in
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(index + 1)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .frame(width: 42, alignment: .trailing)
                            lineText(at: index, plain: lines)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 1)
                        .background(
                            targetLine == index + 1 ? Color.yellow.opacity(0.22) : Color.clear
                        )
                        .id(index + 1)
                    }
                }
                .padding(.vertical, 10)
                .padding(.trailing, 12)
                // Required companion of `.scrollPosition(id:)` — it marks
                // the rows as the things whose identity the scroll view
                // tracks. Not a snapping behaviour (that needs
                // `.scrollTargetBehavior`), so scrolling still feels free.
                .scrollTargetLayout()
            }
            .scrollPosition(id: $topLine, anchor: .top)
            .task(id: HighlightKey(content: content, dark: colorScheme == .dark)) {
                // Drop the previous pass first: content and highlight are
                // two separate arrays here, so holding the old colors over
                // new text is a real mismatch, not just stale styling.
                // Costs a brief plain-text moment on refresh.
                highlightedLines = nil
                highlightedLines = await CodeHighlighter.highlightLines(
                    content,
                    language: language,
                    dark: colorScheme == .dark,
                    expectedLineCount: lines.count
                )
            }
            .task {
                guard let targetLine, targetLine <= lines.count else { return }
                // Give LazyVStack a beat to estimate heights before the
                // long-distance jump.
                try? await Task.sleep(for: .milliseconds(80))
                proxy.scrollTo(targetLine, anchor: .center)
            }
        }
    }

    @ViewBuilder
    private func lineText(at index: Int, plain: [String]) -> some View {
        if let highlightedLines, index < highlightedLines.count {
            Text(highlightedLines[index])
        } else {
            Text(plain[index].isEmpty ? " " : plain[index])
                .font(.system(size: 12, design: .monospaced))
        }
    }
}

/// Highlightr wrapper — extension→language mapping, size caps, and the
/// per-line split the gutter layout needs.
enum CodeHighlighter {
    /// Beyond this, highlight.js gets slow enough to hurt — plain text
    /// is the better experience (fs/read itself caps files at 1 MiB).
    private static let maxHighlightBytes = 300_000
    private static let maxHighlightLines = 8_000

    private static let extensionToLanguage: [String: String] = [
        "swift": "swift", "ts": "typescript", "tsx": "typescript",
        "js": "javascript", "jsx": "javascript", "mjs": "javascript",
        "py": "python", "go": "go", "rs": "rust", "rb": "ruby",
        "java": "java", "kt": "kotlin", "c": "c", "h": "c",
        "cpp": "cpp", "cc": "cpp", "hpp": "cpp", "cs": "csharp",
        "m": "objectivec", "mm": "objectivec",
        "sh": "bash", "bash": "bash", "zsh": "bash",
        "yml": "yaml", "yaml": "yaml", "json": "json", "toml": "ini",
        "xml": "xml", "html": "xml", "htm": "xml", "svg": "xml",
        "css": "css", "scss": "scss", "md": "markdown",
        "sql": "sql", "prisma": "graphql", "proto": "protobuf",
        "dockerfile": "dockerfile", "makefile": "makefile",
    ]

    static func language(forExtension ext: String) -> String? {
        extensionToLanguage[ext]
    }

    /// Off-main highlight → one AttributedString per line (padded/
    /// truncated to the plain split's count so indices always align).
    /// nil = don't highlight (unknown language / too big / failure);
    /// the view keeps its plain rendering.
    static func highlightLines(
        _ code: String,
        language: String?,
        dark: Bool,
        expectedLineCount: Int
    ) async -> [AttributedString]? {
        guard let language,
              code.utf8.count <= maxHighlightBytes,
              expectedLineCount <= maxHighlightLines
        else { return nil }

        return await Task.detached(priority: .userInitiated) { () -> [AttributedString]? in
            guard let highlightr = Highlightr() else { return nil }
            highlightr.setTheme(to: dark ? "atom-one-dark" : "atom-one-light")
            highlightr.theme.setCodeFont(
                UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
            )
            guard let highlighted = highlightr.highlight(code, as: language) else {
                return nil
            }

            // Split the attributed run at newlines, preserving styling.
            var lines: [AttributedString] = []
            lines.reserveCapacity(expectedLineCount)
            let full = highlighted.string as NSString
            var location = 0
            while location <= full.length {
                let newline = full.range(
                    of: "\n",
                    range: NSRange(location: location, length: full.length - location)
                )
                let end = newline.location == NSNotFound ? full.length : newline.location
                let lineRange = NSRange(location: location, length: end - location)
                let attributed = highlighted.attributedSubstring(from: lineRange)
                lines.append(AttributedString(attributed))
                if newline.location == NSNotFound { break }
                location = newline.location + 1
            }
            // Trailing "\n" yields one more visual line in the plain
            // split; pad so indices align.
            while lines.count < expectedLineCount {
                lines.append(AttributedString(" "))
            }
            return lines
        }.value
    }
}

// MARK: - HTML preview (.html files)

/// Rendered HTML for remote-tree files — strictly SCRIPT-LESS, the
/// WKWebView analogue of the web FileViewer's `sandbox=""` posture:
/// remote file content stays fully inert (no JS, no navigation). This
/// is deliberately NOT the chat code-block preview (that one allows
/// scripts for model-generated Chart.js etc.).
private struct StaticHtmlView: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        // baseURL nil = opaque origin; no app/file resources reachable.
        webView.loadHTMLString(prepared(html), baseURL: nil)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedHTML: String?

        /// Belt-and-braces with JS off: block every navigation except
        /// the initial load, so links in the document go nowhere.
        /// The async form, deliberately: the handler-based signature's
        /// annotations (@MainActor/@Sendable on the decisionHandler)
        /// drift between SDK versions, and a mismatch silently demotes
        /// this from a witness to dead code ("nearly matches") — the
        /// sandbox would stop cancelling navigation.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            navigationAction.navigationType == .other ? .allow : .cancel
        }
    }

    /// Inject a device-width viewport so WKWebView doesn't lay out at
    /// its 980px desktop default (same fix as the chat HtmlWebView).
    private func prepared(_ raw: String) -> String {
        let viewport = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        if let headStart = raw.range(of: "<head", options: .caseInsensitive),
           let headClose = raw.range(of: ">", range: headStart.upperBound..<raw.endIndex) {
            var copy = raw
            copy.insert(contentsOf: viewport, at: headClose.upperBound)
            return copy
        }
        return "<html><head>\(viewport)</head><body>\(raw)</body></html>"
    }
}

/// Full-size viewer for a turn's uploaded attachment (the bytes live in
/// the object store, fetched via the DTO's tokenized URL — no agent
/// round-trip). Images pinch-zoom / double-tap; anything else downloads
/// and offers the system share sheet. Note the display token in
/// `AttachmentDTO.url` lives ~1h from transcript load — a very stale
/// session may need a pull-to-refresh before the fetch succeeds.
struct AttachmentPreviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let attachment: AttachmentDTO
    let url: URL?

    /// Temp-file copy for non-image attachments, for ShareLink.
    @State private var exportURL: URL?
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                if attachment.mime.hasPrefix("image/"), let url {
                    ZoomableAsyncImage(url: url)
                } else {
                    filePresentation
                }
            }
            .navigationTitle(attachment.filename)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private var filePresentation: some View {
        VStack(spacing: 14) {
            Image(systemName: "doc")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text(attachment.filename).font(.headline)
            Text("\(attachment.mime) · \(TokenFormat.bytes(attachment.size))")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let exportURL {
                ShareLink(item: exportURL) {
                    Label("Share / save", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.bordered)
            } else if let loadError {
                Text(loadError).font(.caption).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .task {
            guard exportURL == nil, let url else { return }
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                let destination = FileManager.default.temporaryDirectory
                    .appendingPathComponent(attachment.filename)
                try data.write(to: destination)
                exportURL = destination
            } catch {
                loadError = error.localizedDescription
            }
        }
    }
}

/// Pinch-to-zoom + drag + double-tap image — deliberately simple (no
/// UIScrollView bridging) but enough to read a screenshot.
private struct ZoomableAsyncImage: View {
    let url: URL

    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var drag: CGSize = .zero

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale * pinch)
                    .offset(
                        x: offset.width + drag.width,
                        y: offset.height + drag.height
                    )
                    .gesture(
                        MagnifyGesture()
                            .updating($pinch) { value, state, _ in
                                state = value.magnification
                            }
                            .onEnded { value in
                                scale = min(6, max(1, scale * value.magnification))
                                if scale == 1 { offset = .zero }
                            }
                    )
                    .simultaneousGesture(
                        DragGesture()
                            .updating($drag) { value, state, _ in
                                if scale > 1 { state = value.translation }
                            }
                            .onEnded { value in
                                if scale > 1 {
                                    offset.width += value.translation.width
                                    offset.height += value.translation.height
                                }
                            }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(.easeOut(duration: 0.2)) {
                            if scale > 1 {
                                scale = 1
                                offset = .zero
                            } else {
                                scale = 2.5
                            }
                        }
                    }
            case .failure:
                ContentUnavailableView(
                    "Couldn't load image",
                    systemImage: "photo",
                    description: Text("The attachment link may have expired — pull the session to refresh.")
                )
            default:
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
    }
}

/// The per-turn "files the agent touched" strip — port of the web's
/// FileChips. A chip opens the preview when the path resolves inside
/// the agent's workspace; outside-workspace paths render inert (the
/// sidecar would reject the read), still showing their absolute form.
struct FileChipsRow: View {
    let files: [String]
    let workingDir: String?
    /// (raw path, line — always nil from chips)
    let onOpen: (String, Int?) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(files, id: \.self) { file in
                    chip(for: file)
                }
            }
        }
    }

    @ViewBuilder
    private func chip(for file: String) -> some View {
        let interactive = FileReferences.toAgentRelative(file, workingDir: workingDir) != nil
        Button {
            onOpen(file, nil)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "doc.text")
                    .font(.system(size: 10))
                Text(FileReferences.displayPath(file, workingDir: workingDir))
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 260, alignment: .leading)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.surface1.opacity(0.6), in: RoundedRectangle(cornerRadius: 7))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .disabled(!interactive)
        .opacity(interactive ? 1 : 0.55)
    }
}
