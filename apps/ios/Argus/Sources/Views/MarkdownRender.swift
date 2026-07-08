import SwiftUI
import WebKit
import ArgusKit
import MarkdownUI

/// The assistant's final answer — Markdown themed to match the web's
/// `.markdown` body: inline-code accent, sky links, and a custom fenced
/// code block that routes ```html to a live preview and everything else
/// to a styled monospace block with a copy button. Matches the web
/// deliberately: the transcript does NOT syntax-highlight code (that's
/// the file viewer's job).
struct AnswerView: View {
    let markdown: String
    /// While the turn streams, MarkdownUI re-parses per token — render
    /// ```html as source until it settles so we don't thrash WKWebViews.
    var isStreaming = false

    var body: some View {
        Markdown(markdown)
            // Body ≈ web's text-sm (14px); a touch larger for mobile.
            .markdownTextStyle(\.text) {
                FontSize(15)
            }
            .markdownTextStyle(\.code) {
                FontFamilyVariant(.monospaced)
                FontSize(.em(0.85))
                ForegroundColor(.codeInlineFg)
                BackgroundColor(.surface2.opacity(0.5))
            }
            .markdownTextStyle(\.link) {
                ForegroundColor(.mdLink)
            }
            // Web uses font-bold for strong; MarkdownUI defaults to semibold.
            .markdownTextStyle(\.strong) {
                FontWeight(.bold)
            }
            // Tight list markers — plain "•"/"1." instead of the SF
            // circle.fill symbol whose built-in padding over-indents the
            // list vs the web's compact pl-5 bullets.
            .markdownBlockStyle(\.bulletedListMarker) { _ in
                Text("•").foregroundStyle(.secondary)
            }
            .markdownBlockStyle(\.numberedListMarker) { configuration in
                Text("\(configuration.itemNumber).")
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            // Dimmed border (web `border-default`) + subtle zebra rows,
            // instead of MarkdownUI's heavier default table border.
            .markdownBlockStyle(\.table) { configuration in
                configuration.label
                    .fixedSize(horizontal: false, vertical: true)
                    .markdownTableBorderStyle(.init(color: Color(light: 0xE8E8E8, dark: 0x1F1F1F)))
                    .markdownTableBackgroundStyle(
                        .alternatingRows(Color.clear, Color.surface1.opacity(0.3))
                    )
                    .markdownMargin(top: 12, bottom: 12) // web my-3
            }
            .markdownBlockStyle(\.tableCell) { configuration in
                configuration.label
                    .markdownTextStyle {
                        if configuration.row == 0 { FontWeight(.semibold) }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 12)
            }
            // Block margins mirror the web's .markdown CSS (markdownMargin
            // collapses adjacent margins like CSS, so gaps match exactly):
            // p/ul/ol/table my-3 (12), pre my-4 (16), headings mt-5 mb-2.
            .markdownBlockStyle(\.paragraph) { $0.label.markdownMargin(top: 12, bottom: 12) }
            .markdownBlockStyle(\.list) { $0.label.markdownMargin(top: 12, bottom: 12) }
            // The web's .markdown headings have NO font-size — they're
            // just semibold at body size. Mirror that with a very modest
            // hierarchy instead of MarkdownUI's large defaults.
            .markdownBlockStyle(\.heading1) { heading($0, size: 18) }
            .markdownBlockStyle(\.heading2) { heading($0, size: 16) }
            .markdownBlockStyle(\.heading3) { heading($0, size: 15) }
            .markdownBlockStyle(\.heading4) { heading($0, size: 15, top: 16) }
            .markdownBlockStyle(\.codeBlock) { configuration in
                Group {
                    if configuration.language?.lowercased() == "html", !isStreaming {
                        HtmlBlock(source: configuration.content)
                    } else {
                        CodeBlock(code: configuration.content, language: configuration.language)
                    }
                }
                .markdownMargin(top: 16, bottom: 16) // web pre my-4
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func heading(_ configuration: BlockConfiguration, size: CGFloat, top: CGFloat = 20) -> some View {
        configuration.label
            .markdownTextStyle {
                FontWeight(.semibold)
                FontSize(size)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .markdownMargin(top: top, bottom: 8) // web mt-5 mb-2
    }
}

/// A fenced code block: horizontally-scrolling monospace on a layered
/// surface, with a copy affordance (always visible — no hover on iOS).
struct CodeBlock: View {
    let code: String
    var language: String?

    private var trimmed: String {
        var text = code
        while text.hasSuffix("\n") { text.removeLast() }
        return text
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(trimmed)
                .font(.system(size: 13, design: .monospaced)) // web pre = text-sm
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .frame(minWidth: 0, alignment: .leading)
        }
        .background(Color.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .topTrailing) {
            CopyButton(text: trimmed).padding(6)
        }
    }
}

/// A ```html fenced block: rendered in a sandboxed WKWebView by default,
/// with a Source toggle — the iOS counterpart of the web's HtmlPreview
/// chat path (allow-scripts, opaque origin, self-measured height).
struct HtmlBlock: View {
    let source: String

    @State private var showSource = false
    @State private var height: CGFloat = 48

    private var trimmed: String {
        var text = source
        while text.hasSuffix("\n") { text.removeLast() }
        return text
    }

    var body: some View {
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
                CodeBlock(code: trimmed, language: "html")
                    .padding(8)
            } else {
                HtmlWebView(html: trimmed, height: $height)
                    .frame(height: max(48, height))
            }
        }
        .background(Color.surface0)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(.separator)))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

/// WKWebView host for a fenced HTML block. Scripts run (CDN chart libs
/// etc.) but the frame is an isolated about:blank origin — it can't
/// reach the app. Height is measured inside the page and posted back via
/// a `argusHeight` message handler; loads are content-hash-deduped and
/// debounced so streaming token churn doesn't thrash the web view.
struct HtmlWebView: UIViewRepresentable {
    let html: String
    @Binding var height: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "argusHeight")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.setContentHuggingPriority(.defaultLow, for: .vertical)
        context.coordinator.webView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.load(html: html, dark: colorScheme == .dark)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "argusHeight")
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?
        private let height: Binding<CGFloat>
        private var lastKey = ""
        private var pending: DispatchWorkItem?

        init(height: Binding<CGFloat>) {
            self.height = height
        }

        func load(html: String, dark: Bool) {
            let key = "\(dark)\n\(html)"
            guard key != lastKey else { return }
            lastKey = key
            // Debounce: a streaming answer rewrites this block per token;
            // collapse the churn into one reload once it settles.
            pending?.cancel()
            let doc = Self.prepareDocument(html, dark: dark)
            let work = DispatchWorkItem { [weak self] in
                self?.webView?.loadHTMLString(doc, baseURL: nil)
            }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
        }

        nonisolated func userContentController(
            _ controller: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let value = message.body as? NSNumber else { return }
            let next = CGFloat(truncating: value)
            Task { @MainActor in
                // ResizeObserver feedback-loop guard (web parity).
                if abs(self.height.wrappedValue - next) > 1, next > 0 {
                    self.height.wrappedValue = next
                }
            }
        }

        /// Inject a color-scheme hint + a self-measuring height reporter,
        /// mirroring the web's prepareDocument / HEIGHT_BOOTSTRAP.
        static func prepareDocument(_ content: String, dark: Bool) -> String {
            // Unlike a browser iframe (which lays out at its own element
            // width), WKWebView defaults to a 980px "desktop" viewport for
            // pages with no viewport meta, then scales the canvas down to
            // the view width. That inflates scrollHeight by 1/scale — mild
            // on a wide iPad, huge on a narrow iPhone. Pin the layout to the
            // device width so the measured height matches what's rendered.
            let head = """
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>:root{color-scheme:\(dark ? "dark" : "light")}</style>
            <script>
            (function(){
              function post(){
                var d=document;
                var h=Math.max(d.documentElement?d.documentElement.scrollHeight:0,
                               d.body?d.body.scrollHeight:0);
                if(h>0 && window.webkit && window.webkit.messageHandlers
                   && window.webkit.messageHandlers.argusHeight){
                  window.webkit.messageHandlers.argusHeight.postMessage(h);
                }
              }
              try{ if(typeof ResizeObserver!=='undefined' && document.documentElement){
                new ResizeObserver(post).observe(document.documentElement);} }catch(e){}
              window.addEventListener('load', post);
              document.addEventListener('DOMContentLoaded', post);
              post();
            })();
            </script>
            """
            if let range = content.range(of: "<head", options: .caseInsensitive),
               let close = content.range(of: ">", range: range.upperBound..<content.endIndex) {
                return content.replacingCharacters(
                    in: close.upperBound..<close.upperBound, with: head
                )
            }
            if let range = content.range(of: "<html", options: .caseInsensitive),
               let close = content.range(of: ">", range: range.upperBound..<content.endIndex) {
                return content.replacingCharacters(
                    in: close.upperBound..<close.upperBound, with: "<head>\(head)</head>"
                )
            }
            return "<!DOCTYPE html><html><head>\(head)</head><body>\(content)</body></html>"
        }
    }
}

/// Small copy-to-clipboard button that flips to a check for ~1.5s.
struct CopyButton: View {
    let text: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.caption2)
                .foregroundStyle(copied ? .green : .secondary)
                .frame(width: 26, height: 26)
                .background(Color.surface2.opacity(0.7), in: RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
    }
}
