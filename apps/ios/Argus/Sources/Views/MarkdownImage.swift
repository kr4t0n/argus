import SwiftUI
import ArgusKit
import MarkdownUI

/// Inline rendering of `![alt](source)` in an assistant answer — the
/// iOS counterpart of the web's custom `img` renderer
/// (`apps/web/src/components/MarkdownImage.tsx`).
///
/// MarkdownUI's default provider hands every source to the network, so a
/// local path like `/tmp/shot.png` or `docs/preview.png` was a schemeless
/// URL that silently rendered as nothing. The file lives on the agent's
/// machine, so the only way to show it is the same fs/read RPC the file
/// preview uses — for paths that resolve INSIDE the workingDir. Anything
/// else renders as text: the sidecar's jail wouldn't serve it, and
/// widening that jail is a security decision, not a bug (AGENTS.md,
/// "Local images in answer markdown").
///
/// Two providers because MarkdownUI has two image paths: a paragraph
/// that is ONLY an image goes through `ImageProvider` (a full view —
/// placeholder, error text, tap-to-preview); an image inside a line of
/// text goes through `InlineImageProvider`, which must hand back a bare
/// `Image` for the text run.

/// Everything the providers need, built per turn by SessionView.
/// Sendable so it can live in a `static let` and ride the inline
/// provider (which MarkdownUI captures in a task group); the callback
/// is MainActor-isolated for that reason — it drives SwiftUI state.
struct MarkdownImageContext: Sendable {
    let client: ArgusClient?
    let project: ProjectRef?
    let workingDir: String?
    /// Cache-busting token — the turn's completion timestamp. An agent
    /// that regenerates `preview.png` next turn emits the same path, and
    /// without this the second turn would show the first turn's bytes.
    let epoch: String
    /// Open the file preview for a workspace-relative path (tap on a
    /// rendered image — the touch stand-in for the web's double-click).
    let onOpen: @MainActor (String) -> Void

    /// No project to fetch from: remote URLs still load, workspace
    /// paths render inert.
    static let detached = MarkdownImageContext(
        client: nil, project: nil, workingDir: nil, epoch: "live", onOpen: { _ in }
    )
}

/// Block-level images (an image alone in its paragraph, or an image
/// flow). `makeImage` receives only the URL — MarkdownUI applies the
/// alt text as an accessibility label itself and doesn't pass it here,
/// so the inert fallback shows the path rather than the web's alt text.
struct WorkspaceImageProvider: ImageProvider {
    let context: MarkdownImageContext

    @ViewBuilder
    func makeImage(url: URL?) -> some View {
        switch Self.classify(url, workingDir: context.workingDir) {
        case .remote(let remote):
            RemoteMarkdownImage(url: remote)
        case .workspace(let relative):
            if let project = context.project {
                WorkspaceMarkdownImage(
                    client: context.client,
                    project: project,
                    path: relative,
                    epoch: context.epoch,
                    onOpen: context.onOpen
                )
            } else {
                InertImageLabel(text: relative)
            }
        case .inert:
            InertImageLabel(text: Self.rawSource(url) ?? "image")
        }
    }

    /// MarkdownUI builds the URL with `URL(string:relativeTo: nil)`, so a
    /// path source comes back as a schemeless URL whose absoluteString
    /// is the original text (percent-encoded if Foundation had to).
    /// nil when the source didn't parse as a URL at all.
    static func rawSource(_ url: URL?) -> String? {
        guard let url else { return nil }
        return url.absoluteString.removingPercentEncoding ?? url.absoluteString
    }

    static func classify(_ url: URL?, workingDir: String?) -> MarkdownImageSource {
        guard let raw = rawSource(url) else { return .inert }
        return FileReferences.imageSource(raw, workingDir: workingDir)
    }
}

/// Images within a line of text. Never throws: MarkdownUI loads a
/// paragraph's inline images as one task group under a single `try?`,
/// so one thrown error drops EVERY inline image in that paragraph. A
/// placeholder glyph keeps the failure local to the one reference.
struct WorkspaceInlineImageProvider: InlineImageProvider, Sendable {
    let client: ArgusClient?
    let project: ProjectRef?
    let workingDir: String?
    let epoch: String

    init(context: MarkdownImageContext) {
        client = context.client
        project = context.project
        workingDir = context.workingDir
        epoch = context.epoch
    }

    func image(with url: URL, label: String) async throws -> Image {
        switch WorkspaceImageProvider.classify(url, workingDir: workingDir) {
        case .remote:
            return (try? await DefaultInlineImageProvider.default.image(with: url, label: label))
                ?? Self.placeholder
        case .workspace(let relative):
            guard let client, let project else { return Self.placeholder }
            let settled = await MarkdownImageCache.shared.load(
                client: client, projectId: project.projectId, path: relative, epoch: epoch
            )
            if case .ready(let image) = settled {
                return Image(uiImage: image)
            }
            return Self.placeholder
        case .inert:
            return Self.placeholder
        }
    }

    private static var placeholder: Image { Image(systemName: "photo") }
}

// MARK: - Cache

/// Settled fs/read outcomes, shared across every image view and both
/// providers. FAILURES are cached alongside successes — a path that
/// isn't a readable image fails the same way every time, and the web
/// learned the hard way that caching only successes re-issues a doomed
/// read on every re-render. (Trade-off: a transient failure — machine
/// offline — also sticks for that turn's epoch.)
///
/// Lock-guarded rather than actor-isolated so `cached(_:)` can be read
/// synchronously from a view body regardless of which SDK's `View.body`
/// isolation the toolchain assumes: that sync read is what keeps a
/// re-created image view from flashing its placeholder.
final class MarkdownImageCache: @unchecked Sendable {
    /// `@unchecked`: UIImage is immutable once created; the SDK's own
    /// Sendable annotation on it varies by version.
    enum Settled: @unchecked Sendable {
        case ready(UIImage)
        case error(String)
    }

    static let shared = MarkdownImageCache()

    /// fs/read caps a file at 1 MiB, so worst case is ~16 decoded
    /// screenshots held live; typical answers reference one or two.
    private static let maxCached = 16

    private let lock = NSLock()
    private var settled: [String: Settled] = [:]
    /// Insertion order for FIFO eviction — no access tracking needed.
    private var order: [String] = []
    private var inflight: [String: Task<Settled, Never>] = [:]

    static func key(projectId: String, path: String, epoch: String) -> String {
        "\(projectId)\u{0}\(path)\u{0}\(epoch)"
    }

    func cached(_ key: String) -> Settled? {
        lock.withLock { settled[key] }
    }

    /// Resolve one image, deduping concurrent first loads of the same
    /// key (the same image referenced twice in one answer, or the block
    /// and inline providers racing on it).
    func load(client: ArgusClient, projectId: String, path: String, epoch: String) async -> Settled {
        let key = Self.key(projectId: projectId, path: path, epoch: epoch)
        if let hit = cached(key) { return hit }

        let task: Task<Settled, Never> = lock.withLock {
            if let running = inflight[key] { return running }
            let started = Task { await Self.read(client: client, projectId: projectId, path: path) }
            inflight[key] = started
            return started
        }
        let result = await task.value

        lock.withLock {
            inflight[key] = nil
            if settled[key] == nil {
                settled[key] = result
                order.append(key)
                while order.count > Self.maxCached {
                    settled[order.removeFirst()] = nil
                }
            }
        }
        return result
    }

    private static func read(client: ArgusClient, projectId: String, path: String) async -> Settled {
        do {
            let result = try await client.readProjectFile(projectId: projectId, path: path).result
            // fs/read classifies by extension allowlist then content
            // sniff, so anything but `.image` means the path isn't a
            // renderable image.
            guard case .image(_, let base64, _) = result else {
                return .error("not an image file")
            }
            guard let data = Data(base64Encoded: base64), let image = UIImage(data: data) else {
                return .error("couldn't decode image")
            }
            // Decode off the render path once, rather than lazily on
            // first draw of every re-created view.
            return .ready(await image.byPreparingForDisplay() ?? image)
        } catch {
            // APIError carries the sidecar's own wording — "file is too
            // large to preview (…)" for an over-cap read, which is the
            // failure full-resolution screenshots hit most.
            return .error((error as? APIError)?.message ?? error.localizedDescription)
        }
    }
}

// MARK: - Views

/// One workspace image: fetch through the cache, then render, tap to
/// open the file preview.
private struct WorkspaceMarkdownImage: View {
    let client: ArgusClient?
    let project: ProjectRef
    let path: String
    let epoch: String
    let onOpen: @MainActor (String) -> Void

    /// The outcome this view loaded, tagged with the key it belongs to
    /// so an epoch flip (live → completed) can't keep showing the old
    /// key's result while the new read is in flight.
    @State private var loaded: (key: String, value: MarkdownImageCache.Settled)?

    private var key: String {
        MarkdownImageCache.key(projectId: project.projectId, path: path, epoch: epoch)
    }

    var body: some View {
        // The synchronous cache read is what keeps a re-created view
        // (MarkdownUI rebuilds per parse) from flashing the placeholder.
        let current = (loaded?.key == key ? loaded?.value : nil)
            ?? MarkdownImageCache.shared.cached(key)
        Group {
            switch current {
            case .none:
                ImageLoadingPlaceholder(text: path)
            case .ready(let image):
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .modifier(MarkdownImageStyle(intrinsic: image.size))
                    .contentShape(Rectangle())
                    .onTapGesture {
                        // Gesture callbacks arrive on the main thread on
                        // every SDK; asserting the actor here keeps the
                        // call legal whether or not this closure is
                        // typed as MainActor by the toolchain in use.
                        MainActor.assumeIsolated { onOpen(path) }
                    }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint("Opens the file preview")
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .error(let message):
                InertImageLabel(text: path, detail: message)
            }
        }
        .task(id: key) {
            if let hit = MarkdownImageCache.shared.cached(key) {
                loaded = (key, hit)
                return
            }
            guard let client else {
                loaded = (key, .error("not connected"))
                return
            }
            let value = await MarkdownImageCache.shared.load(
                client: client, projectId: project.projectId, path: path, epoch: epoch
            )
            loaded = (key, value)
        }
    }
}

/// A real http(s) URL — the system loads it, like the web leaves it to
/// the browser. No intrinsic size is exposed by AsyncImage, so unlike
/// workspace images these can upscale to the column; acceptable for the
/// large images models actually link.
private struct RemoteMarkdownImage: View {
    let url: URL

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFit()
                    .modifier(MarkdownImageStyle(intrinsic: nil))
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .failure:
                InertImageLabel(text: url.absoluteString)
            case .empty:
                ImageLoadingPlaceholder(text: url.host ?? url.absoluteString)
            @unknown default:
                InertImageLabel(text: url.absoluteString)
            }
        }
    }
}

/// Web parity for the `<img>` box: never wider than the column, never
/// taller than 420pt, and never upscaled past the bitmap's own size
/// (`max-w-full max-h-[420px]` semantics); rounded with the same border
/// the html/mermaid blocks use. Callers add the leading-aligned
/// full-width frame AFTER any tap target, so the hit area is the image
/// and not the empty row beside it.
private struct MarkdownImageStyle: ViewModifier {
    /// Bitmap size in points, when known. nil = no upscale guard.
    let intrinsic: CGSize?

    private static let maxHeight: CGFloat = 420

    func body(content: Content) -> some View {
        content
            .frame(
                maxWidth: intrinsic?.width,
                maxHeight: min(intrinsic?.height ?? Self.maxHeight, Self.maxHeight)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(.separator)))
    }
}

/// The fallback for an image we can't or won't fetch: outside the
/// workspace, no project, a non-http scheme, or a read that failed.
/// Deliberately inert — no tap target — and styled like the transcript's
/// other dimmed file references, so the reader still sees WHAT the agent
/// meant to show and where it put it. The photo glyph stands in for the
/// web's hover tooltip: on a phone it's the only cue this was an image.
struct InertImageLabel: View {
    let text: String
    var detail: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "photo")
                .font(.caption2)
            Text(text)
                .font(.system(size: 13, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
            if let detail {
                Text("— \(detail)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ImageLoadingPlaceholder: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text)
                .font(.system(size: 12, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(Color(.separator), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
