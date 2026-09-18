import SwiftUI
import WebKit

/// A ```mermaid fenced block: rendered as a diagram by default, with a
/// Source toggle — the iOS counterpart of the web's `MermaidBlock`.
///
/// The diagram is drawn by the vendored `mermaid.min.js` (Resources/,
/// same version the web app bundles — see `MermaidLockstepTests`)
/// inside a WKWebView, loaded from the app bundle rather than a CDN so
/// air-gapped servers and offline phones still get diagrams. A source
/// that doesn't parse falls back to the plain code block with no error
/// state, matching the web and the way unparseable LaTeX renders as
/// visible source instead of failing. `AnswerView` only routes here
/// once the turn has settled, so the source is final by the time it
/// arrives — there is no streaming churn to debounce.
struct MermaidBlock: View {
    let source: String

    @State private var showSource = false
    @State private var height: CGFloat = 48
    @State private var failed = false

    private var trimmed: String {
        var text = source
        while text.hasSuffix("\n") { text.removeLast() }
        return text
    }

    var body: some View {
        if failed {
            CodeBlock(code: trimmed, language: "mermaid")
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Spacer()
                    Button {
                        showSource.toggle()
                    } label: {
                        Label(showSource ? "Preview" : "Source",
                              systemImage: showSource ? "eye" : "chevron.left.forwardslash.chevron.right")
                            .labelStyle(.titleAndIcon)
                            .font(.caption2)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    CopyButton(text: trimmed)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                Divider()

                if showSource {
                    CodeBlock(code: trimmed, language: "mermaid")
                        .padding(8)
                } else {
                    MermaidWebView(source: trimmed, height: $height, failed: $failed)
                        .frame(height: max(48, height))
                }
            }
            .background(Color.surface0)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(.separator)))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// WKWebView host for a mermaid diagram. Loads the bundled
/// `mermaid.html` once (a file:// page that pulls in the vendored
/// runtime next to it), then pushes the source and theme in through
/// `window.argusRender` — a theme flip redraws the diagram without
/// re-parsing the 3 MB script. Height and parse failures come back over
/// the `argusMermaid` message handler; every navigation but the initial
/// file load is cancelled, so nothing in a diagram can lead anywhere.
struct MermaidWebView: UIViewRepresentable {
    let source: String
    @Binding var height: CGFloat
    @Binding var failed: Bool
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator(height: $height, failed: $failed) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "argusMermaid")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.setContentHuggingPriority(.defaultLow, for: .vertical)
        context.coordinator.webView = webView

        if let page = Bundle.main.url(forResource: "mermaid", withExtension: "html") {
            // Read access scoped to the page's directory: that's where the
            // `<script src="mermaid.min.js">` relative load resolves.
            webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        } else {
            // Bundle is missing the runtime (Resources not copied) — degrade
            // to source. Deferred: flipping state inside makeUIView is a
            // state-during-update violation. Coordinator is @MainActor,
            // hence Sendable, so capturing it into the Task is clean.
            let coordinator = context.coordinator
            Task { @MainActor in coordinator.markFailed() }
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.render(source: source, dark: colorScheme == .dark)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "argusMermaid")
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?
        private let height: Binding<CGFloat>
        private let failed: Binding<Bool>
        private var ready = false
        private var lastKey = ""
        /// Render requested before the page reported `ready`; flushed
        /// the moment it does.
        private var pending: (source: String, dark: Bool)?

        init(height: Binding<CGFloat>, failed: Binding<Bool>) {
            self.height = height
            self.failed = failed
        }

        func render(source: String, dark: Bool) {
            let key = "\(dark)\n\(source)"
            guard key != lastKey else { return }
            lastKey = key
            pending = (source, dark)
            flush()
        }

        func markFailed() {
            if !failed.wrappedValue { failed.wrappedValue = true }
        }

        private func flush() {
            guard ready, let webView, let request = pending else { return }
            pending = nil
            // JSON-encode the source so it lands in the page as one string
            // literal regardless of quotes/newlines/backslashes in the
            // diagram text.
            guard let data = try? JSONEncoder().encode(request.source),
                  let literal = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript(
                "window.argusRender(\(literal), \(request.dark))",
                completionHandler: nil
            )
        }

        // `nonisolated` witness + assumeIsolated, NOT a @preconcurrency
        // conformance — same reasoning as HtmlWebView.Coordinator: the
        // protocol's isolation differs between SDK versions and this form
        // satisfies both. WebKit delivers script messages on the main
        // thread, so assuming the actor is sound.
        nonisolated func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            MainActor.assumeIsolated {
                guard let body = message.body as? [String: Any],
                      let kind = body["kind"] as? String else { return }
                switch kind {
                case "ready":
                    ready = true
                    flush()
                case "height":
                    guard let value = body["value"] as? NSNumber else { return }
                    let next = CGFloat(truncating: value)
                    // ResizeObserver feedback-loop guard (web parity).
                    if abs(height.wrappedValue - next) > 1, next > 0 {
                        height.wrappedValue = next
                    }
                case "invalid":
                    markFailed()
                default:
                    break
                }
            }
        }

        /// Allow only the initial file load; a diagram can't navigate the
        /// frame anywhere. The async form, deliberately — see
        /// StaticHtmlView for why the handler-based signature is a trap.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            navigationAction.navigationType == .other ? .allow : .cancel
        }
    }
}
