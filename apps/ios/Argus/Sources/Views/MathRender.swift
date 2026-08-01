import SwiftUI
import SwiftMath
import ArgusKit

/// A `$$…$$` display-math block — the native counterpart of the web's
/// KaTeX `.katex-display`. SwiftMath lays the equation out with
/// CoreText (no webview, no streaming thrash), wide equations scroll
/// sideways like CodeBlock, and LaTeX outside SwiftMath's TeX subset
/// (KaTeX on the web covers more — e.g. \begin{align}) falls back to
/// the raw source in a code block: visible, copyable, honest about the
/// per-client gap.
struct MathBlock: View {
    let latex: String

    var body: some View {
        // MathCompat maps Claude's KaTeX-isms (`\big[`, `\operatorname`)
        // into SwiftMath's subset; the fallback shows the ORIGINAL
        // source — what the model wrote, not our rewrite.
        let compat = MathCompat.swiftMathLatex(latex)
        if MTMathListBuilder.build(fromString: compat) != nil {
            ScrollView(.horizontal, showsIndicators: false) {
                MathLabel(latex: compat)
            }
            .padding(.vertical, 12) // web .katex-display my-3
        } else {
            CodeBlock(code: latex, language: "latex")
                .padding(.vertical, 12)
        }
    }
}

/// MTMathUILabel bridged into SwiftUI, sized to the equation.
private struct MathLabel: UIViewRepresentable {
    let latex: String

    /// Body text is 15pt; math slightly larger for glyph legibility,
    /// echoing KaTeX's 1.21em ratio on the web.
    private static let fontSize: CGFloat = 17

    // Read so updateUIView re-runs on theme flips — MTMathUILabel draws
    // via CoreText and won't re-resolve a dynamic UIColor on its own.
    @Environment(\.colorScheme) private var colorScheme

    func makeUIView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.labelMode = .display
        label.fontSize = Self.fontSize
        return label
    }

    func updateUIView(_ label: MTMathUILabel, context: Context) {
        label.latex = latex
        // Web's .markdown fg-primary: 9% white light / 96% dark.
        label.textColor = UIColor(white: colorScheme == .dark ? 0.96 : 0.09, alpha: 1)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize, uiView: MTMathUILabel, context: Context
    ) -> CGSize? {
        uiView.intrinsicContentSize
    }
}
