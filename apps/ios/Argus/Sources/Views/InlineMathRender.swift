import SwiftUI
import UIKit
import SwiftMath
import ArgusKit

/// A plain paragraph carrying inline `$…$` math, assembled by hand:
/// MarkdownUI can't host views inside its Text runs, so the paragraph
/// becomes concatenated `Text` fragments — markdown-styled prose runs
/// interleaved with SwiftMath-rendered images that sit ON the text
/// baseline (`.baselineOffset(-descent)`, so `$\pi_\theta$`'s tail
/// descends below the line like real typography). Concatenated Text
/// wraps as one paragraph and stays selectable.
///
/// Trade: inside THIS paragraph, inline styling comes from
/// `AttributedString(markdown:)` + a small theming pass (code accent,
/// link color) instead of MarkdownUI's theme — keep the two visually
/// aligned when touching either. Spans SwiftMath can't parse (after
/// MathCompat) fall back to their raw `$…$` source per-span.
struct InlineMathParagraph: View {
    let text: String

    var body: some View {
        InlineMathText(text: text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12) // web p my-3
    }
}

/// A flat list whose items carry inline math: marker + assembled-Text
/// rows, mirroring the MarkdownUI theme's plain "•"/"n." markers.
struct InlineMathList: View {
    let items: [MathListItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(items.indices, id: \.self) { index in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    marker(items[index].marker)
                    InlineMathText(text: items[index].text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, 12) // web ul/ol my-3
    }

    private func marker(_ token: String) -> Text {
        if token == "-" || token == "*" || token == "+" {
            return Text("•").foregroundColor(.secondary)
        }
        // Normalize "3)" to the theme's "3." style.
        let label = token.hasSuffix(")") ? String(token.dropLast()) + "." : token
        return Text(label).monospacedDigit().foregroundColor(.secondary)
    }
}

/// The Text-assembly core shared by paragraph and list-item rendering.
struct InlineMathText: View {
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        assembled
            .font(.system(size: 15)) // MarkdownUI body FontSize(15)
    }

    private var assembled: Text {
        let dark = colorScheme == .dark
        var out = Text(verbatim: "")
        for run in InlineMath.runs(text) {
            switch run {
            case .text(let fragment):
                out = out + Text(inlineMarkdown(fragment))
            case .math(let latex):
                let compat = MathCompat.swiftMathLatex(latex)
                if let math = MathImageRenderer.shared.inlineImage(latex: compat, dark: dark) {
                    out = out + Text(Image(uiImage: math.image)).baselineOffset(-math.descent)
                } else {
                    out = out + Text(verbatim: "$\(latex)$")
                }
            }
        }
        return out
    }

    /// Inline-only markdown (bold/italic/code/links) with the app's
    /// transcript accents. Bold/italic render from presentation intents
    /// on their own; code and links need explicit color.
    private func inlineMarkdown(_ fragment: String) -> AttributedString {
        guard var attr = try? AttributedString(
            markdown: fragment,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return AttributedString(fragment) }
        // Snapshot ranges before mutating — attribute writes can
        // re-coalesce the runs view mid-iteration.
        let styled = attr.runs.map { ($0.range, $0.inlinePresentationIntent, $0.link) }
        for (range, intent, link) in styled {
            if let intent, intent.contains(.code) {
                attr[range].font = .system(size: 12.75, design: .monospaced) // 0.85em
                attr[range].foregroundColor = .codeInlineFg
                attr[range].backgroundColor = Color.surface2.opacity(0.5)
            }
            if link != nil {
                attr[range].foregroundColor = .mdLink
            }
        }
        return attr
    }
}

/// Renders one inline formula to a baseline-annotated image via
/// MTMathUILabel, cached per (latex, appearance) — failures cache too,
/// so a bad span doesn't re-parse on every streaming re-render.
@MainActor
final class MathImageRenderer {
    static let shared = MathImageRenderer()

    struct Rendered {
        let image: UIImage
        /// Ink below the baseline, in points — the Text baselineOffset.
        let descent: CGFloat
    }

    private struct Key: Hashable {
        let latex: String
        let dark: Bool
    }

    private var cache: [Key: Rendered?] = [:]

    func inlineImage(latex: String, dark: Bool) -> Rendered? {
        let key = Key(latex: latex, dark: dark)
        if let hit = cache[key] { return hit }
        let rendered = render(latex: latex, dark: dark)
        // Crude cap: transcripts are bounded, distinct formulas rarely
        // exceed this; wholesale reset beats LRU bookkeeping here.
        if cache.count > 400 { cache.removeAll() }
        cache[key] = rendered
        return rendered
    }

    private func render(latex: String, dark: Bool) -> Rendered? {
        let label = MTMathUILabel()
        label.labelMode = .text // inline (\textstyle), not display
        label.fontSize = 15 // match the surrounding body text
        // Web .markdown fg-primary: 9% white light / 96% dark. Explicit
        // per-appearance color — the CoreText draw won't re-resolve a
        // dynamic UIColor, hence the `dark` cache key.
        label.textColor = UIColor(white: dark ? 0.96 : 0.09, alpha: 1)
        label.latex = latex
        guard label.error == nil else { return nil }

        // First layout obtains the ink metrics…
        label.frame = CGRect(origin: .zero, size: label.intrinsicContentSize)
        label.layoutSubviews()
        guard let ink = label.displayList, ink.width > 0 else { return nil }
        // …then re-layout at the height _layoutSubviews clamps to
        // (max(ink, fontSize/2)): with bounds.height equal to that, its
        // vertical centering puts the baseline exactly `descent` above
        // the image bottom — which is what baselineOffset needs.
        let size = CGSize(
            width: ceil(ink.width),
            height: ceil(max(ink.ascent + ink.descent, label.fontSize / 2))
        )
        label.frame = CGRect(origin: .zero, size: size)
        label.layoutSubviews()
        guard let display = label.displayList else { return nil }

        let format = UIGraphicsImageRendererFormat()
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let cg = ctx.cgContext
            cg.saveGState()
            // Math draws in y-up coordinates (on screen the label's
            // layer.isGeometryFlipped compensates) — flip for UIKit.
            cg.scaleBy(x: 1, y: -1)
            cg.translateBy(x: 0, y: -size.height)
            display.draw(cg)
            cg.restoreGState()
        }
        return Rendered(image: image, descent: display.descent)
    }
}
