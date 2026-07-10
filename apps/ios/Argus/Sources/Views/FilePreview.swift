import SwiftUI
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
/// with a line-number gutter (and highlights/scrolls to the target
/// line); images and binaries keep their simple presentations. Like the
/// transcript's code blocks, no syntax highlighting yet.
struct FilePreviewSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let agent: AgentDTO
    let target: FilePreviewTarget

    @State private var result: FSReadResult?
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle((target.path as NSString).lastPathComponent)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
                .task {
                    guard let client = app.client else { return }
                    do {
                        result = try await client.readAgentFile(
                            agentId: agent.id, path: target.path
                        ).result
                    } catch {
                        app.handleAPIError(error)
                        loadError = (error as? APIError)?.message ?? error.localizedDescription
                    }
                }
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
            TextFileView(content: content, targetLine: target.line)
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

/// Monospaced text with a line-number gutter. Lines wrap (mobile beats
/// horizontal scrolling); the target line gets the web viewer's
/// amber-ish highlight and is centered on open.
private struct TextFileView: View {
    let content: String
    let targetLine: Int?

    private var lines: [String] {
        content.components(separatedBy: "\n")
    }

    var body: some View {
        let lines = self.lines
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(lines.indices, id: \.self) { index in
                        HStack(alignment: .top, spacing: 10) {
                            Text("\(index + 1)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .frame(width: 42, alignment: .trailing)
                            Text(lines[index].isEmpty ? " " : lines[index])
                                .font(.system(size: 12, design: .monospaced))
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
