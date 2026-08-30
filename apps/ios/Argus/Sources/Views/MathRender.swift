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
///
/// Horizontal braces are the one construct we draw ourselves. SwiftMath
/// 1.7.3 has no extensible `\underbrace` glyph, so `MathCompat` can only
/// degrade it to an `\underline` rule — which reads as a stray line under
/// the formula. Instead `MathCompat.displaySegments` splits the equation
/// at top-level braces and `BracedEquation` re-assembles it with a real
/// brace drawn in SwiftUI. Braces nested inside another construct can't be
/// sliced out (both halves would stop parsing), so those keep the rule.
struct MathBlock: View {
    let latex: String

    var body: some View {
        // MathCompat maps the models' KaTeX-isms (`\big[`, `\operatorname`)
        // into SwiftMath's subset; the fallback shows the ORIGINAL
        // source — what the model wrote, not our rewrite.
        let compat = MathCompat.swiftMathLatex(latex)
        if let segments = MathCompat.displaySegments(latex), canRender(segments) {
            ScrollView(.horizontal, showsIndicators: false) {
                BracedEquation(segments: segments)
            }
            .padding(.vertical, 12) // web .katex-display my-3
        } else if MTMathListBuilder.build(fromString: compat) != nil {
            ScrollView(.horizontal, showsIndicators: false) {
                MathLabel(latex: compat)
            }
            .padding(.vertical, 12)
        } else {
            CodeBlock(code: latex, language: "latex")
                .padding(.vertical, 12)
        }
    }

    /// Every piece has to parse on its own before we split an equation into
    /// separate views: a brace sitting beside an unsupported `\boxed` would
    /// otherwise render half the formula and silently drop the rest. All-or-
    /// nothing keeps the raw-source fallback honest.
    private func canRender(_ segments: [MathCompat.DisplaySegment]) -> Bool {
        segments.allSatisfy { segment in
            switch segment {
            case .latex(let source):
                return parses(source)
            case .brace(let base, let label, _):
                return parses(base) && (label.map(parses) ?? true)
            }
        }
    }

    private func parses(_ source: String) -> Bool {
        // A whitespace-only run between two braces is fine — it just renders
        // as nothing; only real content has to survive the parser.
        guard !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
        return MTMathListBuilder.build(fromString: MathCompat.swiftMathLatex(source)) != nil
    }
}

private enum MathTypography {
    /// Body text is 15pt; math slightly larger for glyph legibility,
    /// echoing KaTeX's 1.21em ratio on the web.
    static let display: CGFloat = 17
    /// Brace labels ride at roughly KaTeX's scriptstyle.
    static let annotation: CGFloat = 12
    static let braceHeight: CGFloat = 5
    static let braceLineWidth: CGFloat = 1
    static let gap: CGFloat = 2
}

/// Aligns every segment of an equation on the shared math baseline —
/// `.center` would let a brace's label shove its own segment upward.
private extension VerticalAlignment {
    enum MathBaselineID: AlignmentID {
        static func defaultValue(in context: ViewDimensions) -> CGFloat { context[.bottom] }
    }
    static let mathBaseline = VerticalAlignment(MathBaselineID.self)
}

/// An equation carrying at least one top-level brace, re-assembled from
/// SwiftMath runs plus natively drawn braces.
private struct BracedEquation: View {
    let segments: [MathCompat.DisplaySegment]

    var body: some View {
        HStack(alignment: .mathBaseline, spacing: 0) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .latex(let source):
                    MathRun(latex: source)
                case .brace(let base, let label, let under):
                    BracedGroup(base: base, label: label, under: under)
                }
            }
        }
    }
}

/// A plain stretch of LaTeX between braces, pinned to the shared baseline.
private struct MathRun: View {
    let latex: String

    var body: some View {
        let compat = MathCompat.swiftMathLatex(latex)
        // Resolved here rather than inside the guide closure: `body` is
        // main-actor isolated, the closure isn't.
        let baseline = MathMetrics.metrics(latex: compat, fontSize: MathTypography.display).baseline
        MathLabel(latex: compat)
            .alignmentGuide(.mathBaseline) { _ in baseline }
    }
}

/// A base expression with a drawn brace and its label stacked under (or
/// over) it. The whole group hangs off the *base's* baseline, so the label
/// dangles below the line like KaTeX's rather than shifting the equation.
private struct BracedGroup: View {
    let base: String
    let label: String?
    let under: Bool

    var body: some View {
        let baseLatex = MathCompat.swiftMathLatex(base)
        let baseMetrics = MathMetrics.metrics(latex: baseLatex, fontSize: MathTypography.display)
        let labelLatex = annotationLatex
        let labelHeight = labelLatex.map {
            MathMetrics.metrics(latex: $0, fontSize: MathTypography.annotation).height
        } ?? 0
        // Everything the brace adds on the annotated side of the base.
        let decoration = MathTypography.gap + MathTypography.braceHeight
            + (labelHeight > 0 ? MathTypography.gap + labelHeight : 0)

        VStack(spacing: 0) {
            if under {
                MathLabel(latex: baseLatex)
                decorations(labelLatex: labelLatex, width: baseMetrics.width)
            } else {
                decorations(labelLatex: labelLatex, width: baseMetrics.width)
                MathLabel(latex: baseLatex)
            }
        }
        .alignmentGuide(.mathBaseline) { _ in
            under ? baseMetrics.baseline : decoration + baseMetrics.baseline
        }
    }

    private var annotationLatex: String? {
        guard let label, !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return MathCompat.swiftMathLatex(label)
    }

    /// Brace + label, ordered outward from the base.
    @ViewBuilder
    private func decorations(labelLatex: String?, width: CGFloat) -> some View {
        VStack(spacing: 0) {
            if under {
                brace(width: width)
                annotation(labelLatex)
            } else {
                annotation(labelLatex)
                brace(width: width)
            }
        }
    }

    @ViewBuilder
    private func brace(width: CGFloat) -> some View {
        HorizontalBrace(under: under)
            .stroke(
                style: StrokeStyle(
                    lineWidth: MathTypography.braceLineWidth, lineCap: .round, lineJoin: .round
                )
            )
            .foregroundStyle(Color.mathInk)
            // Spans exactly the base, not the (possibly wider) label.
            .frame(width: max(width, 1), height: MathTypography.braceHeight)
            .padding(.top, under ? MathTypography.gap : 0)
            .padding(.bottom, under ? 0 : MathTypography.gap)
    }

    @ViewBuilder
    private func annotation(_ labelLatex: String?) -> some View {
        if let labelLatex {
            MathLabel(latex: labelLatex, fontSize: MathTypography.annotation)
                .padding(.top, under ? MathTypography.gap : 0)
                .padding(.bottom, under ? 0 : MathTypography.gap)
        }
    }
}

/// A horizontal curly brace — the glyph SwiftMath's TeX subset lacks.
/// Drawn parametrically rather than by stretching a character, so the
/// stroke keeps a constant weight however wide the base gets.
private struct HorizontalBrace: Shape {
    /// true → underbrace: ends touch the base above, tip points down.
    let under: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let width = rect.width
        let height = rect.height
        guard width > 0, height > 0 else { return path }
        let mid = width / 2
        let shoulder = height / 2
        // Never more than a quarter of each half, so narrow braces round off
        // instead of self-intersecting.
        let radius = min(shoulder, mid / 2)

        // `y` is depth away from the base edge; flip it for an overbrace.
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x, y: under ? rect.minY + y : rect.maxY - y)
        }

        path.move(to: point(0, 0))
        path.addQuadCurve(to: point(radius, shoulder), control: point(0, shoulder))
        path.addLine(to: point(mid - radius, shoulder))
        path.addQuadCurve(to: point(mid, height), control: point(mid, shoulder))
        path.addQuadCurve(to: point(mid + radius, shoulder), control: point(mid, shoulder))
        path.addLine(to: point(width - radius, shoulder))
        path.addQuadCurve(to: point(width, 0), control: point(width, shoulder))
        return path
    }
}

/// Ink metrics for a laid-out equation, cached per (latex, size).
///
/// The baseline formula mirrors `MTMathUILabel._layoutSubviews`, *including*
/// its clamp of the display height to half the font size — with zero content
/// insets the baseline is normally just `ascent` below the top, but short
/// content trips the clamp and shifts it. Guessing here would misalign
/// segments by a point or two in exactly the cases hardest to eyeball.
@MainActor
private enum MathMetrics {
    struct Metrics: Equatable {
        let width: CGFloat
        /// Intrinsic height: ascent + descent.
        let height: CGFloat
        /// Distance from the view's top edge down to the baseline.
        let baseline: CGFloat
    }

    private struct Key: Hashable {
        let latex: String
        let fontSize: CGFloat
    }

    private static var cache: [Key: Metrics] = [:]

    static func metrics(latex: String, fontSize: CGFloat) -> Metrics {
        let key = Key(latex: latex, fontSize: fontSize)
        if let hit = cache[key] { return hit }

        var result = Metrics(width: 0, height: fontSize, baseline: fontSize)
        let label = MTMathUILabel()
        label.labelMode = .display
        label.fontSize = fontSize
        label.latex = latex
        if label.error == nil {
            label.frame = CGRect(origin: .zero, size: label.intrinsicContentSize)
            label.layoutSubviews()
            if let ink = label.displayList {
                let height = ink.ascent + ink.descent
                let clamped = max(height, fontSize / 2)
                result = Metrics(
                    width: ink.width,
                    height: height,
                    baseline: (height + clamped) / 2 - ink.descent
                )
            }
        }
        // Same crude cap as MathImageRenderer: transcripts are bounded and a
        // wholesale reset beats LRU bookkeeping.
        if cache.count > 400 { cache.removeAll() }
        cache[key] = result
        return result
    }
}

private extension Color {
    /// Web's .markdown fg-primary: 9% white light / 96% dark.
    static let mathInk = Color(uiColor: UIColor { traits in
        UIColor(white: traits.userInterfaceStyle == .dark ? 0.96 : 0.09, alpha: 1)
    })
}

/// MTMathUILabel bridged into SwiftUI, sized to the equation.
private struct MathLabel: UIViewRepresentable {
    let latex: String
    var fontSize: CGFloat = MathTypography.display

    // Read so updateUIView re-runs on theme flips — MTMathUILabel draws
    // via CoreText and won't re-resolve a dynamic UIColor on its own.
    @Environment(\.colorScheme) private var colorScheme

    func makeUIView(context: Context) -> MTMathUILabel {
        let label = MTMathUILabel()
        label.labelMode = .display
        return label
    }

    func updateUIView(_ label: MTMathUILabel, context: Context) {
        label.fontSize = fontSize
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
