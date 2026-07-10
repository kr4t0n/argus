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
